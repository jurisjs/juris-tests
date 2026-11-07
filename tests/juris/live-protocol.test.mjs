// live-protocol.js, the rules both ends of a live query compute alike: a call's key, which keys can
// be one segment of a state path, the leaf patch between two results, the refusal codes, and what a
// service is told about who is calling. Held to REFERENCE.md ("live-protocol.js", "Who is calling").
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    liveKey, canAddress, diff, LIVE_CODES, CALL_KIND, CALL_KINDS, callKind, internal,
} from "juris/live-protocol.js";

const none = () => ({ set: [], del: [] });

// ---- liveKey -----------------------------------------------------------------------------------

test("liveKey is the service name, a colon, and the arguments as JSON, byte for byte", () => {
    assert.equal(liveKey("rows", [1, { page: 2 }]), 'rows:[1,{"page":2}]');
    assert.equal(liveKey("inbox", []), "inbox:[]");
    assert.equal(liveKey("thing", ["a\"b"]), 'thing:["a\\"b"]');
});

test("liveKey tells list() from list({}): they are two different calls", () => {
    assert.notEqual(liveKey("list", []), liveKey("list", [{}]));
    assert.equal(liveKey("list", [{}]), "list:[{}]");
});

test("liveKey gives equal arguments the same key, however they were built", () => {
    assert.equal(liveKey("q", [{ a: 1 }, [2]]), liveKey("q", JSON.parse('[{"a":1},[2]]')));
});

// ---- canAddress --------------------------------------------------------------------------------

test("canAddress takes an object whose every own key can be one path segment", () => {
    assert.equal(canAddress({ a: 1, b_c: 2, "x-y": 3 }), true);
    assert.equal(canAddress({}), true);
    assert.equal(canAddress(Object.assign(Object.create(null), { a: 1 })), true);
});

test("canAddress refuses a key with a dot, an own __proto__ key, and the empty key", () => {
    assert.equal(canAddress({ "a.b": 1 }), false);
    assert.equal(canAddress({ ok: 1, "x.": 2 }), false);
    assert.equal(canAddress(JSON.parse('{"__proto__": {"x": 1}}')), false);
    assert.equal(canAddress({ "": 1 }), false);
});

test("canAddress takes arrays, whose keys are indices, and anything that is no object", () => {
    assert.equal(canAddress([1, { "a.b": 2 }]), true, "only the array's own keys are asked");
    for (const value of [null, undefined, 0, "a.b", true, Symbol("s")]) assert.equal(canAddress(value), true, String(value));
});

// ---- diff --------------------------------------------------------------------------------------

test("diff of two equal results is empty", () => {
    assert.deepEqual(diff({ a: 1, b: [1, { c: 2 }] }, { a: 1, b: [1, { c: 2 }] }), none());
    assert.deepEqual(diff(5, 5), none());
    assert.deepEqual(diff(NaN, NaN), none());
    assert.deepEqual(diff({ n: NaN }, { n: NaN }), none());
});

test("diff sends a changed leaf under its own dotted path", () => {
    assert.deepEqual(diff({ a: { b: 1, c: 2 } }, { a: { b: 9, c: 2 } }), { set: [["a.b", 9]], del: [] });
});

test("diff sends a changed root leaf, or a changed type at the root, under the path \"\"", () => {
    assert.deepEqual(diff(1, 2), { set: [["", 2]], del: [] });
    assert.deepEqual(diff({ a: 1 }, [1]), { set: [["", [1]]], del: [] });
    assert.deepEqual(diff([1], { 0: 1 }), { set: [["", { 0: 1 }]], del: [] });
    assert.deepEqual(diff(null, { a: 1 }), { set: [["", { a: 1 }]], del: [] });
    assert.deepEqual(diff(undefined, null), { set: [["", null]], del: [] });
});

test("diff walks an array of the same length index by index", () => {
    assert.deepEqual(diff([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 1 }]), { set: [["0.id", 2], ["1.id", 1]], del: [] });
});

test("diff sends an array whose length changed whole, under its own path", () => {
    assert.deepEqual(diff({ list: [1] }, { list: [1, 2] }), { set: [["list", [1, 2]]], del: [] });
    assert.deepEqual(diff([1, 2], [1]), { set: [["", [1]]], del: [] });
});

test("diff deletes a key the next result no longer has, nested ones under their path", () => {
    assert.deepEqual(diff({ a: 1, b: 2 }, { a: 1 }), { set: [], del: ["b"] });
    assert.deepEqual(diff({ o: { x: 1, y: 2 } }, { o: { x: 1 } }), { set: [], del: ["o.y"] });
});

test("diff deletes a removed key named after an Object.prototype member like any other", () => {
    const out = diff({ constructor: 1, toString: 2, hasOwnProperty: 3, a: 1 }, { a: 1 });
    assert.deepEqual(out.del.sort(), ["constructor", "hasOwnProperty", "toString"]);
    assert.deepEqual(out.set, []);
});

test("diff sends a new key named after an Object.prototype member as a set", () => {
    assert.deepEqual(diff({}, { constructor: { a: 1 } }), { set: [["constructor", { a: 1 }]], del: [] });
    assert.deepEqual(diff({}, { toString: "x" }), { set: [["toString", "x"]], del: [] });
});

test("diff sends an added key, and keeps a key whose value is undefined", () => {
    assert.deepEqual(diff({ a: 1 }, { a: 1, b: { c: 1 } }), { set: [["b", { c: 1 }]], del: [] });
    assert.deepEqual(diff({ a: undefined }, { a: undefined }), none());
});

test("diff sends an object with a dotted key whole, at its own path, and only when it changed", () => {
    assert.deepEqual(diff({ row: { "a.b": 1 } }, { row: { "a.b": 2 } }), { set: [["row", { "a.b": 2 }]], del: [] });
    assert.deepEqual(diff({ row: { "a.b": 1 } }, { row: { "a.b": 1 } }), none());
    assert.deepEqual(diff({ "a.b": 1 }, { "a.b": 2 }), { set: [["", { "a.b": 2 }]], del: [] }, "at the top, the root's path");
});

test("diff sends whole an object whose previous value held a key no path can name", () => {
    assert.deepEqual(diff({ row: { "a.b": 1 } }, { row: { a: 1 } }), { set: [["row", { a: 1 }]], del: [] });
});

test("diff sends an object with an own __proto__ key whole, never walking into it", () => {
    const previous = JSON.parse('{"meta": {"__proto__": {"x": 1}}}');
    const next = JSON.parse('{"meta": {"__proto__": {"x": 2}}}');
    const out = diff(previous, next);
    assert.equal(out.set.length, 1);
    assert.equal(out.set[0][0], "meta");
    assert.equal(Object.getPrototypeOf(out.set[0][1]), Object.prototype);
    assert.equal(JSON.stringify(out.set[0][1]), '{"__proto__":{"x":2}}');
    assert.deepEqual(out.del, []);
});

test("diff sends an object with the empty key whole, so a patch for it cannot replace its parent", () => {
    assert.deepEqual(diff({ o: { "": 1, a: 1 } }, { o: { "": 2, a: 1 } }), { set: [["o", { "": 2, a: 1 }]], del: [] });
    assert.deepEqual(diff({ "": 1 }, {}), { set: [["", {}]], del: [] }, "a removed empty key at the top: the whole result, no delete of the root");
});

test("diff compares a Date as a leaf: a changed timestamp is sent, an equal one is not", () => {
    const at = (iso) => ({ when: new Date(iso) });
    assert.deepEqual(diff(at("2026-01-01T00:00:00Z"), at("2026-01-01T00:00:00Z")), none());
    const out = diff(at("2026-01-01T00:00:00Z"), at("2026-02-01T00:00:00Z"));
    assert.equal(out.set.length, 1);
    assert.equal(out.set[0][0], "when");
    assert.equal(out.set[0][1].toISOString(), "2026-02-01T00:00:00.000Z");
});

test("diff follows a reordered row's date: each row gets its own", () => {
    const rows = (a, b) => [{ id: 1, at: new Date(a) }, { id: 2, at: new Date(b) }];
    const out = diff(rows("2026-01-01", "2026-01-02"), rows("2026-01-02", "2026-01-01"));
    assert.deepEqual(out.set.map(([path, value]) => [path, value.toISOString().slice(0, 10)]), [["0.at", "2026-01-02"], ["1.at", "2026-01-01"]]);
});

test("diff takes a class instance for a leaf, and walks a null-prototype object", () => {
    class Money { constructor(cents) { this.cents = cents; } }
    assert.deepEqual(diff({ price: new Money(1) }, { price: new Money(1) }), none());
    const changed = diff({ price: new Money(1) }, { price: new Money(2) });
    assert.equal(changed.set.length, 1);
    assert.equal(changed.set[0][0], "price");
    assert.ok(changed.set[0][1] instanceof Money);
    const bare = (v) => Object.assign(Object.create(null), { v });
    assert.deepEqual(diff(bare(1), bare(2)), { set: [["v", 2]], del: [] });
});

test("diff writes under the path it is given, into the patch it is given", () => {
    const out = { set: [["earlier", 0]], del: [] };
    assert.equal(diff({ a: 1, b: 1 }, { a: 2 }, "root", out), out);
    assert.deepEqual(out, { set: [["earlier", 0], ["root.a", 2]], del: ["root.b"] });
});

// ---- LIVE_CODES --------------------------------------------------------------------------------

test("LIVE_CODES names the wire codes, frozen", () => {
    assert.deepEqual({ ...LIVE_CODES }, { CLIENT_UNKNOWN: "live.client-unknown", NOT_A_QUERY: "live.not-a-query" });
    assert.ok(Object.isFrozen(LIVE_CODES));
    assert.throws(() => { LIVE_CODES.CLIENT_UNKNOWN = "x"; }, TypeError);
});

// ---- who is calling ----------------------------------------------------------------------------

test("CALL_KIND is the registered symbol juris.callKind, and CALL_KINDS the five kinds, frozen", () => {
    assert.equal(typeof CALL_KIND, "symbol");
    assert.equal(CALL_KIND, Symbol.for("juris.callKind"));
    assert.deepEqual([...CALL_KINDS], ["direct", "preload", "live", "render", "internal"]);
    assert.ok(Object.isFrozen(CALL_KINDS));
});

test("callKind answers the kind a context carries under CALL_KIND", () => {
    for (const kind of CALL_KINDS) assert.equal(callKind({ [CALL_KIND]: kind }), kind);
    assert.equal(callKind(Object.freeze({ [CALL_KIND]: "live" })), "live");
    const fn = function service() { };
    fn[CALL_KIND] = "preload";
    assert.equal(callKind(fn), "preload", "a function may carry it too");
});

test("callKind answers \"direct\" for anything that does not say, undefined and primitives included", () => {
    for (const value of [undefined, null, 0, "live", true, Symbol("x"), 10n, {}, [], () => { }]) {
        assert.equal(callKind(value), "direct", String(typeof value));
    }
});

test("callKind answers \"direct\" for a kind it does not know, and for a string key only a request could set", () => {
    assert.equal(callKind({ [CALL_KIND]: "admin" }), "direct");
    assert.equal(callKind({ [CALL_KIND]: undefined }), "direct");
    assert.equal(callKind(JSON.parse('{"juris.callKind": "internal"}')), "direct");
    assert.equal(callKind({ [Symbol("juris.callKind")]: "internal" }), "direct", "an unregistered symbol of the same description");
});

test("internal(reason) is a frozen context of kind \"internal\" carrying its reason and nothing else", () => {
    const context = internal("nightly cleanup");
    assert.equal(callKind(context), "internal");
    assert.equal(context.reason, "nightly cleanup");
    assert.ok(Object.isFrozen(context));
    assert.deepEqual(Reflect.ownKeys(context).sort((a, b) => String(a).localeCompare(String(b))), ["reason", CALL_KIND].sort((a, b) => String(a).localeCompare(String(b))));
    assert.throws(() => { context.user = "someone"; }, TypeError);
});

test("internal(reason) refuses a reason that is not a non-blank string", () => {
    for (const reason of [undefined, null, "", "   ", "\n\t", 1, {}, ["job"]]) {
        assert.throws(() => internal(reason), (error) => error instanceof TypeError && error.message === "internal(reason): say what the call is for", JSON.stringify(reason) ?? String(reason));
    }
});
