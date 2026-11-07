// devtools.js, values: how every value the protocol sends is encoded as JSON (D8), one case per row
// of REFERENCE.md's values table, through `state` and `component`; that nothing read for the panel
// is ever a dependency; that an answer over 1 MiB is encoded again shallower and says so; that a
// private root is counted, never sent (D14); and node handles. On the stand-in DOM, in a page of
// support/devtools-page.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { settled, settledError } from "juris/state-manager.js";
import { FakeElement, FakeText, FakeFragment } from "../support/dom.mjs";
import { HTML } from "../fixtures/elements.mjs";
import { devtoolsPage, withDevtoolsPage, inspect, host } from "../support/devtools-page.mjs";

// The state at `path`, as `state` answers it, with these params.
const stateOf = (value, params = {}) => {
    const inspected = inspect({ state: { v: value } });
    try {
        return inspected.ask("state", { path: "v", ...params });
    } finally {
        inspected.done();
    }
};
const page = (fn) => withDevtoolsPage(devtoolsPage(), fn);

test("values: JSON values are themselves", () => page(() => {
    const value = { s: "text", n: 1.5, t: true, f: false, z: null, list: [1, "two"], nested: { a: { b: 1 } } };
    assert.deepEqual(stateOf(value), value);
    assert.deepEqual(stateOf(0), 0);
    assert.deepEqual(stateOf("x"), "x");
}));

test("values: undefined, NaN, ±Infinity, a bigint and a symbol are named", () => page(() => {
    assert.deepEqual(stateOf([undefined, NaN, Infinity, -Infinity, 10n, Symbol("tag")]), [
        { $: "undefined" }, { $: "number", text: "NaN" }, { $: "number", text: "Infinity" }, { $: "number", text: "-Infinity" },
        { $: "bigint", text: "10" }, { $: "symbol", text: "Symbol(tag)" },
    ]);
    assert.deepEqual(stateOf(undefined), { $: "undefined" }, "a path that holds nothing");
}));

test("values: a string longer than 1,000 characters is its head and its length", () => page(() => {
    assert.deepEqual(stateOf("a".repeat(1000)), "a".repeat(1000));
    assert.deepEqual(stateOf("b".repeat(1001)), { $: "string", head: "b".repeat(1000), length: 1001 });
}));

test("values: a function is its name and kind, never its source; a component's props say getter or listener", () => page(() => {
    function named() { return "secret source"; }
    assert.deepEqual(stateOf({ named, anonymous: [() => { }][0] }), { named: { $: "function", name: "named", kind: "function" }, anonymous: { $: "function", name: "", kind: "function" } });
    const { juris, ask, done } = inspect();
    juris.registerComponent("Row", (props, api) => ({ li: { textContent: () => api.prop(props.label), onclick: props.onPick } }));
    juris.render(host(), { Row: { label: () => "x", onPick: () => { }, nested: { inner: () => { } } } });
    const { props } = ask("component", { id: juris.findComponents("Row")[0].id });
    assert.deepEqual(props, {
        label: { $: "function", name: "label", kind: "getter" },
        onPick: { $: "function", name: "onPick", kind: "listener" },
        nested: { inner: { $: "function", name: "inner", kind: "function" } },
    });
    assert.ok(!JSON.stringify(props).includes("secret"));
    done();
}));

test("values: a tracking proxy is sent as its target, and reading it adds no dependency", () => page(() => {
    const { juris, ask, done } = inspect();
    juris.setValue("user", { name: "Ada", tags: ["x"] });
    let proxy = null;
    juris.registerComponent("Badge", (props, api) => ({ b: { title: () => { proxy ??= api.getState("user"); return "x"; } } }));
    juris.registerComponent("Holder", (props) => ({ p: { textContent: "x" } }));
    juris.render(host(), { Badge: {} });
    assert.notEqual(proxy, juris.stateManager.peek("user"), "a tracking proxy");
    juris.render(host(), { Holder: { user: proxy } });
    const subscribed = juris.stateManager.subscribers.size;
    assert.deepEqual(ask("component", { id: juris.findComponents("Holder")[0].id }).props, { user: { name: "Ada", tags: ["x"] } });
    assert.equal(juris.stateManager.subscribers.size, subscribed);
    done();
}));

test("values: a DOM node is a node handle", () => page(() => {
    const element = new FakeElement("section", HTML);
    element.setAttribute("id", "main");
    const text = new FakeText("t");
    const [a, b, again] = stateOf([element, text, element]);
    assert.deepEqual(a, { $: "node", ref: a.ref, tag: "section", id: "main" });
    assert.deepEqual(b, { $: "node", ref: b.ref, tag: "#text", id: null });
    assert.deepEqual(again, a, "a node met again is its handle again, not a cycle");
    // Another kind of node is named by its nodeName (the stand-in's fragment has none).
    const fragment = stateOf(new FakeFragment());
    assert.deepEqual({ ...fragment, ref: 0 }, { $: "node", ref: 0, tag: "", id: null });
}));

test("values: a settled value, a settled error, a promise and a ref", () => page(() => {
    assert.deepEqual(stateOf([settled({ a: 1 }), settledError(new TypeError("bad")), Promise.resolve(1), { then() { } }]), [
        { $: "settled", value: { a: 1 } }, { $: "settled", error: { name: "TypeError", message: "bad" } }, { $: "promise" }, { $: "promise" },
    ]);
    const { juris, ask, done } = inspect();
    juris.setValue("r", juris.ref("user.name", "nobody"));
    assert.deepEqual(ask("state", { path: "r" }), { $: "ref", path: "user.name" });
    done();
}));

test("values: a Date, a Map, a Set and an Error", () => page(() => {
    assert.deepEqual(stateOf([new Date(Date.UTC(2026, 10, 5)), new Date(NaN), new Map([["k", { v: 1 }], [{ o: 1 }, "x"]]), new Set([1, "two"]), new RangeError("far")]), [
        { $: "date", iso: "2026-11-05T00:00:00.000Z" },
        { $: "date", iso: null },
        { $: "map", size: 2, entries: [["k", { v: 1 }], [{ o: 1 }, "x"]] },
        { $: "set", size: 2, items: [1, "two"] },
        { $: "error", name: "RangeError", message: "far" },
    ]);
    const big = stateOf(new Map(Array.from({ length: 150 }, (_, i) => [i, i])));
    assert.equal(big.entries.length, 101);
    assert.deepEqual(big.entries[100], { $: "more", path: "v", length: 150 });
    const set = stateOf(new Set(Array.from({ length: 101 }, (_, i) => i)));
    assert.deepEqual(set.items.at(-1), { $: "more", path: "v", length: 101 });
}));

test("values: another class's instance is its class's name and its own enumerable fields", () => page(() => {
    class Point { constructor() { this.x = 1; this.y = 2; } }
    assert.deepEqual(stateOf(new Point()), { $: "instance", of: "Point", entries: { x: 1, y: 2 } });
    const odd = Object.create({ constructor: "not a function" });
    odd.z = 3;
    assert.deepEqual(stateOf(odd), { $: "instance", of: "Object", entries: { z: 3 } });
    assert.deepEqual(stateOf(Object.assign(Object.create(null), { a: 1 })), { a: 1 }, "a null prototype is a plain object");
}));

test("values: an array is itself up to count items from from, then more; below the top, 100", () => page(() => {
    const list = Array.from({ length: 250 }, (_, i) => i);
    const first = stateOf(list);
    assert.equal(first.length, 101);
    assert.deepEqual(first.slice(98), [98, 99, { $: "more", path: "v", length: 250 }]);
    assert.deepEqual(stateOf(list, { from: 240, count: 20 }), [240, 241, 242, 243, 244, 245, 246, 247, 248, 249]);
    assert.deepEqual(stateOf(list, { from: 100, count: 2 }), [100, 101, { $: "more", path: "v", length: 250 }]);
    const nested = stateOf({ inner: list }, { count: 5 });
    assert.equal(nested.inner.length, 101, "count is the top's");
    assert.deepEqual(stateOf([1, , 3]), [1, { $: "undefined" }, 3], "a hole is undefined");
}));

test("values: an object is its first 200 own keys, then more under …; a key named $ or __proto__ stays data", () => page(() => {
    const wide = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`k${i}`, i]));
    const sent = stateOf(wide);
    assert.equal(Object.keys(sent).length, 201);
    assert.deepEqual(sent["…"], { $: "more", path: "v", keys: 250 });
    assert.deepEqual(stateOf({ $: "node", ref: 1 }), { $: "object", entries: { $: "node", ref: 1 } }, "an object of the state's own shaped like a special value is wrapped");
    const protoKey = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}');
    const decoded = stateOf(protoKey);
    assert.deepEqual(Object.keys(decoded), ["__proto__", "safe"]);
    assert.equal(({}).polluted, undefined);
    // An accessor is named, never called.
    let called = false;
    const accessor = Object.defineProperty({}, "computed", { enumerable: true, get: function total() { called = true; return 1; } });
    assert.deepEqual(stateOf(accessor), { computed: { $: "function", name: "total", kind: "getter" } });
    const setterOnly = Object.defineProperty({}, "w", { enumerable: true, set() { } });
    assert.deepEqual(stateOf(setterOnly), { w: { $: "function", name: "", kind: "getter" } });
    assert.equal(called, false);
}));

test("values: an object's keys past the first 200 are paged as an array's items are, from and count", () => page(() => {
    const wide = Object.fromEntries(Array.from({ length: 450 }, (_, i) => [`k${i}`, i]));
    const first = stateOf(wide);
    assert.deepEqual(first["\u2026"], { $: "more", path: "v", keys: 450 });
    const second = stateOf(wide, { from: 200 });
    assert.deepEqual(Object.keys(second).slice(0, 2), ["k200", "k201"]);
    assert.equal(Object.keys(second).length, 201);
    assert.deepEqual(second["\u2026"], { $: "more", path: "v", keys: 450 });
    const last = stateOf(wide, { from: 400 });
    assert.deepEqual(Object.keys(last), Array.from({ length: 50 }, (_, i) => `k${400 + i}`), "the rest, and no more");
    assert.deepEqual(Object.keys(stateOf(wide, { from: 10, count: 3 })), ["k10", "k11", "k12", "\u2026"]);
    assert.equal(Object.keys(stateOf(wide, { count: 1000 })).length, 450);
    const nested = stateOf({ inner: wide }, { count: 5 });
    assert.equal(Object.keys(nested.inner).length, 201, "below the top, 200");
    class Wide { constructor() { Object.assign(this, wide); } }
    assert.deepEqual(Object.keys(stateOf(new Wide(), { from: 449 }).entries), ["k449"], "an instance's fields page the same way");
}));

test("values: a component's props deeper than they were sent are fetched by the path their more names, as state fetches", () => page(() => {
    const { juris, ask, refusal, done } = inspect();
    juris.registerComponent("Deep", () => ({ p: "x" }));
    const rows = Array.from({ length: 150 }, (_, i) => ({ id: i, cells: { a: { b: { c: i } } } }));
    juris.render(host(), { Deep: { rows, config: { a: { b: { c: { d: "deep" } } } } } });
    const id = juris.findComponents("Deep")[0].id;
    const sent = ask("component", { id });
    assert.deepEqual(sent.props.config, { a: { b: { $: "more", path: "props.config.a.b" } } });
    assert.deepEqual(sent.props.rows.at(-1), { $: "more", path: "props.rows", length: 150 });
    assert.deepEqual(ask("component", { id, path: "props.config.a.b" }), { c: { d: "deep" } });
    assert.deepEqual(ask("component", { id, path: "props.config.a.b", depth: 1 }), { c: { $: "more", path: "props.config.a.b.c" } });
    assert.deepEqual(ask("component", { id, path: "props.rows", from: 148 }).map((row) => row.id), [148, 149]);
    assert.deepEqual(ask("component", { id, path: "props.rows.149.cells.a" }), { b: { c: 149 } });
    assert.deepEqual(ask("component", { id, path: "props" }), sent.props, "the props, as the component sent them");
    assert.deepEqual(ask("component", { id, path: "props", depth: 4 }).config, { a: { b: { c: { $: "more", path: "props.config.a.b.c" } } } });
    assert.deepEqual(ask("component", { id, path: "props.nothing.here" }), { $: "undefined" });
    for (const path of [5, "rows", "props.__proto__", "local"]) assert.equal(refusal("component", { id, path }), "bad-params", String(path));
    assert.equal(refusal("component", { id, path: "props", depth: 9 }), "bad-params");
    done();
}));

test("values: an object or array depth levels below the value asked for (3 unless asked, 8 at most) is more, with its path", () => page(() => {
    const deep = { a: { b: { c: { d: { e: 1 } } } }, n: { m: { k: "shown" } } };
    assert.deepEqual(stateOf(deep), { a: { b: { c: { $: "more", path: "v.a.b.c" } } }, n: { m: { k: "shown" } } });
    assert.deepEqual(stateOf(deep, { depth: 0 }), { $: "more", path: "v" });
    assert.deepEqual(stateOf("a primitive", { depth: 0 }), "a primitive");
    assert.deepEqual(stateOf(deep, { depth: 8 }), deep);
    assert.deepEqual(stateOf([[["x"]]], { depth: 2 }), [[{ $: "more", path: "v.0.0" }]]);
}));

test("values: an object met again in one answer is a cycle, at the path where it was first sent", () => page(() => {
    const shared = { n: 1 };
    const looped = { shared, again: shared };
    looped.self = looped;
    assert.deepEqual(stateOf(looped), { shared: { n: 1 }, again: { $: "cycle", path: "v.shared" }, self: { $: "cycle", path: "v" } });
}));

test("values: the root, and a private root counted, never sent (D14); the async root is read like the rest", () => page(() => {
    const { juris, ask, done } = inspect({ privatePaths: ["vault"], state: { vault: { a: 1, b: 2 }, $server: "token", open: { x: 1 } } });
    juris.setValue("$async.pending", 0);
    const root = ask("state", {});
    assert.deepEqual(root.vault, { $: "private", count: 2 });
    assert.deepEqual(root.$server, { $: "private", count: 0 });
    assert.deepEqual(root.open, { x: 1 });
    assert.deepEqual(root.$async, { pending: 0 });
    assert.deepEqual(ask("state", { path: "vault" }), { $: "private", count: 2 });
    assert.deepEqual(ask("state", { path: "vault.a" }), { $: "private", count: 2 });
    assert.deepEqual(ask("state", { path: "$server.x" }), { $: "private", count: 0 });
    assert.ok(!JSON.stringify(ask("state", { depth: 8 })).includes("token"));
    done();
}));

test("values: nothing read for the panel is a dependency, even a request made inside a binding's run", () => page(() => {
    const { juris, ask, done } = inspect();
    juris.setValue("watched", 1);
    juris.setValue("other", { deep: { x: 1 } });
    juris.registerComponent("Shown", () => ({ p: "x" }));
    juris.render(host(), { Shown: { data: { a: 1 } } });
    const id = juris.findComponents("Shown")[0].id;
    let answered = null;
    juris.bindState(() => {
        juris.getState("watched");
        answered = [ask("state", { path: "other", depth: 8 }), ask("component", { id }), ask("wakes", { path: "other.deep.x" }), ask("tree")];
        return 0;
    }, () => { });
    assert.deepEqual(answered[0], { deep: { x: 1 } });
    const [binding] = ask("wakes", { path: "watched" }).bindings;
    assert.deepEqual(binding.reads, ["watched"], "only what the binding read itself");
    assert.equal(ask("wakes", { path: "other" }).bindings.length, 0);
    done();
}));

test("values: an answer over 1 MiB of JSON is encoded again one level shallower until it fits, and says so", () => page(() => {
    const row = () => Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`c${i}`, "x".repeat(900)]));
    const { juris, answer, done } = inspect({ state: { big: Array.from({ length: 100 }, () => ({ row: row() })) } });
    const deep = answer("state", { path: "big", depth: 3 });
    assert.equal(deep.ok, true);
    assert.equal(deep.cut, true);
    assert.ok(JSON.stringify(deep.result).length <= 1024 * 1024);
    assert.deepEqual(deep.result[0], { row: { $: "more", path: "big.0.row" } });
    const small = answer("state", { path: "big", depth: 1 });
    assert.equal(small.cut, undefined, "what fits is not cut");
    // When nothing shallower fits (a tree's list is as long as the tree), it is sent as it is, cut.
    juris.registerComponent("Leaf", () => ({ i: "x" }));
    juris.render(host(), { div: { children: Array.from({ length: 11_000 }, () => ({ Leaf: {} })) } });
    const tree = answer("tree");
    assert.equal(tree.cut, true);
    assert.equal(tree.result.length, 11_000);
    done();
}));

test("node handles: a node's ref lasts while the node does, and the table is swept as it grows past 1,024", () => page(() => {
    const { juris, ask, refusal, done } = inspect();
    const nodes = Array.from({ length: 1100 }, () => new FakeElement("i", HTML));
    juris.setValue("nodes", nodes);
    const first = ask("state", { path: "nodes", count: 1000 });
    const second = ask("state", { path: "nodes", from: 1000, count: 100 });
    assert.equal(new Set([...first, ...second].filter((sent) => sent.$ === "node").map((handle) => handle.ref)).size, 1100);
    assert.equal(ask("node", { node: first[5] }).node.ref, first[5].ref);
    assert.equal(refusal("node", { node: { ...first[5], ref: 10_000_000 } }), "no-such-node");
    done();
}));
