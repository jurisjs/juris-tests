// state-manager.js, the tree itself: pathSegment, the settled values (settled, settledError,
// isSettled), MAX_ERROR_LOG, the path rules, reading (peek, getState and its tracking views, toRaw),
// writing (setValue, updateState, deleteState, clearState) and observe. Subscriptions, batches and
// computeds are in state-manager.reactivity.test.mjs; promises and the async counters in
// state-manager.async.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import StateManager, { pathSegment, settled, settledError, isSettled, MAX_ERROR_LOG } from "juris/state-manager.js";

// The paths whose subscribers a change woke, in the order they ran.
function listen(sm, paths) {
    const woke = [];
    for (const path of paths) sm.subscribe([path], () => woke.push(path));
    return woke;
}

// Every observe() call, as [path, value, previous].
function observed(sm) {
    const told = [];
    sm.observe((path, value, previous) => told.push([path, value, previous]));
    return told;
}

// ---- pathSegment ---------------------------------------------------------------------------

test("pathSegment escapes %, . and * so a text stays one segment", () => {
    assert.equal(pathSegment("rows.list"), "rows%2Elist");
    assert.equal(pathSegment("a*b"), "a%2Ab");
    assert.equal(pathSegment("50%"), "50%25");
    assert.equal(pathSegment("plain"), "plain");
    assert.equal(pathSegment(42), "42", "anything else is taken as its text");
});

test("pathSegment gives distinct texts distinct segments, and escapes __proto__ whole", () => {
    const texts = [".", "%2E", "%252E", "*", "%2A", "%", "%25", "__proto__", "%5F%5Fproto%5F%5F", "a.b", "a%2Eb"];
    const segments = texts.map(pathSegment);
    assert.equal(new Set(segments).size, texts.length);
    assert.equal(pathSegment("__proto__"), "%5F%5Fproto%5F%5F");
    for (const segment of segments) {
        assert.equal(segment.includes("."), false, segment);
        assert.equal(segment.includes("*"), false, segment);
        assert.notEqual(segment, "__proto__");
    }
});

test("a pathSegment is one key of a state path, whatever the text was", () => {
    const sm = new StateManager();
    sm.setValue(`live.${pathSegment("rows.list")}.status`, "live");
    sm.setValue(`live.${pathSegment("__proto__")}`, "kept");
    assert.deepEqual(sm.state.live, { "rows%2Elist": { status: "live" }, "%5F%5Fproto%5F%5F": "kept" });
    assert.equal({}.status, undefined);
});

// ---- settled values ------------------------------------------------------------------------

test("settled(value) is frozen, is settled, and holds its value", () => {
    const value = settled(5);
    assert.equal(Object.isFrozen(value), true);
    assert.equal(isSettled(value), true);
    assert.equal(value.value, 5);
    assert.equal("error" in value, false);
});

test("settled.then runs its callback at once and chains a settled value", () => {
    const order = [];
    const next = settled(2).then((value) => {
        order.push(value);
        return value * 3;
    });
    order.push("after");
    assert.deepEqual(order, [2, "after"]);
    assert.equal(isSettled(next), true);
    assert.equal(next.value, 6);
    assert.equal(settled(1).then((v) => v + 1).then((v) => v + 1).value, 3);
});

test("settled.then without a function keeps the value", () => {
    assert.equal(settled(4).then().value, 4);
    assert.equal(settled(4).then(null, () => "rejected").value, 4);
});

test("a then callback that throws gives a settled error holding what it threw", () => {
    const error = new Error("inside then");
    const next = settled(1).then(() => {
        throw error;
    });
    assert.equal(isSettled(next), true);
    assert.equal(next.error, error);
    assert.equal("value" in next, false);
});

test("a then callback that answers a settled value, a promise or a thenable answers it as it is", async () => {
    const inner = settled(9);
    assert.equal(settled(1).then(() => inner), inner);
    const promise = Promise.resolve(7);
    const chained = settled(1).then(() => promise);
    assert.equal(chained, promise, "the chain turns asynchronous from there");
    assert.equal(await chained, 7);
    const thenable = { then() { } };
    assert.equal(settled(1).then(() => thenable), thenable);
});

test("a then callback that answers null or an object gives a settled value of it", () => {
    const empty = settled(1).then(() => null);
    assert.equal(isSettled(empty), true);
    assert.equal(empty.value, null);
    const object = { a: 1 };
    assert.equal(settled(1).then(() => object).value, object);
});

test("settled.catch never calls its callback and keeps the value", () => {
    let called = false;
    const next = settled(3).catch(() => {
        called = true;
    });
    assert.equal(called, false);
    assert.equal(next.value, 3);
});

test("settled.finally calls its callback at once and keeps the value", () => {
    let called = 0;
    const next = settled(3).finally(() => {
        called += 1;
        return "ignored";
    });
    assert.equal(called, 1);
    assert.equal(next.value, 3);
    assert.equal(settled(3).finally().value, 3, "with no callback, nothing to call");
});

test("settled.finally with a callback that throws gives a settled error, as a promise's finally rejects", () => {
    const error = new Error("in finally");
    let next;
    assert.doesNotThrow(() => {
        next = settled(1).finally(() => {
            throw error;
        });
    });
    assert.equal(isSettled(next), true);
    assert.equal(next.error, error);
});

test("settledError(error) is frozen, is settled, and holds its error", () => {
    const error = new Error("failed");
    const value = settledError(error);
    assert.equal(Object.isFrozen(value), true);
    assert.equal(isSettled(value), true);
    assert.equal(value.error, error);
    assert.equal("value" in value, false);
});

test("settledError.then skips onFulfilled and runs onRejected at once", () => {
    const error = new Error("failed");
    let ran = false;
    const skipped = settledError(error).then(() => {
        ran = true;
    });
    assert.equal(ran, false);
    assert.equal(skipped.error, error);
    const handled = settledError(error).then(null, (reason) => `handled ${reason.message}`);
    assert.equal(handled.value, "handled failed");
});

test("settledError.catch recovers with what its callback answers; with none it stays the error", () => {
    const error = new Error("failed");
    assert.equal(settledError(error).catch((reason) => reason.message).value, "failed");
    assert.equal(settledError(error).catch().error, error);
    const again = new Error("again");
    const rethrown = settledError(error).catch(() => {
        throw again;
    });
    assert.equal(rethrown.error, again);
});

test("settledError.finally calls its callback at once and stays the same error", () => {
    const error = new Error("failed");
    let called = 0;
    const next = settledError(error).finally(() => {
        called += 1;
    });
    assert.equal(called, 1);
    assert.equal(next.error, error);
    assert.equal(settledError(error).finally().error, error);
});

test("settledError.finally with a callback that throws gives a settled error of that throw", () => {
    const thrown = new Error("in finally");
    let next;
    assert.doesNotThrow(() => {
        next = settledError(new Error("first")).finally(() => {
            throw thrown;
        });
    });
    assert.equal(next.error, thrown);
});

test("a finally callback that answers a promise turns the chain asynchronous: it waits for it, and its rejection is the chain's", async () => {
    const error = new Error("failed");
    const late = new Error("in finally");
    const order = [];
    const waited = settled(3).finally(() => new Promise((resolve) => setImmediate(() => resolve(order.push("finally")))));
    assert.equal(isSettled(waited), false);
    assert.equal(await waited.then((value) => (order.push("then"), value)), 3);
    assert.deepEqual(order, ["finally", "then"]);
    await assert.rejects(settledError(error).finally(() => Promise.resolve("ignored")), (reason) => reason === error);
    await assert.rejects(settled(3).finally(() => Promise.reject(late)), (reason) => reason === late);
    await assert.rejects(settledError(error).finally(() => Promise.reject(late)), (reason) => reason === late);
});

test("isSettled tells a settled value from a promise, a look-alike, null and a primitive", () => {
    for (const value of [null, undefined, 0, "settled", {}, { value: 1, then() { } }, Promise.resolve(1), { [Symbol("juris.settled")]: true }]) {
        assert.equal(isSettled(value), false, String(value));
    }
    assert.equal(isSettled(settled(undefined)), true);
    assert.equal(isSettled(settledError(undefined)), true);
    assert.equal(new StateManager().isSettled(settled(1)), true, "the method says the same");
    assert.equal(new StateManager().isSettled({}), false);
});

test("MAX_ERROR_LOG is 50", () => {
    assert.equal(MAX_ERROR_LOG, 50);
});

// ---- construction ----------------------------------------------------------------------------

test("a StateManager holds the very state object it is given, or an empty one", () => {
    const initial = { a: 1 };
    const sm = new StateManager(initial);
    assert.equal(sm.state, initial);
    sm.setValue("b", 2);
    assert.deepEqual(initial, { a: 1, b: 2 });
    assert.deepEqual(new StateManager().state, {});
});

test("its options default to $async, 200 ms, no onChange and no devMode", () => {
    const sm = new StateManager();
    assert.equal(sm.asyncPath, "$async");
    assert.equal(sm.pendingDelay, 200);
    assert.equal(sm.onChange, null);
    assert.equal(sm.devMode, false);
    const onChange = () => { };
    const configured = new StateManager({}, { asyncPath: "$work", pendingDelay: 0, onChange, devMode: 1 });
    assert.equal(configured.asyncPath, "$work");
    assert.equal(configured.pendingDelay, 0, "0 is kept: slow at once");
    assert.equal(configured.onChange, onChange);
    assert.equal(configured.devMode, true);
    assert.equal(new StateManager({}, { onChange: "not a function" }).onChange, null);
});

// ---- paths -----------------------------------------------------------------------------------

test("a path's empty segments are ignored: a..b, .a.b and a.b. all name a.b", () => {
    const sm = new StateManager();
    sm.setValue("a..b", 1);
    assert.deepEqual(sm.state, { a: { b: 1 } });
    assert.equal(sm.peek(".a.b."), 1);
    assert.equal(sm.getState("a.b"), 1);
});

test("a path naming __proto__ is refused for reads, writes, deletes and subscriptions", () => {
    const sm = new StateManager({ a: {} });
    const refused = { name: "Error", message: 'StateManager: "__proto__" is not allowed in a state path ("__proto__.polluted")' };
    assert.throws(() => sm.peek("__proto__.polluted"), refused);
    assert.throws(() => sm.setValue("__proto__.polluted", true), refused);
    assert.throws(() => sm.setValue("a.__proto__.polluted", true), /"__proto__" is not allowed in a state path \("a\.__proto__\.polluted"\)/);
    assert.throws(() => sm.deleteState("a.__proto__"), /"__proto__" is not allowed/);
    assert.throws(() => sm.subscribe(["a.__proto__.x"], () => { }), /"__proto__" is not allowed/);
    assert.equal({}.polluted, undefined);
    assert.deepEqual(sm.state, { a: {} });
});

test("constructor and prototype are ordinary keys of a path", () => {
    const sm = new StateManager();
    sm.setValue("o.constructor", 1);
    sm.setValue("o.prototype.x", 2);
    assert.equal(Object.hasOwn(sm.state.o, "constructor"), true);
    assert.deepEqual(sm.state.o, { constructor: 1, prototype: { x: 2 } });
});

test("the cache of split paths is emptied once it holds 10,000 of them, and reads stay right", () => {
    const sm = new StateManager({ p9999: "last" });
    for (let index = 0; index < 10_000; index += 1) sm.peek(`p${index}`);
    assert.equal(sm.pathCache.size, 10_000);
    assert.equal(sm.peek("one.more"), undefined);
    assert.equal(sm.pathCache.size, 1, "emptied, then the new path");
    assert.equal(sm.peek("p9999"), "last");
});

// ---- reading -----------------------------------------------------------------------------------

test("peek reads a nested value, and undefined wherever the path stops", () => {
    const sm = new StateManager({ a: { b: { c: 1 } }, n: null, s: "abc" });
    assert.equal(sm.peek("a.b.c"), 1);
    assert.equal(sm.peek("a.missing.deeper"), undefined);
    assert.equal(sm.peek("n.x"), undefined);
    assert.equal(sm.peek("s.length"), 3, "a primitive's own property");
    assert.equal(sm.peek(""), sm.state, "the empty path is the root");
});

test("peek and updateState record no dependency, even inside a capture", () => {
    const sm = new StateManager({ a: 1 });
    const { dependencies } = sm.capture(() => {
        sm.peek("a");
        sm.updateState("a", (value) => value + 1);
    });
    assert.equal(dependencies.size, 0);
    assert.equal(sm.peek("a"), 2);
});

test("getState answers the default only when nothing is there", () => {
    const sm = new StateManager({ zero: 0, no: false, nothing: null, empty: "" });
    assert.equal(sm.getState("missing", 7), 7);
    assert.equal(sm.getState("missing"), undefined);
    assert.equal(sm.getState("zero", 7), 0);
    assert.equal(sm.getState("no", 7), false);
    assert.equal(sm.getState("nothing", 7), null);
    assert.equal(sm.getState("empty", 7), "");
});

test("getState inside a capture records the path, and every read through the view it answers", () => {
    const sm = new StateManager({ user: { name: "Ada", tags: ["a", "b"], address: { city: "X" } } });
    const { dependencies, value } = sm.capture(() => {
        const user = sm.getState("user");
        return [user.name, user.tags[1], "age" in user, Object.keys(user.address)];
    });
    assert.deepEqual(value, ["Ada", "b", false, ["city"]]);
    assert.deepEqual([...dependencies].sort(), ["user", "user.address", "user.age", "user.name", "user.tags", "user.tags.1"]);
});

test("a view's array methods and iteration work, and what they read is tracked", () => {
    const sm = new StateManager({ list: [{ v: 1 }, { v: 2 }] });
    const { dependencies, value } = sm.capture(() => {
        const list = sm.getState("list");
        return { mapped: list.map((item) => item.v), spread: [...list].length };
    });
    assert.deepEqual(value, { mapped: [1, 2], spread: 2 });
    for (const path of ["list", "list.length", "list.0", "list.0.v", "list.1.v"]) assert.ok(dependencies.has(path), path);
});

test("a view refuses writes and deletes, and names the call to make instead", () => {
    const sm = new StateManager({ user: { name: "Ada" } });
    sm.capture(() => {
        const user = sm.getState("user");
        assert.throws(() => {
            user.name = "Grace";
        }, { name: "Error", message: 'StateManager: state is read-only inside bindings; use setValue("user.name", value)' });
        assert.throws(() => {
            delete user.name;
        }, { name: "Error", message: 'StateManager: state is read-only inside bindings; use deleteState("user.name")' });
    });
    assert.deepEqual(sm.state.user, { name: "Ada" });
});

test("one object read at one path is one view; toRaw gives the object back", () => {
    const sm = new StateManager({ user: { name: "Ada" } });
    const raw = sm.peek("user");
    const [first, second, untracked] = sm.capture(() => [sm.getState("user"), sm.getState("user"), sm.getState("user", undefined, { track: false })]).value;
    assert.equal(first, second);
    assert.notEqual(first, raw, "a view, not the object");
    assert.equal(sm.toRaw(first), raw);
    assert.equal(untracked, raw, "{ track: false }: the object itself");
    assert.equal(sm.getState("user"), raw, "outside a capture, the object itself");
});

test("a view of a frozen object answers Object.keys, in and spread as the object does, and unwraps to it", () => {
    const sm = new StateManager({ cfg: Object.freeze({ a: { b: 1 }, n: 2 }) });
    const raw = sm.peek("cfg");
    const { dependencies, value } = sm.capture(() => {
        const cfg = sm.getState("cfg");
        return { cfg, keys: Object.keys(cfg), has: "a" in cfg, missing: "z" in cfg, own: Object.hasOwn(cfg, "z"), spread: { ...cfg } };
    });
    assert.deepEqual(value.keys, ["a", "n"]);
    assert.equal(value.has, true);
    assert.equal(value.missing, false);
    assert.equal(value.own, false);
    assert.deepEqual(value.spread, { a: { b: 1 }, n: 2 });
    assert.notEqual(value.spread.a, raw.a, "what it holds is a view too");
    assert.equal(sm.toRaw(value.spread.a), raw.a);
    assert.equal(sm.toRaw(value.cfg), raw);
    assert.equal(Object.getPrototypeOf(value.cfg), Object.prototype);
    for (const path of ["cfg", "cfg.a", "cfg.n", "cfg.z"]) assert.ok(dependencies.has(path), path);
    sm.setValue("copy", value.cfg);
    assert.equal(sm.peek("copy"), raw, "a write stores the object, not the view");
});

test("a view of a frozen array is an array of the same length and prototype, and unwraps to it", () => {
    const sm = new StateManager({ list: Object.freeze([{ v: 1 }, { v: 2 }]) });
    const raw = sm.peek("list");
    const { value } = sm.capture(() => {
        const list = sm.getState("list");
        return { list, isArray: Array.isArray(list), mapped: list.map((item) => item.v), keys: Object.keys(list), length: Object.getOwnPropertyDescriptor(list, "length") };
    });
    assert.equal(value.isArray, true);
    assert.deepEqual(value.mapped, [1, 2]);
    assert.deepEqual(value.keys, ["0", "1"]);
    assert.deepEqual(value.length, Object.getOwnPropertyDescriptor(raw, "length"));
    assert.equal(Object.getPrototypeOf(value.list), Array.prototype);
    assert.equal(sm.toRaw(value.list), raw);
});

test("a view read after its capture ended hands out raw children and records nothing", () => {
    const sm = new StateManager({ user: { address: { city: "X" } } });
    const view = sm.capture(() => sm.getState("user")).value;
    assert.equal(view.address, sm.peek("user.address"));
    assert.equal(sm.activeDependencies, null);
});

test("a view's symbol reads reach the object", () => {
    const tag = Symbol("tag");
    const sm = new StateManager({ o: { [tag]: "symbol value", a: 1 } });
    const { dependencies, value } = sm.capture(() => {
        const o = sm.getState("o");
        return [o[tag], tag in o];
    });
    assert.deepEqual(value, ["symbol value", true]);
    assert.deepEqual([...dependencies], ["o"], "a symbol is no path");
});

test("non-plain objects (a Date, a Map, a class instance) are handed out as they are, never wrapped", () => {
    class Point {
        constructor() {
            this.x = 1;
        }
    }
    const sm = new StateManager({ when: new Date(0), map: new Map([["k", 1]]), point: new Point() });
    const [when, map, point] = sm.capture(() => [sm.getState("when"), sm.getState("map"), sm.getState("point")]).value;
    assert.equal(when, sm.peek("when"));
    assert.equal(map, sm.peek("map"));
    assert.equal(point, sm.peek("point"));
});

test("toRaw answers anything that is not a view as itself", () => {
    const sm = new StateManager();
    const object = {};
    assert.equal(sm.toRaw(object), object);
    assert.equal(sm.toRaw(5), 5);
    assert.equal(sm.toRaw(null), null);
    assert.equal(sm.toRaw(undefined), undefined);
});

test("getState records its path in activeReads when one is set, handing out no views for it", () => {
    const sm = new StateManager({ a: { b: 1 } });
    sm.activeReads = new Set();
    try {
        const value = sm.getState("a");
        sm.getState("x.y", 0);
        assert.equal(value, sm.peek("a"));
        assert.deepEqual([...sm.activeReads], ["a", "x.y"]);
    } finally {
        sm.activeReads = null;
    }
});

// ---- writing -----------------------------------------------------------------------------------

test("setValue writes a nested value, making the parents that are missing", () => {
    const sm = new StateManager();
    sm.setValue("a.b.c", 1);
    assert.deepEqual(sm.state, { a: { b: { c: 1 } } });
});

test("setValue replaces a primitive or null on its way with an object", () => {
    const sm = new StateManager({ a: 5, n: null });
    sm.setValue("a.b", 1);
    sm.setValue("n.x.y", 2);
    assert.deepEqual(sm.state, { a: { b: 1 }, n: { x: { y: 2 } } });
});

test("setValue on an empty path writes nothing and tells nobody", () => {
    const sm = new StateManager({ a: 1 });
    const told = observed(sm);
    sm.setValue("", 1);
    sm.setValue("..", 1);
    assert.deepEqual(sm.state, { a: 1 });
    assert.deepEqual(told, []);
});

test("setValue stores raw objects, never a view, and copies only a container that held one", () => {
    const sm = new StateManager({ user: { name: "Ada" } });
    const raw = sm.peek("user");
    const view = sm.capture(() => sm.getState("user")).value;
    const plain = { x: [1] };
    sm.setValue("plain", plain);
    assert.equal(sm.peek("plain"), plain, "nothing to replace: the same object");
    const holder = { inner: view, list: [view, 1] };
    sm.setValue("holder", holder);
    const stored = sm.peek("holder");
    assert.notEqual(stored, holder);
    assert.equal(stored.inner, raw);
    assert.equal(stored.list[0], raw);
    assert.equal(stored.list[1], 1);
    assert.equal(holder.inner, view, "what was given is left as it was");
    sm.setValue("direct", view);
    assert.equal(sm.peek("direct"), raw);
});

test("setValue stores a value that refers to itself", () => {
    const sm = new StateManager();
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    sm.setValue("c", cyclic);
    assert.equal(sm.peek("c.self.self"), cyclic);
});

test("setValue of the same primitive wakes nobody and tells no observer", () => {
    const sm = new StateManager({ n: 1, nan: Number.NaN, empty: null, s: "x" });
    const woke = listen(sm, ["n", "nan", "empty", "s"]);
    const told = observed(sm);
    sm.setValue("n", 1);
    sm.setValue("nan", Number.NaN);
    sm.setValue("empty", null);
    sm.setValue("s", "x");
    assert.deepEqual(woke, []);
    assert.deepEqual(told, []);
    sm.setValue("n", 2);
    assert.deepEqual(woke, ["n"]);
    assert.deepEqual(told, [["n", 2, 1]]);
});

test("setValue of an object or a function always notifies, so a mutate-and-reset is seen", () => {
    const sm = new StateManager({ o: { a: 1 }, f: null });
    const woke = listen(sm, ["o.a", "f"]);
    const object = sm.peek("o");
    object.a = 2;
    sm.setValue("o", object);
    const fn = () => { };
    sm.setValue("f", fn);
    sm.setValue("f", fn);
    assert.deepEqual(woke, ["o.a", "f", "f"]);
});

test("a computed path refuses setValue, updateState and deleteState", () => {
    const sm = new StateManager();
    sm.compute("total", () => 1);
    assert.throws(() => sm.setValue("total", 2), { name: "Error", message: 'StateManager.setValue: "total" is a computed path and cannot be written directly' });
    assert.throws(() => sm.updateState("total", (v) => v + 1), /StateManager\.setValue: "total" is a computed path/);
    assert.throws(() => sm.deleteState("total"), { message: 'StateManager.deleteState: "total" is a computed path and cannot be written directly' });
    assert.equal(sm.peek("total"), 1);
});

test("updateState hands the updater what is there and writes what it answers", () => {
    const sm = new StateManager({ n: 1 });
    const seen = [];
    sm.updateState("n", (value) => (seen.push(value), value + 1));
    sm.updateState("fresh", (value = 10) => (seen.push(value), value * 2));
    assert.deepEqual(seen, [1, 10]);
    assert.deepEqual(sm.state, { n: 2, fresh: 20 });
});

test("deleteState removes an object key and tells observers what was there", () => {
    const sm = new StateManager({ a: { b: 1, c: 2 } });
    const told = observed(sm);
    sm.deleteState("a.b");
    assert.deepEqual(sm.state, { a: { c: 2 } });
    assert.equal(Object.hasOwn(sm.state.a, "b"), false);
    assert.deepEqual(told, [["a.b", undefined, 1]]);
});

test("deleteState does nothing where nothing is: a missing key, a missing parent, the empty path", () => {
    const sm = new StateManager({ a: { b: 1 }, n: null });
    const woke = listen(sm, ["a", "a.zz", "x.y.z", "n.x"]);
    const told = observed(sm);
    sm.deleteState("a.zz");
    sm.deleteState("x.y.z");
    sm.deleteState("n.x");
    sm.deleteState("a.toString");
    sm.deleteState("");
    assert.deepEqual(sm.state, { a: { b: 1 }, n: null });
    assert.deepEqual(woke, []);
    assert.deepEqual(told, []);
});

test("deleteState splices an array index, the later items moving down", () => {
    const sm = new StateManager({ list: ["a", "b", "c"] });
    const told = observed(sm);
    sm.deleteState("list.1");
    assert.deepEqual(sm.state.list, ["a", "c"]);
    assert.deepEqual(told, [["list.1", undefined, "b"]]);
});

test("deleteState splices nothing for an array key that is not an index", () => {
    const sm = new StateManager({ list: ["a", "b"] });
    sm.setValue("list.-1", "odd");
    sm.setValue("list.4294967295", "beyond");
    const told = observed(sm);
    sm.deleteState("list.length");
    sm.deleteState("list.-1");
    sm.deleteState("list.4294967295");
    assert.equal(sm.state.list.length, 2);
    assert.deepEqual([...sm.state.list], ["a", "b"]);
    assert.deepEqual(told, []);
});

// ---- clearState --------------------------------------------------------------------------------

test("clearState replaces the tree in place, keeping the root object", () => {
    const sm = new StateManager({ a: 1, b: { c: 2 } });
    const root = sm.state;
    sm.clearState({ z: 1 });
    assert.equal(sm.state, root);
    assert.deepEqual(sm.state, { z: 1 });
    sm.clearState();
    assert.deepEqual(sm.state, {}, "by default, an empty tree");
});

test("clearState wakes every subscriber once and reports one root change", () => {
    const changes = [];
    const sm = new StateManager({ a: 1, b: { c: 2 } }, { onChange: (path) => changes.push(path) });
    const woke = listen(sm, ["a", "b.c", "list.*", ""]);
    sm.clearState({ a: 2 });
    assert.deepEqual(woke.sort(), ["", "a", "b.c", "list.*"]);
    assert.deepEqual(changes, [""]);
});

test("clearState carries the async counters over and drops every error log", () => {
    const sm = new StateManager({
        $async: {
            pending: 1,
            slow: 0,
            started: 2,
            settled: 1,
            errors: [{ message: "top", at: 1 }],
            groups: { g: { pending: 1, errors: [{ message: "g", at: 1 }] }, a: { b: { pending: 0, errors: [{ message: "a.b", at: 1 }] } } },
            live: { errors: { status: "live" }, rows: { status: "failed", message: "m" } },
        },
        app: 1,
    });
    sm.clearState({ next: true });
    assert.deepEqual(sm.state, {
        next: true,
        $async: {
            pending: 1,
            slow: 0,
            started: 2,
            settled: 1,
            groups: { g: { pending: 1 }, a: { b: { pending: 0 } } },
            live: { errors: { status: "live" }, rows: { status: "failed", message: "m" } },
        },
    });
});

test("clearState drops the top error log whatever it holds", () => {
    const sm = new StateManager({ $async: { pending: 0, errors: "not even a list" } });
    sm.clearState({});
    assert.deepEqual(sm.state, { $async: { pending: 0 } });
});

test("clearState keeps the async root the next state brings", () => {
    const sm = new StateManager({ $async: { pending: 3, errors: [1] } });
    sm.clearState({ $async: { pending: 5 } });
    assert.deepEqual(sm.state, { $async: { pending: 5 } });
});

test("clearState with resetAsync carries nothing and moves the epoch on", () => {
    const sm = new StateManager({ $async: { pending: 3 } });
    assert.equal(sm.epoch, 0);
    sm.clearState({ a: 1 }, { resetAsync: true });
    assert.deepEqual(sm.state, { a: 1 });
    assert.equal(sm.epoch, 1);
    sm.clearState({}, { resetAsync: true });
    assert.equal(sm.epoch, 2);
    sm.clearState({});
    assert.equal(sm.epoch, 2, "a plain clear keeps the epoch");
});

test("clearState carries nothing when the async root holds no object", () => {
    const sm = new StateManager({ $async: 3 });
    sm.clearState({});
    assert.deepEqual(sm.state, {});
});

test("clearState carries the async root it was configured with", () => {
    const sm = new StateManager({ $work: { pending: 1, errors: [{ message: "x" }] }, $async: { pending: 9 } }, { asyncPath: "$work" });
    sm.clearState({});
    assert.deepEqual(sm.state, { $work: { pending: 1 } });
});

test("clearState skips an own __proto__ key in the next state, so the root's prototype stays", () => {
    const sm = new StateManager();
    sm.clearState(JSON.parse('{"__proto__": {"polluted": true}, "a": 1}'));
    assert.equal(Object.getPrototypeOf(sm.state), Object.prototype);
    assert.equal(Object.hasOwn(sm.state, "__proto__"), false);
    assert.equal(sm.state.polluted, undefined);
    assert.equal({}.polluted, undefined);
    assert.deepEqual(sm.state, { a: 1 });
});

test("clearState stores raw objects for any view in the next state", () => {
    const sm = new StateManager({ user: { name: "Ada" } });
    const raw = sm.peek("user");
    const view = sm.capture(() => sm.getState("user")).value;
    sm.clearState({ copy: view, nested: { inner: view } });
    assert.equal(sm.state.copy, raw);
    assert.equal(sm.state.nested.inner, raw);
});

test("clearState tells observers the root, the new tree and undefined", () => {
    const sm = new StateManager({ a: 1 });
    const told = observed(sm);
    sm.clearState({ z: 1 });
    assert.equal(told.length, 1);
    assert.equal(told[0][0], "");
    assert.equal(told[0][1], sm.state);
    assert.equal(told[0][2], undefined);
});

// ---- observe -----------------------------------------------------------------------------------

test("observe refuses anything but a function", () => {
    const sm = new StateManager();
    assert.throws(() => sm.observe("not a function"), { name: "TypeError", message: "StateManager.observe: observer is a function (path, value, previous)" });
    assert.throws(() => sm.observe(), TypeError);
});

test("observe is told every write once, by the path written, with what was there before", () => {
    const sm = new StateManager({ a: { b: 1 } });
    const told = observed(sm);
    sm.setValue("a.b", 2);
    sm.setValue("a.c.d", 3);
    sm.setValue("x", "new");
    assert.deepEqual(told, [
        ["a.b", 2, 1],
        ["a.c.d", 3, undefined],
        ["x", "new", undefined],
    ]);
});

test("an observer is told after the subscribers a write woke; inside batch, at the write itself", () => {
    const sm = new StateManager({ a: 1 });
    const order = [];
    sm.subscribe(["a"], () => order.push("subscriber"));
    sm.observe(() => order.push("observer"));
    sm.setValue("a", 2);
    assert.deepEqual(order, ["subscriber", "observer"]);
    order.length = 0;
    sm.batch(() => {
        sm.setValue("a", 3);
        order.push("still in the batch");
    });
    assert.deepEqual(order, ["observer", "still in the batch", "subscriber"]);
});

test("the function observe answers stops that observer only", () => {
    const sm = new StateManager();
    const first = [];
    const second = [];
    const stop = sm.observe((path) => first.push(path));
    sm.observe((path) => second.push(path));
    sm.setValue("a", 1);
    stop();
    sm.setValue("b", 1);
    assert.deepEqual(first, ["a"]);
    assert.deepEqual(second, ["a", "b"]);
});

test("every observer runs whichever throws, and the first error reaches the writer", () => {
    const sm = new StateManager();
    const ran = [];
    const first = new Error("first");
    sm.observe(() => {
        ran.push(1);
        throw first;
    });
    sm.observe(() => {
        ran.push(2);
        throw new Error("second");
    });
    sm.observe(() => ran.push(3));
    assert.throws(() => sm.setValue("x", 1), (error) => error === first);
    assert.deepEqual(ran, [1, 2, 3]);
    assert.equal(sm.peek("x"), 1, "the write was made");
    assert.throws(() => sm.deleteState("x"), (error) => error === first);
    assert.equal(sm.peek("x"), undefined);
});

test("an observer is told of a write even when one of its subscribers threw", () => {
    const sm = new StateManager({ x: 1 });
    const told = observed(sm);
    sm.subscribe(["x"], () => {
        throw new Error("subscriber");
    });
    assert.throws(() => sm.setValue("x", 2), /subscriber/);
    assert.equal(sm.peek("x"), 2);
    assert.deepEqual(told, [["x", 2, 1]]);
});

test("a new key, a delete and a clear are told even when a subscriber threw", () => {
    const sm = new StateManager({ list: { a: 1 } });
    const told = observed(sm);
    sm.subscribe(["list"], () => {
        throw new Error("subscriber");
    });
    assert.throws(() => sm.setValue("list.b", 2), /subscriber/);
    assert.throws(() => sm.deleteState("list.a"), /subscriber/);
    assert.throws(() => sm.clearState({ z: 1 }), /subscriber/);
    assert.deepEqual(told, [
        ["list.b", 2, undefined],
        ["list.a", undefined, 1],
        ["", sm.state, undefined],
    ]);
});

test("when a subscriber and an observer both throw, every observer runs and the writer gets the subscriber's error", () => {
    const sm = new StateManager({ x: 1 });
    const ran = [];
    const first = new Error("subscriber");
    sm.subscribe(["x"], () => {
        throw first;
    });
    sm.observe(() => {
        ran.push(1);
        throw new Error("observer");
    });
    sm.observe(() => ran.push(2));
    assert.throws(() => sm.setValue("x", 2), (error) => error === first);
    assert.deepEqual(ran, [1, 2]);
});
