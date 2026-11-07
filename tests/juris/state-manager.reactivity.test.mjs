// state-manager.js, what a change wakes: subscribe and the path trie, which readers a structural
// change (a key or index appearing or going) wakes, wildcards, isAffected, batch, the notification
// pass (computeds before bindings, creation order, the loop guard, errors collected), compute, capture
// and tryCapture. The tree itself is in state-manager.test.mjs; promises in state-manager.async.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import StateManager, { settled } from "juris/state-manager.js";

// The paths whose subscribers a change woke, in the order they ran.
function listen(sm, paths) {
    const woke = [];
    for (const path of paths) sm.subscribe([path], () => woke.push(path));
    return woke;
}

// A binding as the core makes one (bindState): stamped, re-subscribed to what each run read.
function bind(sm, resolver, apply) {
    let subscribed = null;
    const refresh = sm.stamp(() => {
        const { dependencies, value } = sm.tryCapture(resolver);
        apply(value);
        subscribed = sm.resubscribe(refresh, subscribed, dependencies);
    });
    refresh();
    return () => {
        subscribed = sm.resubscribe(refresh, subscribed, null);
    };
}

// Collects console[method] calls while `fn` runs.
function quietly(method, fn) {
    const calls = [];
    const original = console[method];
    console[method] = (...args) => calls.push(args);
    try {
        fn();
    } finally {
        console[method] = original;
    }
    return calls;
}

// ---- what a write wakes ----------------------------------------------------------------------

test("a write wakes the subscribers of its path and of every path beneath it", () => {
    const sm = new StateManager({ a: { b: { c: 1 } }, x: 1 });
    const woke = listen(sm, ["a", "a.b", "a.b.c", "a.bc", "x"]);
    sm.setValue("a.b", { c: 2 });
    assert.deepEqual(woke.sort(), ["a.b", "a.b.c"]);
});

test("a write does not bubble up to the subscribers of a parent", () => {
    const sm = new StateManager({ a: { b: 1 } });
    const woke = listen(sm, ["a", "a.b"]);
    sm.setValue("a.b", 2);
    assert.deepEqual(woke, ["a.b"]);
});

test("a new key wakes its container's own readers and the key's, never its siblings'", () => {
    const sm = new StateManager({ o: { a: 1 } });
    const woke = listen(sm, ["o", "o.a", "o.b", "o.b.deep"]);
    sm.setValue("o.b", { deep: 1 });
    assert.deepEqual(woke.sort(), ["o", "o.b", "o.b.deep"]);
});

test("a key named like an Object.prototype member is new too, and wakes its container's readers", () => {
    const sm = new StateManager({ o: { a: 1 } });
    const woke = listen(sm, ["o", "o.a"]);
    sm.setValue("o.toString", "mine");
    assert.deepEqual(woke, ["o"]);
});

test("a new array index also wakes the readers of the array's length", () => {
    const sm = new StateManager({ list: [1] });
    const woke = listen(sm, ["list", "list.length", "list.0", "list.1"]);
    sm.setValue("list.1", 2);
    assert.deepEqual(woke.sort(), ["list", "list.1", "list.length"]);
});

test("a write that makes parents wakes each made object's shape readers and the path's own", () => {
    const sm = new StateManager({ a: {} });
    const woke = listen(sm, ["a", "a.b", "a.b.c", "a.b.c.d", "a.b.x", "a.y"]);
    sm.setValue("a.b.c", { d: 1 });
    assert.deepEqual(woke.sort(), ["a", "a.b", "a.b.c", "a.b.c.d"]);
});

test("a new root key wakes its own readers; a made root, its shape readers and the path's", () => {
    const sm = new StateManager({});
    const woke = listen(sm, ["", "z", "p", "p.q", "p.r"]);
    sm.setValue("z", 1);
    assert.deepEqual(woke, ["z"]);
    woke.length = 0;
    sm.setValue("p.q", 1);
    assert.deepEqual(woke.sort(), ["p", "p.q"]);
});

test("deleting a key wakes its container's shape readers and the key's, never its siblings'", () => {
    const sm = new StateManager({ o: { a: 1, b: { deep: 1 } } });
    const woke = listen(sm, ["o", "o.a", "o.b", "o.b.deep"]);
    sm.deleteState("o.b");
    assert.deepEqual(woke.sort(), ["o", "o.b", "o.b.deep"]);
});

test("deleting an array index wakes the whole array, since every later item moved", () => {
    const sm = new StateManager({ list: ["a", "b", "c"], other: 1 });
    const woke = listen(sm, ["list", "list.0", "list.2", "list.length", "other"]);
    sm.deleteState("list.1");
    assert.deepEqual(woke.sort(), ["list", "list.0", "list.2", "list.length"]);
});

test("deleting a root key wakes its own readers and those beneath it", () => {
    const sm = new StateManager({ r: { x: 1 }, s: 1 });
    const woke = listen(sm, ["r", "r.x", "s"]);
    sm.deleteState("r");
    assert.deepEqual(woke.sort(), ["r", "r.x"]);
});

test("the subscribers of the root are woken by clearState, not by a write beneath it", () => {
    const sm = new StateManager({ a: 1 });
    const woke = listen(sm, [""]);
    sm.setValue("a", 2);
    sm.setValue("b.c", 1);
    assert.deepEqual(woke, []);
    sm.clearState({});
    assert.deepEqual(woke, [""]);
});

test("a write where nothing is subscribed runs nothing and still reports the change", () => {
    const changes = [];
    const sm = new StateManager({ a: { b: 1 } }, { onChange: (path) => changes.push(path) });
    const woke = listen(sm, ["a.b"]);
    sm.setValue("x", { y: 1 });
    sm.setValue("x.y", 2);
    assert.deepEqual(woke, []);
    assert.deepEqual(changes, ["x", "x.y"]);
});

test("onChange is told each changed path once its pass has run, as plain paths", () => {
    const changes = [];
    const sm = new StateManager({ o: { a: 1 } }, { onChange: (path) => changes.push(path) });
    let ranBefore = null;
    sm.subscribe(["o.a"], () => {
        ranBefore = changes.length;
    });
    sm.setValue("o.a", 2);
    assert.equal(ranBefore, 0, "the subscriber ran before onChange heard of it");
    sm.setValue("o.b", 1);
    assert.deepEqual(changes, ["o.a", "o", "o.b"]);
    for (const path of changes) assert.equal(path.includes("\u0001"), false);
});

// ---- wildcards ---------------------------------------------------------------------------------

test("a wildcard subscription matches exactly one segment for each *", () => {
    const sm = new StateManager({ todos: [{ done: false, title: "a" }, { done: false, title: "b" }], other: 1 });
    let count = 0;
    sm.subscribe(["todos.*.done"], () => (count += 1));
    sm.setValue("todos.1.done", true);
    assert.equal(count, 1, "a todo's done");
    sm.setValue("todos.1", { done: true, title: "c" });
    assert.equal(count, 2, "a whole todo");
    sm.setValue("todos", [{ done: true }]);
    assert.equal(count, 3, "the whole list");
    sm.setValue("todos.0.title", "x");
    sm.setValue("other", 2);
    assert.equal(count, 3, "a sibling of done and another root wake nothing");
    sm.clearState({});
    assert.equal(count, 4, "the root");
});

test("a write deeper than a wildcard reaches does not wake it", () => {
    const sm = new StateManager({ rows: { r1: { x: 1 } } });
    let count = 0;
    sm.subscribe(["rows.*"], () => (count += 1));
    sm.setValue("rows.r1.x", 2);
    assert.equal(count, 0);
    sm.setValue("rows.r1", { x: 3 });
    assert.equal(count, 1);
});

test("a wildcard naming a container hears a key appear in it", () => {
    const sm = new StateManager({ rows: { r1: 1 } });
    let count = 0;
    sm.subscribe(["*"], () => (count += 1));
    sm.setValue("rows.r2", 2);
    assert.equal(count, 1);
});

test("a key appearing beside a wildcard's leaf does not wake it", () => {
    const sm = new StateManager({ rows: { r1: { x: 1 } } });
    let count = 0;
    sm.subscribe(["rows.*.x"], () => (count += 1));
    sm.setValue("rows.r1.y", 1);
    assert.equal(count, 0);
    sm.setValue("rows.r2", { x: 1 });
    assert.equal(count, 1, "a new row is a new rows.*.x");
});

test("unsubscribing a wildcard stops it", () => {
    const sm = new StateManager({ a: { b: 1 } });
    let count = 0;
    const stop = sm.subscribe(["a.*"], () => (count += 1));
    stop();
    sm.setValue("a.b", 2);
    assert.equal(count, 0);
    assert.equal(sm.wildcards.size, 0);
});

test("isAffected: the same path or an ancestor's write affects; a descendant's or a stranger's does not", () => {
    const sm = new StateManager();
    assert.equal(sm.isAffected("a.b", "a.b"), true);
    assert.equal(sm.isAffected("a.b", "a"), true);
    assert.equal(sm.isAffected("a.b", ""), true, "the root affects everything");
    assert.equal(sm.isAffected("a", "a.b"), false);
    assert.equal(sm.isAffected("ab", "a"), false, "a prefix is not a parent");
    assert.equal(sm.isAffected("a.*.c", "a.x.c"), true);
    assert.equal(sm.isAffected("a.*.c", "a.x"), true);
    assert.equal(sm.isAffected("a.*", "a.x.c"), false);
    assert.equal(sm.isAffected("a.*.c", "a.x.d"), false);
    assert.equal(sm.isAffected("a.*.c", "b"), false);
});

// ---- subscribe and the trie --------------------------------------------------------------------

test("subscribe answers the function that removes the callback from every path it was given", () => {
    const sm = new StateManager({ a: 1, b: 1 });
    let count = 0;
    const stop = sm.subscribe(["a", "b"], () => (count += 1));
    sm.setValue("a", 2);
    sm.setValue("b", 2);
    stop();
    sm.setValue("a", 3);
    sm.setValue("b", 3);
    assert.equal(count, 2);
});

test("two callbacks on one path: removing one leaves the other", () => {
    const sm = new StateManager({ a: 1 });
    const woke = [];
    const stopFirst = sm.subscribe(["a"], () => woke.push("first"));
    sm.subscribe(["a"], () => woke.push("second"));
    stopFirst();
    sm.setValue("a", 2);
    assert.deepEqual(woke, ["second"]);
});

test("one callback on two paths written in one batch runs once", () => {
    const sm = new StateManager({ a: 1, b: 1 });
    let count = 0;
    sm.subscribe(["a", "b"], () => (count += 1));
    sm.batch(() => {
        sm.setValue("a", 2);
        sm.setValue("b", 2);
    });
    assert.equal(count, 1);
});

test("removing every subscription leaves the trie as empty as it started", () => {
    const sm = new StateManager();
    const stops = [sm.subscribe(["a.b.c", "a.b", "x"], () => { }), sm.subscribe(["a.b.c.d", "a.*"], () => { })];
    for (const stop of stops) stop();
    assert.equal(sm.subscribers.size, 0);
    assert.equal(sm.wildcards.size, 0);
    assert.equal(sm.trie.children, null);
});

test("removing a deep subscription keeps its parent's own, which still wakes", () => {
    const sm = new StateManager({ a: { b: { c: 1 } } });
    const woke = [];
    sm.subscribe(["a"], () => woke.push("a"));
    const stop = sm.subscribe(["a.b.c"], () => woke.push("a.b.c"));
    stop();
    assert.equal(sm.trie.children.get("a").children, null, "the dead tail is pruned");
    sm.setValue("a", { b: { c: 2 } });
    assert.deepEqual(woke, ["a"]);
});

test("removing a subscription that was never made, or twice, does nothing", () => {
    const sm = new StateManager({ a: 1 });
    const woke = [];
    const callback = () => woke.push("a");
    sm.removeSubscription("a", callback);
    sm.subscribe(["a"], callback);
    sm.removeSubscription("a", () => { });
    const stop = sm.subscribe(["b"], callback);
    stop();
    stop();
    sm.setValue("a", 2);
    assert.deepEqual(woke, ["a"]);
});

test("two spellings of one path both keep their subscribers", () => {
    const sm = new StateManager({ a: { b: 1 } });
    const woke = [];
    sm.subscribe(["a.b"], () => woke.push("a.b"));
    const stopAlias = sm.subscribe(["a..b"], () => woke.push("a..b"));
    sm.setValue("a.b", 2);
    assert.deepEqual(woke.sort(), ["a..b", "a.b"]);
    woke.length = 0;
    stopAlias();
    sm.setValue("a.b", 3);
    assert.deepEqual(woke, ["a.b"]);
});

test("one callback under two spellings of a path wakes once, until both are dropped, in either order", () => {
    for (const [dropped, kept] of [["x", ".x"], [".x", "x"]]) {
        const sm = new StateManager({ x: 1 });
        let runs = 0;
        const callback = () => (runs += 1);
        sm.subscribe([dropped], callback);
        sm.subscribe([kept], callback);
        sm.setValue("x", 2);
        assert.equal(runs, 1, "one wake for one change");
        sm.removeSubscription(dropped, callback);
        sm.setValue("x", 3);
        assert.equal(runs, 2, `still subscribed as "${kept}"`);
        sm.removeSubscription(kept, callback);
        sm.setValue("x", 4);
        assert.equal(runs, 2);
        assert.equal(sm.trie.children, null);
    }
});

test("unsubscribing both spellings of one path leaves nothing subscribed", () => {
    const sm = new StateManager({ a: { b: 1 } });
    const stops = [sm.subscribe(["a.b"], () => { }), sm.subscribe(["a..b"], () => { })];
    stops.reverse().forEach((stop) => stop());
    assert.equal(sm.subscribers.size, 0);
    assert.equal(sm.trie.children, null);
});

test("resubscribe moves a callback between sets of paths, touching only what differs", () => {
    const sm = new StateManager({ a: 1, b: 1, c: 1 });
    const woke = [];
    const callback = () => woke.push("ran");
    const first = new Set(["a", "b"]);
    assert.equal(sm.resubscribe(callback, null, first), first);
    const bSet = sm.subscribers.get("b");
    const second = new Set(["b", "c"]);
    assert.equal(sm.resubscribe(callback, first, second), second);
    assert.equal(sm.subscribers.get("b"), bSet, "b was not touched");
    assert.equal(sm.subscribers.has("a"), false);
    sm.setValue("a", 2);
    assert.deepEqual(woke, []);
    sm.setValue("c", 2);
    assert.deepEqual(woke, ["ran"]);
    assert.equal(sm.resubscribe(callback, second, null), null);
    assert.equal(sm.subscribers.size, 0);
});

// ---- batch -------------------------------------------------------------------------------------

test("batch answers what fn answers and notifies once at the end, each callback a single time", () => {
    const sm = new StateManager({ a: 1, b: 1 });
    const woke = listen(sm, ["a", "b"]);
    const result = sm.batch(() => {
        sm.setValue("a", 2);
        sm.setValue("a", 3);
        sm.setValue("b", 2);
        assert.deepEqual(woke, [], "nothing yet");
        assert.equal(sm.peek("a"), 3, "reads see the writes at once");
        return "done";
    });
    assert.equal(result, "done");
    assert.deepEqual(woke.sort(), ["a", "b"]);
});

test("nested batches notify at the outermost exit", () => {
    const sm = new StateManager({ a: 1 });
    const woke = listen(sm, ["a"]);
    sm.batch(() => {
        sm.batch(() => sm.setValue("a", 2));
        assert.deepEqual(woke, []);
    });
    assert.deepEqual(woke, ["a"]);
});

test("a batch that throws still notifies what it wrote, then rethrows", () => {
    const sm = new StateManager({ a: 1 });
    const woke = listen(sm, ["a"]);
    const error = new Error("inside the batch");
    assert.throws(
        () =>
            sm.batch(() => {
                sm.setValue("a", 2);
                throw error;
            }),
        (thrown) => thrown === error,
    );
    assert.deepEqual(woke, ["a"]);
    assert.equal(sm.batchDepth, 0);
});

test("a batch that writes nothing runs no pass", () => {
    const changes = [];
    const sm = new StateManager({}, { onChange: (path) => changes.push(path) });
    assert.equal(sm.batch(() => 1), 1);
    assert.deepEqual(changes, []);
});

// ---- the notification pass ---------------------------------------------------------------------

test("computeds settle before bindings run: a binding sees derived state once, already current", () => {
    const sm = new StateManager({ n: 1 });
    sm.compute("double", () => sm.getState("n") * 2);
    const seen = [];
    bind(sm, () => [sm.getState("n"), sm.getState("double")], (value) => seen.push(value));
    sm.setValue("n", 2);
    assert.deepEqual(seen, [[1, 2], [2, 4]]);
});

test("a diamond of computeds settles on a consistent value, and a binding sees only that", () => {
    const sm = new StateManager({ x: 1 });
    sm.compute("a", () => sm.getState("x") + sm.getState("b", 0));
    sm.compute("b", () => sm.getState("x") * 10);
    assert.equal(sm.peek("a"), 11);
    const seen = [];
    bind(sm, () => sm.getState("a"), (value) => seen.push(value));
    sm.setValue("x", 2);
    assert.equal(sm.peek("b"), 20);
    assert.equal(sm.peek("a"), 22);
    assert.deepEqual(seen, [11, 22]);
});

test("bindings run in creation order, a plain callback (no order) first", () => {
    const sm = new StateManager({ a: 1, b: 1 });
    const log = [];
    const first = sm.stamp(() => log.push("first"));
    const second = sm.stamp(() => log.push("second"));
    sm.subscribe(["b"], second);
    sm.subscribe(["a"], first);
    sm.subscribe(["a"], () => log.push("plain"));
    sm.batch(() => {
        sm.setValue("b", 2);
        sm.setValue("a", 2);
    });
    assert.deepEqual(log, ["plain", "first", "second"]);
});

test("stamp numbers callbacks in creation order and answers the callback", () => {
    const sm = new StateManager();
    const one = () => { };
    const two = () => { };
    assert.equal(sm.stamp(one), one);
    sm.stamp(two);
    assert.ok(two.order > one.order);
});

test("a write made by a binding starts another pass", () => {
    const sm = new StateManager({ a: 1, b: 0 });
    const seen = [];
    sm.subscribe(["a"], () => sm.setValue("b", sm.peek("a") * 2));
    sm.subscribe(["b"], () => seen.push(sm.peek("b")));
    sm.setValue("a", 5);
    assert.deepEqual(seen, [10]);
});

test("a reactive loop is stopped with an error naming the path, and the manager goes on working", () => {
    const sm = new StateManager({ t: 0 });
    sm.compute("c", () => {
        sm.getState("t");
        return (sm.getState("c") ?? 0) + 1;
    });
    assert.throws(() => sm.setValue("t", 1), {
        name: "Error",
        message: 'StateManager: reactive loop detected while setting "c" (a binding or computed writes to a path it depends on)',
    });
    assert.equal(sm.batchDepth, 0);
    const woke = listen(sm, ["other"]);
    sm.setValue("other", 1);
    assert.deepEqual(woke, ["other"]);
});

test("a binding that writes what it reads is stopped as a loop too", () => {
    const sm = new StateManager({ n: 0 });
    sm.subscribe(["n"], () => sm.setValue("n", sm.peek("n") + 1));
    assert.throws(() => sm.setValue("n", 1), /reactive loop detected while setting "n"/);
});

test("a subscriber that throws does not stop the others; the first error reaches the writer after the pass", () => {
    const sm = new StateManager({ x: 1 });
    const ran = [];
    const first = new Error("first");
    sm.subscribe(["x"], () => {
        ran.push("a");
        throw first;
    });
    sm.subscribe(["x"], () => ran.push("b"));
    sm.subscribe(["x"], () => {
        ran.push("c");
        throw new Error("second");
    });
    const said = quietly("error", () => {
        assert.throws(() => sm.setValue("x", 2), (error) => error === first);
    });
    assert.deepEqual(ran, ["a", "b", "c"]);
    assert.equal(sm.peek("x"), 2);
    assert.deepEqual(said, [], "outside devMode nothing is said");
});

test("in devMode, several subscribers throwing in one pass are said on the console", () => {
    const sm = new StateManager({ x: 1 }, { devMode: true });
    const errors = [new Error("one"), new Error("two")];
    for (const error of errors) {
        sm.subscribe(["x"], () => {
            throw error;
        });
    }
    const said = quietly("error", () => {
        assert.throws(() => sm.setValue("x", 2), (error) => error === errors[0]);
    });
    assert.equal(said.length, 1);
    assert.equal(said[0][0], "StateManager: 2 subscribers threw during one change; rethrowing the first");
    assert.deepEqual(said[0][1], errors);
});

test("in devMode, a single subscriber's throw is rethrown without a word", () => {
    const sm = new StateManager({ x: 1 }, { devMode: true });
    sm.subscribe(["x"], () => {
        throw new Error("one");
    });
    const said = quietly("error", () => assert.throws(() => sm.setValue("x", 2), /one/));
    assert.deepEqual(said, []);
});

// ---- compute -----------------------------------------------------------------------------------

test("compute stores what its resolver answers and recomputes when what it read changes", () => {
    const sm = new StateManager({ items: [1, 2] });
    let runs = 0;
    sm.compute("count", () => (runs += 1, sm.getState("items").length));
    assert.equal(sm.peek("count"), 2);
    sm.setValue("items", [1, 2, 3]);
    assert.equal(sm.peek("count"), 3);
    sm.setValue("unrelated", 1);
    assert.equal(runs, 2);
});

test("compute refuses a path that is computed already", () => {
    const sm = new StateManager();
    sm.compute("c", () => 1);
    assert.throws(() => sm.compute("c", () => 2), { name: "Error", message: 'StateManager.compute: "c" is already computed' });
    assert.equal(sm.peek("c"), 1);
});

test("a computed's dispose stops it, leaves its last value, and frees the path", () => {
    const sm = new StateManager({ n: 1 });
    const dispose = sm.compute("double", () => sm.getState("n") * 2);
    dispose();
    sm.setValue("n", 5);
    assert.equal(sm.peek("double"), 2);
    sm.setValue("double", 7);
    assert.equal(sm.peek("double"), 7, "no longer computed: writable");
    sm.compute("double", () => sm.getState("n") * 3);
    assert.equal(sm.peek("double"), 15);
});

test("watch adds paths tracking cannot see, wildcards included", () => {
    const sm = new StateManager({ todos: [{ done: false }, { done: false }] });
    sm.compute("done", () => sm.peek("todos").filter((todo) => todo.done).length, { watch: ["todos.*.done"] });
    assert.equal(sm.peek("done"), 0);
    sm.setValue("todos.1.done", true);
    assert.equal(sm.peek("done"), 1);
});

test("a resolver that throws records the error, and wakes again when what it read before throwing changes", () => {
    const sm = new StateManager({ x: 1 });
    sm.compute("c", () => {
        const x = sm.getState("x");
        if (x < 0) throw new Error("negative");
        return x;
    });
    assert.doesNotThrow(() => sm.setValue("x", -1), "the error does not escape into the pass");
    assert.deepEqual(sm.peek("$async.errors").map((entry) => entry.message), ["negative"]);
    sm.setValue("x", 3);
    assert.equal(sm.peek("c"), 3);
});

test("a resolver that throws leaves a settled error at its path", () => {
    const sm = new StateManager({ x: 1 });
    const error = new Error("negative");
    sm.compute("c", () => {
        if (sm.getState("x") < 0) throw error;
        return sm.getState("x");
    });
    sm.setValue("x", -1);
    const value = sm.peek("c");
    assert.equal(sm.isSettled(value), true);
    assert.equal(value.error, error);
});

test("a computed whose first write fails throws and is not left registered", () => {
    const sm = new StateManager({ x: 1 });
    let runs = 0;
    const stop = sm.observe((path) => {
        if (path === "c") throw new Error("refused");
    });
    assert.throws(() => sm.compute("c", () => (runs += 1, sm.getState("x"))), /refused/);
    stop();
    sm.setValue("x", 2);
    assert.equal(runs, 1, "the failed computed listens to nothing");
    sm.compute("c", () => sm.getState("x") * 10);
    assert.equal(sm.peek("c"), 20);
});

test("a computed disposed by its own resolver listens to nothing after that run", () => {
    const sm = new StateManager({ x: 1 });
    let runs = 0;
    let dispose = null;
    dispose = sm.compute("c", () => {
        runs += 1;
        const x = sm.getState("x");
        if (x > 1) dispose();
        return x;
    });
    sm.setValue("x", 2);
    sm.setValue("x", 3);
    assert.equal(runs, 2);
    assert.equal(sm.subscribers.size, 0);
    sm.setValue("c", "free");
    assert.equal(sm.peek("c"), "free");
});

test("a computed disposed earlier in the pass that woke it does not run", () => {
    const sm = new StateManager({ x: 1 });
    let disposeSecond = null;
    let secondRuns = 0;
    sm.compute("first", () => {
        const x = sm.getState("x");
        if (x > 1) disposeSecond();
        return x;
    });
    disposeSecond = sm.compute("second", () => (secondRuns += 1, sm.getState("x")));
    sm.setValue("x", 2);
    assert.equal(secondRuns, 1, "woken with first, but disposed before its turn");
    assert.equal(sm.peek("second"), 1);
    assert.equal(sm.peek("first"), 2);
});

// ---- capture -----------------------------------------------------------------------------------

test("capture answers the value and the paths read, and restores an outer capture", () => {
    const sm = new StateManager({ a: 1, b: 2, c: 3 });
    let inner = null;
    const outer = sm.capture(() => {
        sm.getState("a");
        inner = sm.capture(() => sm.getState("b"));
        sm.getState("c");
        return "outer value";
    });
    assert.equal(inner.value, 2);
    assert.deepEqual([...inner.dependencies], ["b"]);
    assert.equal(outer.value, "outer value");
    assert.deepEqual([...outer.dependencies], ["a", "c"]);
    assert.equal(sm.activeDependencies, null);
});

test("capture lets a throw through and restores what was capturing", () => {
    const sm = new StateManager();
    const error = new Error("in capture");
    assert.throws(() => sm.capture(() => {
        throw error;
    }), (thrown) => thrown === error);
    assert.equal(sm.activeDependencies, null);
});

test("in devMode, capture warns about a function that read nothing, and only then", () => {
    const sm = new StateManager({ a: 1 }, { devMode: true });
    const reader = () => 1;
    const said = quietly("warn", () => {
        sm.capture(reader);
        sm.capture(() => sm.getState("a"));
    });
    assert.equal(said.length, 1);
    assert.match(said[0][0], /a reactive function read no state paths, so it will never re-run/);
    assert.equal(said[0][1], reader);
    assert.deepEqual(quietly("warn", () => new StateManager().capture(() => 1)), [], "outside devMode, nothing");
});

test("tryCapture answers the error with the paths read before it, and restores the outer capture", () => {
    const sm = new StateManager({ a: 1 });
    const error = new Error("half way");
    const failed = sm.tryCapture(() => {
        sm.getState("a");
        throw error;
    });
    assert.equal(failed.error, error);
    assert.equal(failed.value, undefined);
    assert.deepEqual([...failed.dependencies], ["a"]);
    assert.equal(sm.activeDependencies, null);
    const fine = sm.tryCapture(() => sm.getState("a"));
    assert.deepEqual(fine, { dependencies: new Set(["a"]), value: 1, error: null });
});

test("a binding reads what a settled value holds, a plain object included, and a write to its path wakes it", () => {
    const sm = new StateManager({ s: settled({ a: 1 }) });
    const seen = [];
    bind(sm, () => sm.getState("s").value.a, (value) => seen.push(value));
    assert.deepEqual(seen, [1]);
    sm.setValue("s", settled({ a: 2 }));
    assert.deepEqual(seen, [1, 2]);
    sm.setValue("s.value.a", 3);
    assert.deepEqual(seen, [1, 2, 3], "what it holds is tracked as any object is");
});

test("a binding reads a computed's settled error of a plain object, and the computed's next value wakes it", () => {
    const sm = new StateManager({ x: -1 });
    sm.compute("c", () => {
        if (sm.getState("x") < 0) throw { message: "negative" };
        return sm.getState("x");
    });
    const seen = [];
    bind(sm, () => {
        const c = sm.getState("c");
        return sm.isSettled(c) ? c.error.message : c;
    }, (value) => seen.push(value));
    assert.deepEqual(seen, ["negative"]);
    sm.setValue("x", 2);
    assert.deepEqual(seen, ["negative", 2]);
    sm.setValue("x", -2);
    assert.deepEqual(seen, ["negative", 2, "negative"]);
});

test("a binding reads through a frozen object, and a write beneath it wakes the binding", () => {
    const sm = new StateManager({ cfg: Object.freeze({ a: { b: 1 } }) });
    const seen = [];
    bind(sm, () => sm.getState("cfg").a.b, (value) => seen.push(value));
    assert.deepEqual(seen, [1]);
    sm.setValue("cfg.a.b", 2);
    assert.deepEqual(seen, [1, 2]);
});

test("a binding reads through a frozen array holding an object, and a write beneath it wakes the binding", () => {
    const sm = new StateManager({ list: Object.freeze([{ b: 1 }]) });
    const seen = [];
    bind(sm, () => sm.getState("list")[0].b, (value) => seen.push(value));
    assert.deepEqual(seen, [1]);
    sm.setValue("list.0.b", 2);
    assert.deepEqual(seen, [1, 2]);
});

test("a binding reads through a non-extensible object's property that is neither writable nor configurable, and a write beneath it wakes the binding", () => {
    const o = Object.preventExtensions(Object.defineProperty({}, "a", { value: { b: 1 }, enumerable: true, writable: false, configurable: false }));
    const sm = new StateManager({ o });
    const seen = [];
    bind(sm, () => sm.getState("o").a.b, (value) => seen.push(value));
    assert.deepEqual(seen, [1]);
    sm.setValue("o.a.b", 2);
    assert.deepEqual(seen, [1, 2]);
});
