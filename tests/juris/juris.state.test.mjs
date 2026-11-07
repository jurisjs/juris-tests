// juris.js, state and reactivity (REFERENCE.md, "The component api" State and Props, "Components
// and layouts", "One server instance, every request"): the state methods the instance hands on,
// clearState, async groups, assign's leaf-by-leaf writes, compute, bindState and the boundaries it
// offers errors to, refs and props, and the layout rules both renderers share (one tag per layout,
// text content, keys).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Juris, { FallbackSignal } from "juris/juris.js";
import { tick, capture } from "../support/juris-harness.mjs";
import { withSSR } from "../support/ssr-renderer.mjs";

const server = (options = {}) => new Juris(withSSR({ isServer: true, ...options }));
const browser = (options = {}) => new Juris({ isServer: false, ...options });

// Every value a binding on `read` applied, in order.
function watch(juris, read) {
    const seen = [];
    juris.bindState(read, (value) => seen.push(value));
    return seen;
}

// ---- the state methods -----------------------------------------------------------------------------

test("getState reads a path, or the default where nothing is", () => {
    const juris = server({ state: { user: { name: "Ada" } } });
    assert.equal(juris.getState("user.name"), "Ada");
    assert.equal(juris.getState("user.age", 36), 36);
});

test("setValue, updateState and deleteState write, and toRaw answers the plain value", () => {
    const juris = server();
    juris.setValue("todos", [{ done: false }]);
    juris.updateState("todos", (list) => [...list, { done: true }]);
    const list = juris.getState("todos");
    assert.deepEqual(juris.toRaw(list), [{ done: false }, { done: true }]);
    juris.deleteState("todos.0");
    assert.deepEqual(juris.toRaw(juris.getState("todos")), [{ done: true }]);
});

test("batch answers its function's value and wakes a reader once", () => {
    const juris = server({ state: { a: 1, b: 1 } });
    const seen = watch(juris, () => juris.getState("a") + juris.getState("b"));
    const answer = juris.batch(() => {
        juris.setValue("a", 2);
        juris.setValue("b", 2);
        return "done";
    });
    assert.equal(answer, "done");
    assert.deepEqual(seen, [2, 4]);
});

test("peek is an untracked read: a binding that peeks is not woken by the path", () => {
    const juris = server({ state: { a: 1, b: 1 } });
    const seen = watch(juris, () => `${juris.getState("a")}/${juris.peek("b")}`);
    juris.setValue("b", 2);
    assert.deepEqual(seen, ["1/1"]);
    juris.setValue("a", 2);
    assert.deepEqual(seen, ["1/1", "2/2"]);
});

test("clearState replaces the whole state with the next one, or with nothing", () => {
    const juris = server({ state: { a: 1 } });
    juris.clearState({ b: 2 });
    assert.equal(juris.getState("a"), undefined);
    assert.equal(juris.getState("b"), 2);
    juris.clearState();
    assert.deepEqual(JSON.parse(juris.serializeState()), {});
});

test("on a server clearState resets the async counters, each group's included", () => {
    const juris = server();
    const group = juris.api.group("panel");
    group.track(new Promise(() => { }));
    assert.equal(group.pending(), 1);
    juris.clearState({});
    assert.equal(group.pending(), 0);
});

test("in a browser clearState carries the in-flight counters over", async () => {
    const juris = browser();
    const group = juris.api.group("panel");
    let resolve;
    group.track(new Promise((r) => { resolve = r; }));
    juris.clearState({});
    assert.equal(group.pending(), 1);
    resolve();
    await tick();
    assert.equal(group.pending(), 0);
});

// ---- async groups -----------------------------------------------------------------------------------

test("a group needs a non-empty name", () => {
    const juris = server();
    for (const name of ["", undefined, 3]) {
        assert.throws(() => juris.api.group(name), { message: "Juris.group: name must be a non-empty string" });
    }
});

test("a group is frozen and carries its name", () => {
    const group = server().api.group("panel");
    assert.ok(Object.isFrozen(group));
    assert.equal(group.name, "panel");
});

test("a group counts a tracked promise until it settles, and hands its result through", async () => {
    const juris = browser();
    const group = juris.api.group("panel");
    let resolve;
    const tracked = group.track(new Promise((r) => { resolve = r; }));
    assert.equal(group.pending(), 1);
    assert.equal(group.ready(), false);
    assert.equal(juris.getState("$async.groups.panel.pending"), 1);
    resolve("rows");
    assert.equal(await tracked, "rows");
    assert.equal(group.pending(), 0);
    assert.equal(group.ready(), true);
});

test("a plain value or a settled one counts for nothing and comes back as it is", async () => {
    const juris = server({ services: { a: async () => 1 } });
    await juris.renderRequest({ preload: [["a"]], layout: { p: "x" } });
    const group = juris.api.group("panel");
    assert.equal(group.track(5), 5);
    const settledValue = juris.call("a");
    assert.equal(group.track(settledValue), settledValue);
    assert.equal(group.pending(), 0);
});

test("a rejection is counted off, recorded with when it happened, and thrown on", async (t) => {
    mock.timers.enable({ apis: ["Date"], now: 12_345 });
    t.after(() => mock.timers.reset());
    const juris = browser();
    const group = juris.api.group("panel");
    const failure = new Error("down");
    await assert.rejects(group.track(Promise.reject(failure)), (error) => error === failure);
    assert.equal(group.pending(), 0);
    assert.deepEqual(group.errors(), [{ message: "down", at: 12_345 }]);
});

test("reset clears a group's count and errors", async () => {
    const juris = browser();
    const group = juris.api.group("panel");
    group.track(new Promise(() => { }));
    await group.track(Promise.reject(new Error("x"))).catch(() => { });
    group.reset();
    assert.equal(group.pending(), 0);
    assert.deepEqual(group.errors(), []);
});

test("a group's reads are tracked", async () => {
    const juris = browser();
    const group = juris.api.group("panel");
    const seen = watch(juris, () => `${group.pending()}:${group.ready()}:${group.errors().length}`);
    await group.track(Promise.reject(new Error("x"))).catch(() => { });
    assert.deepEqual(seen, ["0:true:0", "1:false:0", "0:true:1"]);
});

test("two groups count apart", () => {
    const juris = browser();
    juris.api.group("a").track(new Promise(() => { }));
    assert.equal(juris.api.group("a").pending(), 1);
    assert.equal(juris.api.group("b").pending(), 0);
});

test("on a server a promise tracked before clearState moves nothing when it settles", async () => {
    const juris = server();
    const group = juris.api.group("panel");
    let resolve;
    let reject;
    group.track(new Promise((r) => { resolve = r; }));
    const failing = group.track(new Promise((_, r) => { reject = r; }));
    juris.clearState({});
    group.track(new Promise(() => { }));
    resolve();
    reject(new Error("the last request's"));
    await assert.rejects(failing, { message: "the last request's" });
    assert.equal(group.pending(), 1, "only this request's promise counts");
    assert.deepEqual(group.errors(), []);
});

// ---- assign -----------------------------------------------------------------------------------------

test("assign writes leaf by leaf: a reader of an unchanged leaf is not woken", () => {
    const juris = server({ state: { user: { name: "Ada", age: 36 } } });
    const names = watch(juris, () => juris.getState("user.name"));
    const ages = watch(juris, () => juris.getState("user.age"));
    juris.assign("user", { name: "Ada", age: 37 });
    assert.deepEqual(names, ["Ada"]);
    assert.deepEqual(ages, [36, 37]);
});

test("assign deletes the keys that disappeared", () => {
    const juris = server({ state: { user: { name: "Ada", nick: "a" } } });
    juris.assign("user", { name: "Ada" });
    assert.deepEqual(juris.toRaw(juris.getState("user")), { name: "Ada" });
});

test("assign is one batch: a reader of several changed leaves wakes once", () => {
    const juris = server({ state: { p: { x: 1, y: 1 } } });
    const seen = watch(juris, () => juris.getState("p.x") + juris.getState("p.y"));
    juris.assign("p", { x: 2, y: 3 });
    assert.deepEqual(seen, [2, 5]);
});

test("assign writes nothing for a value that is the same", () => {
    const juris = server({ state: { n: 1, m: Number.NaN } });
    const seen = watch(juris, () => `${juris.getState("n")}:${juris.getState("m")}`);
    juris.assign("n", 1);
    juris.assign("m", Number.NaN);
    assert.deepEqual(seen, ["1:NaN"]);
});

test("assign writes a value whole where its shape changed", () => {
    const juris = server({ state: { v: { a: 1 }, w: [1], x: "text" } });
    juris.assign("v", [1, 2]);
    juris.assign("w", { 0: 1 });
    juris.assign("x", { a: 1 });
    assert.deepEqual(juris.toRaw(juris.getState("v")), [1, 2]);
    assert.deepEqual(juris.toRaw(juris.getState("w")), { 0: 1 });
    assert.deepEqual(juris.toRaw(juris.getState("x")), { a: 1 });
    juris.assign("x", null);
    assert.equal(juris.getState("x"), null);
});

test("an array whose length changed is written whole, one of the same length leaf by leaf", () => {
    const juris = server({ state: { rows: ["a", "b"] } });
    const first = watch(juris, () => juris.getState("rows.0"));
    juris.assign("rows", ["a", "c"]);
    assert.deepEqual(first, ["a"], "same length: row 0 unchanged, not woken");
    juris.assign("rows", ["a", "c", "d"]);
    assert.deepEqual(first, ["a", "a"], "length changed: written whole");
    assert.deepEqual(juris.toRaw(juris.getState("rows")), ["a", "c", "d"]);
});

test("an object with a key no path can address is written whole, and arrives intact", () => {
    const juris = server({ state: { row: { a: 1 } } });
    const seen = watch(juris, () => juris.getState("row.a"));
    juris.assign("row", { a: 1, "x.y": 2 });
    assert.deepEqual(juris.toRaw(juris.getState("row")), { a: 1, "x.y": 2 });
    assert.equal(seen.length, 2, "written whole: the unchanged leaf's reader is woken");
    juris.assign("row", { a: 1, "": 3 });
    assert.deepEqual(juris.toRaw(juris.getState("row")), { a: 1, "": 3 });
    juris.assign("row", { a: 1 });
    assert.deepEqual(juris.toRaw(juris.getState("row")), { a: 1 }, "the previous value's own unaddressable key is gone too");
});

test("an own __proto__ key makes assign write the object whole, as data", () => {
    const juris = server({ state: { row: { a: 1 } } });
    juris.assign("row", JSON.parse('{"__proto__": {"polluted": true}, "a": 1}'));
    const row = juris.stateManager.peek("row");
    assert.ok(Object.hasOwn(row, "__proto__"));
    assert.equal(Object.getPrototypeOf(row), Object.prototype);
    assert.equal({}.polluted, undefined);
});

test("assign deletes a removed key named after an Object.prototype member", () => {
    const juris = server({ state: { o: { toString: "x", a: 1 } } });
    juris.assign("o", { a: 1 });
    assert.equal(Object.hasOwn(juris.stateManager.peek("o"), "toString"), false);
});

// ---- compute ----------------------------------------------------------------------------------------

test("compute keeps a derived value at its path, its resolver handed the api, until disposed", () => {
    const juris = server({ state: { n: 2 } });
    const handed = [];
    const dispose = juris.compute("double", (api) => { handed.push(api === juris.api); return api.getState("n") * 2; });
    assert.equal(juris.getState("double"), 4);
    juris.setValue("n", 3);
    assert.equal(juris.getState("double"), 6);
    dispose();
    juris.setValue("n", 4);
    assert.equal(juris.getState("double"), 6, "the last value stays");
    assert.ok(handed.every(Boolean));
});

test("a computed made inside a component is disposed with it: on a server, when the render ends", () => {
    const juris = server({ state: { n: 1 } });
    juris.registerComponent("C", (props, api) => {
        api.compute("double", (a) => a.getState("n") * 2);
        return { p: () => String(api.getState("double")) };
    });
    assert.equal(juris.renderToString({ C: {} }), "<p>2</p>");
    juris.setValue("n", 5);
    assert.equal(juris.getState("double"), 2);
    assert.doesNotThrow(() => juris.renderToString({ C: {} }), "the path is free to compute again");
});

// ---- bindState --------------------------------------------------------------------------------------

test("bindState applies its resolver's value, again on every change, until disposed", () => {
    const juris = server({ state: { n: 1 } });
    const seen = [];
    const dispose = juris.api.bindState(() => juris.getState("n"), (v) => seen.push(v));
    juris.setValue("n", 2);
    dispose();
    juris.setValue("n", 3);
    assert.deepEqual(seen, [1, 2]);
});

test("a binding disposed by another binding's apply, in the pass that would wake it, does not run again", () => {
    const juris = server({ state: { n: 1 } });
    const seen = [];
    let disposeSecond;
    juris.bindState(() => juris.getState("n"), (v) => { if (v === 2) disposeSecond(); });
    disposeSecond = juris.bindState(() => juris.getState("n"), (v) => seen.push(v));
    juris.setValue("n", 2);
    assert.deepEqual(seen, [1]);
});

test("a binding disposed inside the batch that changed its path does not run when the batch ends", () => {
    const juris = server({ state: { n: 1 } });
    const seen = [];
    const dispose = juris.bindState(() => juris.getState("n"), (v) => seen.push(v));
    juris.batch(() => {
        juris.setValue("n", 2);
        dispose();
    });
    assert.deepEqual(seen, [1]);
});

test("a binding whose promise resolves applies its value then", async () => {
    const juris = browser({ pendingDelay: 0 });
    const seen = [];
    juris.bindState(() => Promise.resolve("later"), (v) => seen.push(v));
    assert.deepEqual(seen, []);
    await tick();
    assert.deepEqual(seen, ["later"]);
});

test("onSlow is told when a binding's promise has been pending past pendingDelay (200 ms unless given), and when it settles", async (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    const juris = browser();
    const slow = [];
    const applied = [];
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    juris.bindState(() => promise, (v) => applied.push(v), (isSlow) => slow.push(isSlow));
    mock.timers.tick(199);
    assert.deepEqual(slow, []);
    mock.timers.tick(1);
    assert.deepEqual(slow, [true]);
    resolve("rows");
    await promise;
    await Promise.resolve();
    assert.deepEqual(slow, [true, false]);
    assert.deepEqual(applied, ["rows"]);
});

test("a promise that settles before pendingDelay never tells onSlow", async (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    const juris = browser({ pendingDelay: 50 });
    const slow = [];
    const promise = Promise.resolve("fast");
    juris.bindState(() => promise, () => { }, (isSlow) => slow.push(isSlow));
    await promise;
    await Promise.resolve();
    mock.timers.tick(100);
    assert.deepEqual(slow, []);
});

test("devMode warns about a reactive function that reads no state", async () => {
    const juris = server({ devMode: true, state: { n: 1 } });
    const said = await capture("warn", () => {
        juris.bindState(() => 5, () => { });
        juris.bindState(() => juris.getState("n"), () => { });
    });
    assert.equal(said.length, 1);
    assert.match(said[0][0], /^StateManager: a reactive function read no state paths, so it will never re-run/);
});

test("without devMode nothing is said about a function that reads no state", async () => {
    const said = await capture("warn", () => { server().bindState(() => 5, () => { }); });
    assert.deepEqual(said, []);
});

test("an error in a binding nobody handles is thrown, at bind time and out of a later write", () => {
    const juris = server({ state: { bad: false } });
    assert.throws(() => juris.bindState(() => { throw new Error("first"); }, () => { }), { message: "first" });
    juris.bindState(() => { if (juris.getState("bad")) throw new Error("later"); return 1; }, () => { });
    assert.throws(() => juris.setValue("bad", true), { message: "later" });
});

test("an error thrown by the apply is offered and thrown like the resolver's", () => {
    const juris = server({ state: { n: 1 } });
    assert.throws(() => juris.bindState(() => juris.getState("n"), () => { throw new Error("apply"); }), { message: "apply" });
});

test("a binding's owner is a boundary: its handler is told the phase, component and boundary", () => {
    const juris = server({ state: { bad: true } });
    const told = [];
    const owner = { name: "Panel", errorHandler: (error, info) => { told.push([error.message, info]); } };
    const seen = [];
    juris.bindState(() => { if (juris.getState("bad")) throw new Error("x"); return "ok"; }, (v) => seen.push(v), null, owner);
    assert.deepEqual(told, [["x", { phase: "binding", component: "Panel", boundary: "Panel" }]]);
    juris.setValue("bad", false);
    assert.deepEqual(seen, ["ok"], "the failed binding was still subscribed, and recovered");
});

test("the boundaries are asked from the owner outwards; false passes the error on", () => {
    const juris = server();
    const asked = [];
    const page = { name: "Page", errorHandler: () => { asked.push("Page"); } };
    const section = { name: "Section", parent: page, errorHandler: () => { asked.push("Section"); return false; } };
    const row = { name: "Row", parent: section };
    juris.bindState(() => { throw new Error("x"); }, () => { }, null, row);
    assert.deepEqual(asked, ["Section", "Page"]);
});

test("an error every boundary passes on is thrown as usual", () => {
    const juris = server();
    const owner = { name: "Row", errorHandler: () => false };
    assert.throws(() => juris.bindState(() => { throw new Error("nobody's"); }, () => { }, null, owner), { message: "nobody's" });
});

test("devMode says which boundary swallowed an error", async () => {
    const juris = server({ devMode: true });
    const page = { name: "Page", errorHandler: () => undefined };
    const row = { name: "Row", parent: page };
    const said = await capture("warn", () => {
        juris.bindState(() => { throw new Error("x"); }, () => { }, null, row);
        juris.bindState(() => { throw new Error("y"); }, () => { }, null, { errorHandler: () => undefined });
    });
    assert.equal(said[0][0], 'Juris: error in "Row" handled by "Page"');
    assert.equal(said[0][1].message, "x");
    assert.equal(said[1][0], 'Juris: error in "?" handled by "undefined"');
});

test("a boundary still mounting that answers a layout is signalled with a FallbackSignal", () => {
    const juris = server();
    const fallback = { p: "Something went wrong" };
    const boundary = { name: "Panel", mounting: true, errorHandler: () => fallback };
    const failure = new Error("x");
    assert.throws(
        () => juris.bindState(() => { throw failure; }, () => { }, null, boundary),
        (error) => error instanceof FallbackSignal && error.boundary === boundary && error.layout === fallback && error.cause === failure,
    );
});

test("a server instance's boundary answering a layout is signalled too", () => {
    const juris = server();
    const boundary = { name: "Panel", ssr: true, errorHandler: () => ({ p: "fb" }) };
    assert.throws(() => juris.bindState(() => { throw new Error("x"); }, () => { }, null, boundary), FallbackSignal);
});

test("a FallbackSignal travelling outwards is not offered to the boundaries it passes", () => {
    const juris = server();
    let asked = 0;
    const owner = { name: "Row", errorHandler: () => { asked += 1; } };
    const signal = new FallbackSignal({ name: "Outer" }, { p: "fb" }, new Error("x"));
    assert.throws(() => juris.bindState(() => { throw signal; }, () => { }, null, owner), (error) => error === signal);
    assert.equal(asked, 0);
    assert.equal(juris.resolveError(owner, signal, { phase: "binding" }), null);
});

test("a binding's rejected promise is offered to its owner's boundary as an async error, and recorded", async () => {
    const juris = browser({ pendingDelay: 0 });
    const told = [];
    const owner = { name: "Panel", errorHandler: (error, info) => { told.push([error.message, info]); } };
    juris.bindState(() => Promise.reject(new Error("late")), () => { }, null, owner);
    await tick();
    assert.deepEqual(told, [["late", { phase: "async", component: "Panel", boundary: "Panel" }]]);
    assert.deepEqual(juris.stateManager.peek("$async.errors").map((e) => e.message), ["late"]);
});

test("a rejected promise with no boundary is recorded and nothing else", async () => {
    const juris = browser({ pendingDelay: 0 });
    const seen = [];
    juris.bindState(() => Promise.reject(new Error("late")), (v) => seen.push(v));
    await tick();
    assert.deepEqual(seen, []);
    assert.deepEqual(juris.stateManager.peek("$async.errors").map((e) => e.message), ["late"]);
});

test("a disposed binding's promise settles into nothing", async () => {
    const juris = browser({ pendingDelay: 0 });
    const seen = [];
    let resolve;
    const dispose = juris.bindState(() => new Promise((r) => { resolve = r; }), (v) => seen.push(v));
    dispose();
    resolve("late");
    await tick();
    assert.deepEqual(seen, []);
    assert.equal(juris.stateManager.peek("$async.pending"), 0);
});

// ---- refs and props -------------------------------------------------------------------------------

test("a ref is frozen and names its path and default", () => {
    const juris = server();
    const ref = juris.api.ref("user.name", "anon");
    assert.ok(Object.isFrozen(ref));
    assert.equal(ref.path, "user.name");
    assert.equal(ref.defaultValue, "anon");
    assert.equal(juris.isRef(ref), true);
    for (const other of [null, undefined, "user.name", { path: "user.name" }, () => { }]) assert.equal(juris.isRef(other), false);
});

test("prop reads a ref's path, falling back to the ref's default, then the prop's", () => {
    const juris = server({ state: { user: { name: "Ada" } } });
    assert.equal(juris.api.prop(juris.api.ref("user.name")), "Ada");
    assert.equal(juris.api.prop(juris.api.ref("user.age", 36), 0), 36);
    assert.equal(juris.api.prop(juris.api.ref("user.age"), 0), 0);
});

test("prop calls a getter, and a getter answering nothing gives the default", () => {
    const juris = server();
    assert.equal(juris.api.prop(() => "value", "default"), "value");
    assert.equal(juris.api.prop(() => null, "default"), "default");
    assert.equal(juris.api.prop(() => undefined, "default"), "default");
});

test("prop hands a plain value back, the default only for null or undefined", () => {
    const juris = server();
    assert.equal(juris.api.prop("text", "d"), "text");
    assert.equal(juris.api.prop(0, "d"), 0);
    assert.equal(juris.api.prop(false, "d"), false);
    assert.equal(juris.api.prop("", "d"), "");
    assert.equal(juris.api.prop(null, "d"), "d");
    assert.equal(juris.api.prop(undefined, "d"), "d");
});

test("prop hands a promise back as it is", () => {
    const juris = server();
    const promise = Promise.resolve(1);
    assert.equal(juris.api.prop(promise), promise);
    assert.equal(juris.api.prop(() => promise), promise);
});

test("inside a binding a ref's or a getter's read is tracked", () => {
    const juris = server({ state: { qty: 1 } });
    const viaRef = watch(juris, () => juris.api.prop(juris.api.ref("qty")));
    const viaGetter = watch(juris, () => juris.api.prop(() => juris.getState("qty")));
    juris.setValue("qty", 2);
    assert.deepEqual(viaRef, [1, 2]);
    assert.deepEqual(viaGetter, [1, 2]);
});

test("a function prop is a getter unless its name starts with on", () => {
    const juris = server();
    assert.equal(juris.isGetterProp("label", () => "x"), true);
    assert.equal(juris.isGetterProp("onclick", () => { }), false);
    assert.equal(juris.isGetterProp("onPick", () => { }), false);
    assert.equal(juris.isGetterProp("label", "x"), false);
});

// ---- layouts ------------------------------------------------------------------------------------------

test("a component cannot return a list of layouts", () => {
    const juris = server();
    juris.registerComponent("List", () => [{ li: "a" }, { li: "b" }]);
    assert.throws(() => juris.renderToString({ List: {} }), {
        message: "Juris: a layout is one { tag: content } object; a component cannot return an array:"
            + " wrap the children in an element",
    });
});

test("a string or number as content is its text, null an empty element", () => {
    const juris = server();
    assert.equal(juris.renderToString({ p: "Nothing here." }), "<p>Nothing here.</p>");
    assert.equal(juris.renderToString({ p: 7 }), "<p>7</p>");
    assert.equal(juris.renderToString({ p: null }), "<p></p>");
    assert.deepEqual(juris.normalizeContent(undefined), {});
    assert.deepEqual(juris.normalizeContent("x"), { textContent: "x" });
    const content = { id: "a" };
    assert.equal(juris.normalizeContent(content), content);
});

test("text layouts: null, booleans and undefined draw nothing; numbers and strings draw themselves", () => {
    const juris = server();
    assert.equal(juris.renderToString({ p: { children: [null, true, false, 0, "a"] } }), "<p>0a</p>");
    for (const text of [null, undefined, true, false, 0, "a"]) assert.equal(juris.isTextLayout(text), true, String(text));
    for (const other of [{ p: "x" }, () => "x"]) assert.equal(juris.isTextLayout(other), false);
    assert.equal(juris.textOf(undefined), "");
    assert.equal(juris.textOf(0), "0");
});

test("a function in a child position is a seat", () => {
    const juris = server({ state: { n: 1 } });
    assert.equal(juris.isSeatLayout(() => ({ p: "x" })), true);
    assert.equal(juris.isSeatLayout({ p: "x" }), false);
    assert.equal(juris.renderToString({ div: { children: [() => ({ b: String(juris.getState("n")) })] } }), "<div><b>1</b></div>");
});

test("a layout's key is read from its content; text and seats have none", () => {
    const juris = server();
    assert.equal(juris.getKey({ li: { key: 3, textContent: "x" } }), 3);
    assert.equal(juris.getKey({ li: "x" }), undefined);
    assert.equal(juris.getKey("text"), undefined);
    assert.equal(juris.getKey(null), undefined);
    assert.equal(juris.getKey(() => ({ li: { key: 1 } })), undefined);
});

test("a component's key is copied onto its root, unless the root has a key of its own", () => {
    const juris = server();
    juris.registerComponent("Row", (props) => ({ li: props.label }));
    juris.registerComponent("OwnKey", () => ({ li: { key: "own", textContent: "x" } }));
    juris.registerComponent("Text", () => "just text");
    assert.equal(juris.renderToString({ Row: { key: 3, label: "x" } }), '<li data-key="3">x</li>');
    assert.equal(juris.renderToString({ OwnKey: { key: 3 } }), '<li data-key="own">x</li>');
    assert.equal(juris.renderToString({ Text: { key: 3 } }), "just text");
    assert.equal(juris.renderToString({ Row: { label: "y" } }), "<li>y</li>");
});

test("withKey leaves a layout alone with no key, a text or a seat, and keys any other root", () => {
    const juris = server();
    const layout = { li: "x" };
    const seat = () => layout;
    assert.equal(juris.withKey(layout, undefined), layout);
    assert.equal(juris.withKey("text", 1), "text");
    assert.equal(juris.withKey(seat, 1), seat);
    const keyed = { li: { key: 2 } };
    assert.equal(juris.withKey(keyed, 1), keyed);
    assert.deepEqual(juris.withKey(layout, 1), { li: { textContent: "x", key: 1 } });
    assert.deepEqual(layout, { li: "x" }, "the given layout is not changed");
});
