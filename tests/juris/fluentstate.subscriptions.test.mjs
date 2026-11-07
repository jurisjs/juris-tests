// fluentstate.js, subscriptions: subscribe / watch / onChange (the path, beneath it unless deep is
// false, above it; immediate; once), unsubscribe, writes made through $.x that no fluent subscriber
// hears, a subscriber that throws, batch (each subscription once at its end), debug and the hooks
// that end it all. Reading and writing are in fluentstate.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import { HeadlessManager } from "juris/headless.js";
import { createFluentStateHeadless } from "juris/fluentstate.js";

// The 0.91 setup: FluentState as an autoInit headless component.
function fluent(state = {}) {
    const juris = new Juris({
        isServer: true,
        state,
        features: { headless: HeadlessManager },
        headlessComponents: { fluentState: { fn: createFluentStateHeadless, options: { autoInit: true } } },
    });
    return { juris, fs: juris.api.fluentState, $: juris.api.fluentState.getFluentStates() };
}

// A callback that records each call as [label, value, previous, changedPath], values copied as they were.
function recorder(heard, label) {
    const copy = (value) => (value === undefined ? undefined : structuredClone(value));
    return (value, previous, changed) => heard.push([label, copy(value), copy(previous), changed]);
}

// console.error while `fn` runs, each call's arguments.
function errored(fn) {
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args);
    try {
        fn();
    } finally {
        console.error = original;
    }
    return lines;
}

// ---- what a subscription hears -------------------------------------------------------------------

test("subscribe hears a write to its path with (value, previous, changedPath)", () => {
    const { juris, $ } = fluent({ user: { name: "Ada" } });
    const heard = [];
    $.user.subscribe(recorder(heard, "user"));
    juris.setValue("user", { name: "Lin" });
    assert.deepEqual(heard, [["user", { name: "Lin" }, { name: "Ada" }, "user"]]);
});

test("subscribe hears a write beneath its path, with the path's own value and no previous", () => {
    const { $ } = fluent({ user: { name: "Ada" } });
    const heard = [];
    $.user.subscribe(recorder(heard, "user"));
    $.user.name = "Grace";
    $.user.address.city = "X";
    assert.deepEqual(heard, [
        ["user", { name: "Grace" }, undefined, "user.name"],
        ["user", { name: "Grace", address: { city: "X" } }, undefined, "user.address.city"],
    ]);
});

test("subscribe hears a write above its path, with the path's own value", () => {
    const { juris, $ } = fluent({ app: { user: { name: "Ada" } } });
    const heard = [];
    $.app.user.subscribe(recorder(heard, "app.user"));
    juris.setValue("app", { user: { name: "Lin" } });
    juris.clearState({ app: { user: { name: "New" } } });
    assert.deepEqual(heard, [
        ["app.user", { name: "Lin" }, undefined, "app"],
        ["app.user", { name: "New" }, undefined, ""],
    ]);
});

test("a subscription is not woken by a sibling, a stranger or a path that merely starts like it", () => {
    const { juris, $ } = fluent({ a: { b: 1 }, ab: 1 });
    const heard = [];
    $.a.subscribe(recorder(heard, "a"));
    juris.setValue("ab", 2);
    juris.setValue("other", 1);
    juris.setValue("a2", 1);
    assert.deepEqual(heard, []);
});

test("deep: false hears its own path and above, not beneath", () => {
    const { juris, $ } = fluent({ app: { user: { name: "Ada" } } });
    const heard = [];
    $.app.user.subscribe(recorder(heard, "shallow"), { deep: false });
    $.app.user.name = "Grace";
    juris.setValue("app.user", { name: "Lin" });
    juris.setValue("app", { user: { name: "Top" } });
    assert.deepEqual(heard, [
        ["shallow", { name: "Lin" }, { name: "Grace" }, "app.user"],
        ["shallow", { name: "Top" }, undefined, "app"],
    ]);
});

test("a root subscription hears only a write to the root", () => {
    const { juris, $ } = fluent({ a: 1 });
    const heard = [];
    $.subscribe(recorder(heard, "root"));
    juris.setValue("a", 2);
    juris.setValue("b.c", 1);
    juris.clearState({ z: 1 });
    assert.deepEqual(heard, [["root", { z: 1 }, undefined, ""]]);
});

test("a write anyone makes is heard: setValue, updateState, deleteState and a fluent write", () => {
    const { juris, $ } = fluent({ n: { v: 1 } });
    const heard = [];
    $.n.subscribe(recorder(heard, "n"));
    juris.setValue("n.v", 2);
    juris.updateState("n.v", (v) => v + 1);
    juris.deleteState("n.v");
    $.n.w = 1;
    assert.deepEqual(heard.map(([, , , changed]) => changed), ["n.v", "n.v", "n.v", "n.w"]);
    const deleted = heard[2];
    assert.deepEqual(deleted, ["n", {}, undefined, "n.v"]);
});

test("a subscription on the deleted path itself is told undefined and what was there", () => {
    const { juris, $ } = fluent({ user: { name: "Ada" } });
    const heard = [];
    $.user.subscribe(recorder(heard, "user"));
    juris.deleteState("user");
    assert.deepEqual(heard, [["user", undefined, { name: "Ada" }, "user"]]);
});

test("$.x writes reach no fluent subscriber, and later writes are heard again", () => {
    const { juris, $ } = fluent({ user: { name: "Ada" }, list: [1] });
    const heard = [];
    $.user.subscribe(recorder(heard, "user"));
    $.list.subscribe(recorder(heard, "list"));
    $.x.user.name = "quiet";
    $.x.user.update({ age: 1 });
    delete $.x.user.age;
    $.x.list.push(2);
    $.x.user.clear();
    assert.deepEqual(heard, []);
    assert.equal(juris.getState("user"), null);
    $.user = { name: "loud" };
    assert.deepEqual(heard, [["user", { name: "loud" }, null, "user"]]);
});

test("a $.x write that throws leaves later writes heard", () => {
    const { juris, $ } = fluent({ user: { name: "Ada" } });
    juris.stateManager.compute("total", () => 1);
    const heard = [];
    $.user.subscribe(recorder(heard, "user"));
    assert.throws(() => {
        $.x.total = 2;
    }, /"total" is a computed path/);
    assert.throws(() => {
        delete $.x.total;
    }, /"total" is a computed path/);
    $.user.name = "Grace";
    assert.equal(heard.length, 1);
});

// ---- the options -------------------------------------------------------------------------------

test("immediate calls subscribe at once with the path's value; watch and onChange never are", () => {
    const { $ } = fluent({ user: { name: "Ada" } });
    const heard = [];
    $.user.subscribe(recorder(heard, "subscribe"), { immediate: true });
    $.user.watch(recorder(heard, "watch"), { immediate: true });
    $.user.onChange(recorder(heard, "onChange"), { immediate: true });
    assert.deepEqual(heard, [["subscribe", { name: "Ada" }, undefined, "user"]]);
    $.user.name = "Grace";
    assert.deepEqual(heard.slice(1).map(([label]) => label), ["subscribe", "watch", "onChange"]);
});

test("once: the first call stops it, an immediate one included", () => {
    const { $ } = fluent();
    const heard = [];
    $.box.subscribe(recorder(heard, "once"), { once: true });
    $.box.subscribe(recorder(heard, "immediate once"), { once: true, immediate: true });
    $.box.v = 1;
    $.box.v = 2;
    assert.deepEqual(heard.map(([label, value]) => [label, value]), [
        ["immediate once", undefined],
        ["once", { v: 1 }],
    ]);
});

test("subscribe refuses a callback that is not a function, naming the method", () => {
    const { $ } = fluent();
    assert.throws(() => $.a.subscribe("no"), { name: "TypeError", message: "FluentState.subscribe: callback is a function (value, previous, changedPath)" });
    assert.throws(() => $.a.watch(), { name: "TypeError", message: "FluentState.watch: callback is a function (value, previous, changedPath)" });
    assert.throws(() => $.a.onChange(null), { name: "TypeError", message: "FluentState.onChange: callback is a function (value, previous, changedPath)" });
});

// ---- stopping ----------------------------------------------------------------------------------

test("the function a subscription answers stops it; unsubscribe takes that function or the callback", () => {
    const { $, fs } = fluent();
    const heard = [];
    const stop = $.a.subscribe(recorder(heard, "by stop"));
    const callback = recorder(heard, "by callback");
    $.a.watch(callback);
    stop();
    assert.equal($.a.unsubscribe(stop), false, "stopped already");
    assert.equal($.other.unsubscribe(callback), true, "any fluent object's unsubscribe");
    assert.equal($.a.unsubscribe(callback), false);
    assert.equal($.a.unsubscribe(() => { }), false);
    $.a = 1;
    assert.deepEqual(heard, []);
    assert.equal(fs.debug.getStats().subscriptions, 0);
});

test("unsubscribe by stop function finds the entry among several", () => {
    const { $ } = fluent();
    const heard = [];
    $.a.subscribe(recorder(heard, "a"));
    const stopB = $.b.subscribe(recorder(heard, "b"));
    assert.equal($.unsubscribe(stopB), true);
    $.a = 1;
    $.b = 1;
    assert.deepEqual(heard.map(([label]) => label), ["a"]);
});

test("a subscriber that throws is said on the console, and the others still run", () => {
    const { $ } = fluent();
    const heard = [];
    const error = new Error("subscriber");
    $.a.subscribe(() => {
        throw error;
    });
    $.a.subscribe(recorder(heard, "after"));
    const lines = errored(() => assert.doesNotThrow(() => {
        $.a = 1;
    }));
    assert.deepEqual(lines, [["FluentState: a subscriber threw", error]]);
    assert.equal(heard.length, 1);
});

// ---- batch -------------------------------------------------------------------------------------

test("batch is one pass: each subscription once at its end, for the first written path it hears", () => {
    const { juris, $, fs } = fluent({ a: { b: 0 } });
    const heard = [];
    $.a.subscribe(recorder(heard, "a"));
    $.q.subscribe(recorder(heard, "q"));
    let coreRuns = 0;
    juris.stateManager.subscribe(["a.b", "a.c"], () => (coreRuns += 1));
    const result = fs.batch(() => {
        $.a.b = 1;
        $.a.c = 2;
        $.a.b = 3;
        $.z = 1;
        assert.deepEqual(heard, [], "nothing until the end");
        return "done";
    });
    assert.equal(result, "done");
    assert.deepEqual(heard, [["a", { b: 3, c: 2 }, undefined, "a.b"]]);
    assert.equal(coreRuns, 1, "the core's subscribers in one pass too");
});

test("while a batch runs, getStats says so and counts the paths waiting", () => {
    const { $, fs } = fluent();
    $.a.subscribe(() => { });
    let inside = null;
    fs.batch(() => {
        $.a = 1;
        $.b = 1;
        $.a = 2;
        inside = fs.debug.getStats();
    });
    assert.deepEqual(inside, { subscriptions: 1, cache: 0, batchActive: true, batchQueueSize: 2 });
    assert.deepEqual(fs.debug.getStats(), { subscriptions: 1, cache: 0, batchActive: false, batchQueueSize: 0 });
});

test("a batch inside a batch joins it: one call at the outer end", () => {
    const { $, fs } = fluent({ a: { b: 0 } });
    const heard = [];
    $.a.subscribe(recorder(heard, "a"));
    const inner = fs.batch(() => {
        const value = fs.batch(() => {
            $.a.b = 1;
            return "inner";
        });
        assert.deepEqual(heard, []);
        return value;
    });
    assert.equal(inner, "inner");
    assert.equal(heard.length, 1);
});

test("a batch that throws still delivers what it wrote, then rethrows", () => {
    const { $, fs } = fluent();
    const heard = [];
    $.a.subscribe(recorder(heard, "a"));
    const error = new Error("in batch");
    assert.throws(() => fs.batch(() => {
        $.a = 1;
        throw error;
    }), (thrown) => thrown === error);
    assert.deepEqual(heard, [["a", 1, undefined, "a"]]);
    assert.equal(fs.debug.getStats().batchActive, false);
});

test("a batch that writes nothing calls nobody", () => {
    const { $, fs } = fluent();
    const heard = [];
    $.a.subscribe(recorder(heard, "a"));
    assert.equal(fs.batch(() => "nothing written"), "nothing written");
    assert.deepEqual(heard, []);
});

test("$.x writes inside a batch are not delivered at its end", () => {
    const { $, fs } = fluent();
    const heard = [];
    $.a.subscribe(recorder(heard, "a"));
    fs.batch(() => {
        $.x.a = 1;
    });
    assert.deepEqual(heard, []);
});

test("a once subscription in a batch is called once at its end", () => {
    const { $, fs } = fluent();
    const heard = [];
    $.a.subscribe(recorder(heard, "once"), { once: true });
    fs.batch(() => {
        $.a = 1;
        $.a = 2;
    });
    $.a = 3;
    assert.deepEqual(heard, [["once", 2, undefined, "a"]]);
});

// ---- debug and the hooks -------------------------------------------------------------------------

test("getStats counts subscribed paths; clearCache changes nothing; clearSubscriptions ends them all", () => {
    const { $, fs } = fluent();
    const heard = [];
    $.a.subscribe(recorder(heard, "a1"));
    $.a.watch(recorder(heard, "a2"));
    $.b.subscribe(recorder(heard, "b"));
    assert.deepEqual(fs.debug.getStats(), { subscriptions: 2, cache: 0, batchActive: false, batchQueueSize: 0 });
    assert.equal(fs.debug.clearCache(), undefined);
    assert.equal(fs.debug.getStats().subscriptions, 2);
    fs.debug.clearSubscriptions();
    assert.equal(fs.debug.getStats().subscriptions, 0);
    $.a = 1;
    $.b = 1;
    assert.deepEqual(heard, []);
});

test("onUnregister stops observing the state and ends every subscription", () => {
    const { juris, $ } = fluent();
    const heard = [];
    $.a.subscribe(recorder(heard, "a"));
    const observers = juris.stateManager.observers.size;
    juris.headlessManager.cleanup();
    assert.equal(juris.stateManager.observers.size, observers - 1);
    juris.setValue("a", 1);
    assert.deepEqual(heard, []);
    assert.equal(juris.api.fluentState, undefined);
});

test("a fluent state made again starts with no subscriptions of the last one", () => {
    const { juris, $ } = fluent();
    const heard = [];
    $.a.subscribe(recorder(heard, "old"));
    juris.headlessManager.reinitialize("fluentState");
    const fresh = juris.api.fluentState;
    assert.equal(fresh.debug.getStats().subscriptions, 0);
    fresh.getFluentStates().a.subscribe(recorder(heard, "new"));
    juris.setValue("a", 1);
    assert.deepEqual(heard.map(([label]) => label), ["new"]);
});
