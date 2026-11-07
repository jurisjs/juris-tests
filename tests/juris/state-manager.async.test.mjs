// state-manager.js, async values: settle (plain, settled and promised values), the counters under
// the async root (pending, slow, started, settled), pendingDelay, superseded and disposed runs, the
// error log (recordError, errorMessage, MAX_ERROR_LOG), epochs (clearState's resetAsync), and a
// computed whose resolver answers a promise. Timers are node:test's mock timers.
import { test } from "node:test";
import assert from "node:assert/strict";
import StateManager, { settled, settledError, MAX_ERROR_LOG } from "juris/state-manager.js";

// Lets every queued promise callback run.
const flush = () => new Promise((resolve) => setImmediate(resolve));

// A promise and the functions that settle it.
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

// A binding as settle takes one, recording its hooks: onPending, onSlow, onError (with its `this`).
function binding() {
    const calls = { pending: [], slow: [], errors: [] };
    const value = {
        version: 0,
        pending: false,
        disposed: false,
        calls,
        onPending: (flag) => calls.pending.push(flag),
        onSlow: (flag) => calls.slow.push(flag),
        onError(error) {
            calls.errors.push([this, error]);
        },
    };
    return value;
}

// Settles `value` as the binding's next run; answers what apply was given.
function run(sm, target, value) {
    const applied = [];
    const version = ++target.version;
    sm.settle(target, version, value, (result) => applied.push(result));
    return applied;
}

// ---- plain and settled values ------------------------------------------------------------------

test("settle applies a plain value at once and touches no counter", () => {
    const sm = new StateManager();
    const target = binding();
    assert.deepEqual(run(sm, target, 5), [5]);
    assert.equal(sm.peek("$async"), undefined);
    assert.deepEqual(target.calls.pending, [], "it was not pending, so nothing ends");
});

test("settle applies a settled value's value at once, a nested one included, without counting", () => {
    const sm = new StateManager();
    const target = binding();
    assert.deepEqual(run(sm, target, settled(4)), [4]);
    assert.deepEqual(run(sm, target, settled(settled("deep"))), ["deep"]);
    assert.equal(sm.peek("$async"), undefined);
});

test("settle logs a settled error and hands it to onError, called on the binding", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1234 });
    const sm = new StateManager();
    const target = binding();
    const error = new Error("preloaded failure");
    assert.deepEqual(run(sm, target, settledError(error)), []);
    assert.deepEqual(sm.peek("$async.errors"), [{ message: "preloaded failure", at: 1234 }]);
    assert.equal(target.calls.errors.length, 1);
    assert.equal(target.calls.errors[0][0], target);
    assert.equal(target.calls.errors[0][1], error);
});

test("settle takes a binding with no hooks", async () => {
    const sm = new StateManager({}, { pendingDelay: 0 });
    const bare = { version: 1, pending: false, disposed: false };
    sm.settle(bare, 1, settledError(new Error("no hook")), () => { });
    const { promise, resolve } = deferred();
    const applied = [];
    sm.settle(bare, 1, promise, (value) => applied.push(value));
    resolve("done");
    await flush();
    assert.deepEqual(applied, ["done"]);
    assert.equal(sm.peek("$async.errors").length, 1);
    assert.equal(sm.peek("$async.pending"), 0);
});

test("isThenable: an object or a function with a then method", () => {
    const sm = new StateManager();
    const callable = () => { };
    callable.then = () => { };
    assert.equal(sm.isThenable(Promise.resolve()), true);
    assert.equal(sm.isThenable({ then() { } }), true);
    assert.equal(sm.isThenable(callable), true);
    for (const value of [null, undefined, 5, "then", { then: 1 }, () => { }]) assert.equal(sm.isThenable(value), false, String(value));
});

// ---- promises and the counters -----------------------------------------------------------------

test("a promise is pending until it resolves, then its value is applied and the counters balance", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sm = new StateManager();
    const target = binding();
    const { promise, resolve } = deferred();
    const applied = run(sm, target, promise);
    assert.deepEqual(applied, []);
    assert.deepEqual(sm.peek("$async"), { started: 1, settled: 0, pending: 1 });
    assert.deepEqual(target.calls.pending, [true]);
    resolve("value");
    await flush();
    assert.deepEqual(applied, ["value"]);
    assert.deepEqual(sm.peek("$async"), { started: 1, settled: 1, pending: 0 });
    assert.deepEqual(target.calls.pending, [true, false]);
    assert.deepEqual(target.calls.slow, []);
});

test("a promise still waiting after pendingDelay counts as slow until it settles", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sm = new StateManager({}, { pendingDelay: 100 });
    const target = binding();
    const { promise, resolve } = deferred();
    run(sm, target, promise);
    t.mock.timers.tick(99);
    assert.equal(sm.peek("$async.slow"), undefined);
    t.mock.timers.tick(1);
    assert.equal(sm.peek("$async.slow"), 1);
    assert.deepEqual(target.calls.slow, [true]);
    resolve(1);
    await flush();
    assert.equal(sm.peek("$async.slow"), 0);
    assert.equal(sm.peek("$async.pending"), 0);
    assert.deepEqual(target.calls.slow, [true, false]);
});

test("the default pendingDelay is 200 ms", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sm = new StateManager();
    const target = binding();
    const { promise, resolve } = deferred();
    run(sm, target, promise);
    t.mock.timers.tick(199);
    assert.deepEqual(target.calls.slow, []);
    t.mock.timers.tick(1);
    assert.deepEqual(target.calls.slow, [true]);
    resolve();
    await flush();
});

test("a promise that settles before pendingDelay is never slow", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sm = new StateManager({}, { pendingDelay: 50 });
    const target = binding();
    const { promise, resolve } = deferred();
    run(sm, target, promise);
    resolve(1);
    await flush();
    t.mock.timers.tick(1000);
    assert.equal(sm.peek("$async.slow"), undefined);
    assert.deepEqual(target.calls.slow, []);
});

test("with pendingDelay 0 a promise is slow at once", async () => {
    const sm = new StateManager({}, { pendingDelay: 0 });
    const target = binding();
    const { promise, resolve } = deferred();
    run(sm, target, promise);
    assert.equal(sm.peek("$async.slow"), 1);
    assert.deepEqual(target.calls.slow, [true]);
    resolve();
    await flush();
    assert.equal(sm.peek("$async.slow"), 0);
});

test("the progress counters start over with the first promise of a new batch", async () => {
    const sm = new StateManager({}, { pendingDelay: 0 });
    const one = deferred();
    const two = deferred();
    run(sm, binding(), one.promise);
    run(sm, binding(), two.promise);
    assert.deepEqual([sm.peek("$async.started"), sm.peek("$async.pending")], [2, 2]);
    one.resolve();
    two.resolve();
    await flush();
    assert.deepEqual([sm.peek("$async.started"), sm.peek("$async.settled"), sm.peek("$async.pending")], [2, 2, 0]);
    const three = deferred();
    run(sm, binding(), three.promise);
    assert.deepEqual([sm.peek("$async.started"), sm.peek("$async.settled"), sm.peek("$async.pending")], [1, 0, 1]);
    three.resolve();
    await flush();
});

test("a binding's newer run supersedes its older one: one pending, the old result dropped", async () => {
    const sm = new StateManager({}, { pendingDelay: 0 });
    const target = binding();
    const older = deferred();
    const newer = deferred();
    const fromOlder = run(sm, target, older.promise);
    const fromNewer = run(sm, target, newer.promise);
    assert.equal(sm.peek("$async.pending"), 1);
    assert.equal(sm.peek("$async.started"), 2);
    older.resolve("old");
    await flush();
    assert.deepEqual(fromOlder, []);
    assert.equal(sm.peek("$async.pending"), 1, "still waiting on the newer run");
    assert.equal(sm.peek("$async.settled"), 1);
    newer.resolve("new");
    await flush();
    assert.deepEqual(fromNewer, ["new"]);
    assert.equal(sm.peek("$async.pending"), 0);
    assert.equal(sm.peek("$async.slow"), 0);
    assert.equal(sm.peek("$async.settled"), 2);
});

test("a plain value from a newer run ends the pending count of the older promise", async () => {
    const sm = new StateManager({}, { pendingDelay: 0 });
    const target = binding();
    const older = deferred();
    run(sm, target, older.promise);
    assert.deepEqual(run(sm, target, "now"), ["now"]);
    assert.equal(sm.peek("$async.pending"), 0);
    assert.equal(sm.peek("$async.slow"), 0);
    assert.deepEqual(target.calls.pending, [true, false]);
    older.resolve("late");
    await flush();
    assert.equal(sm.peek("$async.pending"), 0);
});

test("a disposed binding's result is dropped", async () => {
    const sm = new StateManager({}, { pendingDelay: 0 });
    const target = binding();
    const { promise, resolve } = deferred();
    const applied = run(sm, target, promise);
    target.disposed = true;
    sm.endPending(target);
    resolve("too late");
    await flush();
    assert.deepEqual(applied, []);
    assert.equal(sm.peek("$async.pending"), 0);
});

test("a promise resolving to a settled value applies that value", async () => {
    const sm = new StateManager({}, { pendingDelay: 0 });
    const target = binding();
    const applied = run(sm, target, Promise.resolve().then(() => ({ wrapped: settled("inner") })).then(({ wrapped }) => wrapped));
    await flush();
    assert.deepEqual(applied, ["inner"]);
});

// ---- rejections and the error log --------------------------------------------------------------

test("a rejection is logged with its message, handed to onError, and ends the pending count", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 5000 });
    const sm = new StateManager();
    const target = binding();
    const { promise, reject } = deferred();
    const error = new Error("boom");
    const applied = run(sm, target, promise);
    reject(error);
    await flush();
    assert.deepEqual(applied, []);
    assert.deepEqual(sm.peek("$async.errors"), [{ message: "boom", at: 5000 }]);
    assert.equal(target.calls.errors[0][0], target);
    assert.equal(target.calls.errors[0][1], error);
    assert.equal(sm.peek("$async.pending"), 0);
    assert.equal(sm.peek("$async.settled"), 1);
    assert.deepEqual(target.calls.pending, [true, false]);
});

test("a promise of a settled error is a rejection", async () => {
    const sm = new StateManager({}, { pendingDelay: 0 });
    const target = binding();
    const error = new Error("wrapped failure");
    run(sm, target, Promise.resolve().then(() => settledError(error)));
    await flush();
    assert.equal(target.calls.errors[0][1], error);
    assert.equal(sm.peek("$async.errors")[0].message, "wrapped failure");
});

test("a superseded run's rejection is neither logged nor handed on", async () => {
    const sm = new StateManager({}, { pendingDelay: 0 });
    const target = binding();
    const older = deferred();
    run(sm, target, older.promise);
    run(sm, target, "newer");
    older.reject(new Error("stale"));
    await flush();
    assert.equal(sm.peek("$async.errors"), undefined);
    assert.deepEqual(target.calls.errors, []);
    assert.equal(sm.peek("$async.settled"), 1, "it did settle");
});

test("the error log keeps the last MAX_ERROR_LOG entries, the oldest dropped", () => {
    const sm = new StateManager();
    for (let index = 0; index < MAX_ERROR_LOG + 10; index += 1) sm.recordError(new Error(`e${index}`));
    const log = sm.peek("$async.errors");
    assert.equal(log.length, MAX_ERROR_LOG);
    assert.equal(log[0].message, "e10");
    assert.equal(log.at(-1).message, `e${MAX_ERROR_LOG + 9}`);
});

test("the error log keeps an error's message, or else the value itself as text", () => {
    const sm = new StateManager();
    for (const reason of [new Error("an error"), "plain words", { message: 42 }, undefined, null, 7]) sm.recordError(reason);
    assert.deepEqual(sm.peek("$async.errors").map((entry) => entry.message), ["an error", "plain words", "42", "undefined", "null", "7"]);
});

test("the error log keeps the words errorMessage gives, under the async root configured", () => {
    const seen = [];
    const sm = new StateManager({}, {
        asyncPath: "$work",
        errorMessage: (error) => (seen.push(error), "request failed"),
    });
    const error = new Error("password=hunter2");
    sm.recordError(error);
    assert.deepEqual(seen, [error]);
    assert.deepEqual(sm.peek("$work.errors").map((entry) => entry.message), ["request failed"]);
    assert.equal(sm.peek("$async"), undefined);
});

test("in devMode a rejection is said on the console", () => {
    const sm = new StateManager({}, { devMode: true });
    const said = [];
    const original = console.error;
    console.error = (...args) => said.push(args);
    const error = new Error("said");
    try {
        sm.recordError(error);
    } finally {
        console.error = original;
    }
    assert.deepEqual(said, [["StateManager: async value rejected", error]]);
});

// ---- counters, epochs and resets ---------------------------------------------------------------

test("the async counters never go below 0", async () => {
    const sm = new StateManager({}, { pendingDelay: 0 });
    sm.count("pending", -1);
    assert.equal(sm.peek("$async.pending"), 0);
    const target = binding();
    const { promise, resolve } = deferred();
    run(sm, target, promise);
    sm.clearState({ $async: {} });
    resolve();
    await flush();
    assert.equal(sm.peek("$async.pending"), 0);
    assert.equal(sm.peek("$async.slow"), 0);
});

test("a custom asyncPath keeps the counters under it", async () => {
    const sm = new StateManager({}, { asyncPath: "$work", pendingDelay: 0 });
    const { promise, resolve } = deferred();
    run(sm, binding(), promise);
    assert.deepEqual(sm.peek("$work"), { started: 1, settled: 0, pending: 1, slow: 1 });
    resolve();
    await flush();
    assert.deepEqual(sm.peek("$work"), { started: 1, settled: 1, pending: 0, slow: 0 });
    assert.equal(sm.peek("$async"), undefined);
});

test("a browser's clearState carries a pending count across, and the promise still balances it", async () => {
    const sm = new StateManager({}, { pendingDelay: 0 });
    const { promise, resolve } = deferred();
    run(sm, binding(), promise);
    sm.clearState({ fresh: true });
    assert.equal(sm.peek("$async.pending"), 1);
    resolve();
    await flush();
    assert.equal(sm.peek("$async.pending"), 0);
    assert.equal(sm.peek("$async.slow"), 0);
});

test("after a reset, a promise counted under the old epoch moves none of the new counters", async () => {
    const sm = new StateManager({}, { pendingDelay: 0 });
    const target = binding();
    const { promise, resolve } = deferred();
    run(sm, target, promise);
    sm.clearState({}, { resetAsync: true });
    resolve("late");
    await flush();
    assert.equal(sm.peek("$async"), undefined);
    assert.deepEqual(target.calls.pending, [true, false]);
    assert.deepEqual(target.calls.slow, [true, false]);
});

test("after a reset, the old epoch's slow timer marks nothing", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sm = new StateManager({}, { pendingDelay: 100 });
    const target = binding();
    run(sm, target, new Promise(() => { }));
    sm.clearState({}, { resetAsync: true });
    t.mock.timers.tick(100);
    assert.equal(sm.peek("$async"), undefined);
    assert.deepEqual(target.calls.slow, []);
});

test("after a reset, a rejection from the old epoch is not logged in the new one", async () => {
    const sm = new StateManager({}, { pendingDelay: 0 });
    const { promise, reject } = deferred();
    run(sm, binding(), promise);
    sm.clearState({}, { resetAsync: true });
    reject(new Error("the last request's failure"));
    await flush();
    assert.equal(sm.peek("$async.errors"), undefined);
});

test("a binding still pending from an epoch that is over is counted anew by its next run", async () => {
    const sm = new StateManager({}, { pendingDelay: 0 });
    const target = binding();
    run(sm, target, new Promise(() => { }));
    sm.clearState({}, { resetAsync: true });
    const { promise, resolve } = deferred();
    run(sm, target, promise);
    assert.deepEqual(sm.peek("$async"), { started: 1, settled: 0, pending: 1, slow: 1 });
    assert.deepEqual(target.calls.pending, [true, false, true]);
    assert.deepEqual(target.calls.slow, [true, false, true]);
    resolve();
    await flush();
    assert.deepEqual(sm.peek("$async"), { started: 1, settled: 1, pending: 0, slow: 0 });
});

test("ending a binding pending from an old epoch that never got slow says only that it is done", () => {
    const sm = new StateManager({}, { pendingDelay: 1000 });
    const target = binding();
    sm.beginPending(target);
    sm.clearState({}, { resetAsync: true });
    sm.endPending(target);
    assert.deepEqual(target.calls.pending, [true, false]);
    assert.deepEqual(target.calls.slow, []);
    assert.equal(sm.peek("$async"), undefined);
});

test("markSlow leaves alone a binding that is not pending or is slow already", () => {
    const sm = new StateManager();
    const idle = binding();
    sm.markSlow(idle);
    const slow = Object.assign(binding(), { pending: true, slow: true, epoch: 0 });
    sm.markSlow(slow);
    assert.equal(sm.peek("$async"), undefined);
    assert.deepEqual(idle.calls.slow, []);
    assert.deepEqual(slow.calls.slow, []);
});

test("endPending of a binding that is not pending does nothing", () => {
    const sm = new StateManager();
    const target = binding();
    sm.endPending(target);
    assert.deepEqual(target.calls.pending, []);
    assert.equal(sm.peek("$async"), undefined);
});

// ---- computed promises -------------------------------------------------------------------------

test("a computed whose resolver answers a promise writes its value once it resolves", async () => {
    const sm = new StateManager({ id: 1 }, { pendingDelay: 0 });
    sm.compute("user", () => {
        const id = sm.getState("id");
        return Promise.resolve({ id });
    });
    assert.equal(sm.peek("user"), undefined);
    assert.equal(sm.peek("$async.pending"), 1);
    await flush();
    assert.deepEqual(sm.peek("user"), { id: 1 });
    assert.equal(sm.peek("$async.pending"), 0);
    sm.setValue("id", 2);
    await flush();
    assert.deepEqual(sm.peek("user"), { id: 2 }, "it re-ran on what it read");
});

test("disposing a computed while it waits ends its pending count and drops its result", async () => {
    const sm = new StateManager({}, { pendingDelay: 0 });
    const { promise, resolve } = deferred();
    const dispose = sm.compute("later", () => promise);
    assert.equal(sm.peek("$async.pending"), 1);
    dispose();
    assert.equal(sm.peek("$async.pending"), 0);
    assert.equal(sm.peek("$async.slow"), 0);
    resolve("too late");
    await flush();
    assert.equal(sm.peek("later"), undefined);
});
