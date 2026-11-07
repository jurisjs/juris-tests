// fluentstate.js, reading and writing: what a property read answers (a value or a fluent object),
// how a fluent object converts, lists its keys, iterates and names its kind, the methods every fluent
// object has (push, pop, shift, unshift, splice, update, clear, exists, raw), writes and deletes by
// property, $.x (reads without subscribing, writes no fluent subscriber hears), and reads inside a
// binding. Subscriptions, batch, debug and the hooks are in fluentstate.subscriptions.test.mjs.
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

// console.warn while `fn` runs, each call's arguments.
function warned(fn) {
    const lines = [];
    const original = console.warn;
    console.warn = (...args) => lines.push(args);
    try {
        fn();
    } finally {
        console.warn = original;
    }
    return lines;
}

// ---- making it ---------------------------------------------------------------------------------

test("createFluentStateHeadless needs the Juris instance in its context", () => {
    const refused = { name: "TypeError", message: "createFluentStateHeadless: context.juris is the Juris instance (headless.js makes such a context)" };
    assert.throws(() => createFluentStateHeadless({}), refused);
    assert.throws(() => createFluentStateHeadless({}, {}), refused);
    assert.throws(() => createFluentStateHeadless({}, { juris: {} }), refused);
});

test("it is a headless component: an api of getFluentStates, batch and debug, and its hooks", () => {
    const juris = new Juris({ isServer: true, state: { a: 1 } });
    const component = createFluentStateHeadless({}, { juris });
    assert.deepEqual(Object.keys(component.api).sort(), ["batch", "debug", "getFluentStates"]);
    assert.deepEqual(Object.keys(component.api.debug).sort(), ["clearCache", "clearSubscriptions", "getStats"]);
    assert.equal(typeof component.hooks.onRegister, "function");
    assert.equal(typeof component.hooks.onUnregister, "function");
    assert.equal(component.hooks.onRegister(), undefined);
    assert.equal(component.api.getFluentStates().a, 1);
    assert.equal(component.api.getFluentStates(), component.api.getFluentStates(), "one root");
    const { juris: installed, fs } = fluent();
    assert.equal(installed.getHeadlessAPI("fluentState"), fs);
});

// ---- reading -----------------------------------------------------------------------------------

test("a primitive reads as its value; anything else as a fluent object for its path", () => {
    const fn = () => "called";
    const { $ } = fluent({ n: 0, s: "x", b: false, user: { name: "Ada" }, list: [1], nothing: null, fn });
    assert.equal($.n, 0);
    assert.equal($.s, "x");
    assert.equal($.b, false);
    assert.equal($.fn, fn, "a function is a value too");
    for (const path of ["user", "list", "nothing", "missing"]) {
        assert.equal(typeof $[path], "object", path);
        assert.equal(typeof $[path].exists, "function", path);
    }
    assert.equal($.user.name, "Ada");
    assert.equal($.list[0], 1);
});

test("reading never writes, however deep", () => {
    const { juris, $ } = fluent({ a: 1 });
    const before = JSON.stringify(juris.stateManager.state);
    assert.equal($.settings.theme.colors.dark.exists(), false);
    void $.other.deeper.still;
    assert.equal(JSON.stringify(juris.stateManager.state), before);
});

test("each read is a new fluent object, so compare values", () => {
    const { $ } = fluent({ user: { name: "Ada" } });
    assert.notEqual($.user, $.user);
    assert.equal($.user.valueOf(), $.user.valueOf());
});

test("a fluent object converts to its value, and as text to nothing for nothing there", () => {
    const { juris, $ } = fluent({ user: { name: "Ada" }, list: [1, 2], nothing: null });
    assert.equal(`${$.missing}`, "");
    assert.equal(`${$.nothing}`, "");
    assert.equal(`${$.missing.deeper}`, "");
    assert.equal(`${$.list}`, "1,2");
    assert.equal(String($.user), "[object Object]");
    assert.ok(Number.isNaN(+$.user));
    assert.equal(+$.nothing, 0, "as a number, null is what Number(null) is");
    assert.equal($.nothing + 1, 1);
    assert.ok(Number.isNaN(+$.missing), "and nothing at all is what Number(undefined) is");
    assert.equal($.user.valueOf(), juris.getState("user"));
    assert.equal($.nothing.valueOf(), null);
    assert.equal($.missing.valueOf(), undefined);
    assert.equal($.user.toString(), "[object Object]");
    assert.equal($.missing.toString(), "");
    assert.equal($.nothing.toString(), "");
});

test("JSON.stringify writes a fluent object as its value", () => {
    const { $ } = fluent({ user: { name: "Ada", tags: ["a"] }, list: [1, 2] });
    assert.equal(JSON.stringify($.user), '{"name":"Ada","tags":["a"]}');
    assert.equal(JSON.stringify({ list: $.list }), '{"list":[1,2]}');
    assert.equal(JSON.stringify($.missing), undefined);
});

test("a fluent object names its kind: Object, Array, null or undefined", () => {
    const { $ } = fluent({ user: {}, list: [], nothing: null });
    assert.equal(Object.prototype.toString.call($.user), "[object Object]");
    assert.equal(Object.prototype.toString.call($.list), "[object Array]");
    assert.equal(Object.prototype.toString.call($.nothing), "[object null]");
    assert.equal(Object.prototype.toString.call($.missing), "[object undefined]");
});

test("a fluent array iterates its items, each a value or a fluent object", () => {
    const { $ } = fluent({ rows: [{ t: 1 }, { t: 2 }], nums: [1, 2], user: { a: 1 } });
    assert.deepEqual([...$.rows].map((row) => row.t), [1, 2]);
    assert.deepEqual([...$.nums], [1, 2]);
    assert.throws(() => [...$.user], TypeError, "an object is not iterable");
    assert.throws(() => [...$.missing], TypeError);
});

test("an unknown symbol reads as undefined", () => {
    const { $ } = fluent({ user: { a: 1 }, list: [1] });
    assert.equal($.user[Symbol("anything")], undefined);
    assert.equal($.list[Symbol.asyncIterator], undefined);
    assert.equal($.user[Symbol.iterator], undefined);
});

test("a fluent object lists its keys, entries and own properties as its value does", () => {
    const hidden = Symbol("hidden");
    const { $ } = fluent({ user: { name: "Ada", age: 36, [hidden]: "symbol key" }, list: ["a", "b"], nothing: null });
    assert.deepEqual(Object.keys($.user), ["name", "age"]);
    assert.deepEqual(Reflect.ownKeys($.user), ["name", "age"], "symbol keys are not listed");
    assert.deepEqual(Object.keys($.list), ["0", "1"]);
    assert.deepEqual(Object.keys($.missing), []);
    assert.deepEqual(Object.keys($.nothing), []);
    assert.deepEqual(Object.entries($.user), [["name", "Ada"], ["age", 36]]);
    assert.deepEqual({ ...$.user }, { name: "Ada", age: 36 });
});

test("in says whether a key is there, and every method name is", () => {
    const { $ } = fluent({ user: { name: "Ada" }, s: "text" });
    assert.equal("name" in $.user, true);
    assert.equal("missing" in $.user, false);
    assert.equal("anything" in $.missing, false);
    for (const name of ["push", "update", "exists", "raw", "x", "subscribe", "unsubscribe"]) assert.equal(name in $.user, true, name);
    assert.equal(Symbol.iterator in $.user, false);
});

test("a fluent object describes its own keys; nothing for a missing key, a symbol or nothing there", () => {
    const { $ } = fluent({ user: { name: "Ada", address: { city: "X" } } });
    assert.deepEqual(Object.getOwnPropertyDescriptor($.user, "name"), { value: "Ada", writable: true, enumerable: true, configurable: true });
    assert.equal(Object.getOwnPropertyDescriptor($.user, "address").value.city, "X");
    assert.equal(Object.getOwnPropertyDescriptor($.user, "nope"), undefined);
    assert.equal(Object.getOwnPropertyDescriptor($.user, Symbol.iterator), undefined);
    assert.equal(Object.getOwnPropertyDescriptor($.missing, "a"), undefined);
});

test("a key its value does not enumerate is not listed by Object.keys", () => {
    const value = { shown: 1 };
    Object.defineProperty(value, "hidden", { value: 2, enumerable: false, writable: true, configurable: true });
    const { $ } = fluent({ o: value, list: [1] });
    assert.deepEqual(Object.keys($.o), ["shown"]);
    assert.equal(Object.getOwnPropertyDescriptor($.o, "hidden").enumerable, false);
    assert.equal($.o.hidden, 2);
    assert.equal(Object.keys($.list).includes("length"), false);
    assert.equal($.list.length, 1);
});

test("a method of the object or array is called on the fluent object", () => {
    const { $ } = fluent({ rows: [{ t: 1 }, { t: 2 }], nums: [1, 2, 3], user: { name: "Ada" } });
    assert.deepEqual($.rows.map((row) => row.t), [1, 2]);
    assert.deepEqual($.nums.filter((n) => n > 1), [2, 3]);
    assert.equal($.nums.includes(2), true);
    assert.equal($.nums.indexOf(3), 2);
    assert.equal($.nums.join("-"), "1-2-3");
    assert.equal($.nums.length, 3);
    assert.equal($.user.hasOwnProperty("name"), true);
    assert.equal($.user.hasOwnProperty("nope"), false);
});

test("an own key named like an inherited method reads as the key", () => {
    const { $ } = fluent({ o: { map: { y: 1 }, hasOwnProperty: "mine" } });
    assert.equal($.o.map.y, 1);
    assert.equal($.o.hasOwnProperty, "mine");
});

test("a method name always reads as the method; the key behind it is read with raw()", () => {
    const { $ } = fluent({ o: { update: 1, raw: 2 } });
    assert.equal(typeof $.o.update, "function");
    assert.deepEqual($.o.raw(), { update: 1, raw: 2 });
});

test("a fluent object kept while its path became a primitive reads that primitive", () => {
    const { juris, $ } = fluent({ user: { name: "Ada" } });
    const user = $.user;
    juris.setValue("user", "text");
    assert.equal(user.length, 4);
    assert.equal(`${user}`, "text");
    assert.equal(user.valueOf(), "text");
    assert.equal(Object.prototype.toString.call(user), "[object string]");
    assert.deepEqual(Object.keys(user), []);
    assert.equal("length" in user, false);
});

// ---- writing -----------------------------------------------------------------------------------

test("assigning a property writes it, making the parents that are missing", () => {
    const { juris, $ } = fluent({ user: { name: "Ada" } });
    $.user.name = "Grace";
    $.settings.theme.dark = true;
    assert.equal(juris.getState("user.name"), "Grace");
    assert.deepEqual(juris.getState("settings"), { theme: { dark: true } });
    $.list = [1, 2];
    $.list[2] = 3;
    assert.deepEqual(juris.getState("list"), [1, 2, 3]);
});

test("assigning a fluent object writes its value", () => {
    const { juris, $ } = fluent({ user: { name: "Ada" } });
    $.copy = $.user;
    assert.deepEqual(juris.getState("copy"), { name: "Ada" });
    $.x.still = $.user;
    assert.deepEqual(juris.getState("still"), { name: "Ada" });
});

test("delete removes the path, as deleteState does", () => {
    const { juris, $ } = fluent({ user: { name: "Ada", age: 1 }, list: ["a", "b", "c"] });
    assert.equal(delete $.user.name, true);
    assert.deepEqual(juris.getState("user"), { age: 1 });
    delete $.list[0];
    assert.deepEqual(juris.getState("list"), ["b", "c"], "an index is spliced out");
    delete $.missing.deep;
    assert.equal(juris.getState("missing"), undefined);
});

test("a symbol key is neither written nor deleted", () => {
    const { juris, $ } = fluent({ user: { name: "Ada" } });
    const key = Symbol("key");
    const user = $.user;
    user[key] = 1;
    assert.equal(delete user[key], true);
    assert.deepEqual(Reflect.ownKeys(juris.getState("user")), ["name"]);
});

test("the array methods write a new array and answer what the native method does", () => {
    const { juris, $ } = fluent({ list: [1, 2, 3] });
    const before = juris.getState("list");
    assert.equal($.list.push(4, 5), 5);
    assert.notEqual(juris.getState("list"), before);
    assert.deepEqual(before, [1, 2, 3], "the old array is left as it was");
    assert.equal($.list.pop(), 5);
    assert.equal($.list.shift(), 1);
    assert.equal($.list.unshift(0), 4);
    assert.deepEqual($.list.splice(1, 2, "x"), [2, 3]);
    assert.deepEqual(juris.getState("list"), [0, "x", 4]);
});

test("an array method on nothing makes a list; on a single value, a list of it", () => {
    const { juris, $ } = fluent({ obj: { a: 1 }, nothing: null });
    assert.equal($.fresh.push("a"), 1);
    assert.deepEqual(juris.getState("fresh"), ["a"]);
    assert.equal($.nothing.unshift("n"), 1);
    assert.deepEqual(juris.getState("nothing"), ["n"]);
    assert.equal($.obj.push(2), 2);
    assert.deepEqual(juris.getState("obj"), [{ a: 1 }, 2]);
    const later = $.later;
    juris.setValue("later", 1);
    assert.equal(later.push(2), 2);
    assert.deepEqual(juris.getState("later"), [1, 2]);
});

test("pop and shift on an empty list or on nothing write nothing", () => {
    const { juris, $ } = fluent({ empty: [] });
    const writes = [];
    juris.stateManager.observe((path) => writes.push(path));
    assert.equal($.empty.pop(), undefined);
    assert.equal($.empty.shift(), undefined);
    assert.equal($.missing.pop(), undefined);
    assert.equal($.missing.shift(), undefined);
    assert.deepEqual(writes, []);
    assert.equal(juris.getState("missing"), undefined);
});

test("fluent objects given to an array method are written as their values", () => {
    const { juris, $ } = fluent({ user: { name: "Ada" }, list: [] });
    $.list.push($.user);
    $.list.splice(0, 0, $.missing, 1);
    assert.deepEqual(juris.getState("list"), [undefined, 1, { name: "Ada" }]);
});

test("update merges into what is there, or into nothing, and answers the result", () => {
    const { juris, $ } = fluent({ user: { name: "Ada", age: 36 }, nothing: null });
    assert.deepEqual($.user.update({ age: 37 }), { name: "Ada", age: 37 });
    assert.deepEqual(juris.getState("user"), { name: "Ada", age: 37 });
    assert.deepEqual($.obj.update({ a: 1 }), { a: 1 });
    assert.deepEqual($.obj.update({ b: 2 }), { a: 1, b: 2 });
    assert.deepEqual($.nothing.update({ c: 3 }), { c: 3 });
});

test("clear writes null, and exists says whether anything but null or undefined is there", () => {
    const { juris, $ } = fluent({ user: { name: "Ada" } });
    assert.equal($.user.exists(), true);
    $.user.clear();
    assert.equal(juris.getState("user"), null);
    assert.equal(Object.hasOwn(juris.stateManager.state, "user"), true);
    assert.equal($.user.exists(), false);
    assert.equal($.missing.exists(), false);
    const flag = $.flag;
    for (const value of [false, 0, ""]) {
        juris.setValue("flag", value);
        assert.equal(flag.exists(), true, JSON.stringify(value));
    }
});

test("raw answers getState: the value itself, and inside a binding the core's read-only view", () => {
    const { juris, $ } = fluent({ user: { name: "Ada" } });
    const sm = juris.stateManager;
    assert.equal($.user.raw(), sm.peek("user"));
    assert.equal($.missing.raw(), undefined);
    const { dependencies, value } = sm.capture(() => $.user.raw());
    assert.ok(dependencies.has("user"));
    assert.notEqual(value, sm.peek("user"));
    assert.equal(sm.toRaw(value), sm.peek("user"));
    sm.capture(() => assert.throws(() => {
        $.user.raw().name = "x";
    }, /read-only inside bindings/));
});

// ---- inside a binding ----------------------------------------------------------------------------

test("a live read inside a binding is a dependency, so the binding re-runs when it changes", () => {
    const { juris, $ } = fluent({ user: { name: "Ada" }, list: [1] });
    const sm = juris.stateManager;
    sm.compute("label", () => `${$.user.name}!`);
    sm.compute("keys", () => Object.keys($.user).join(","));
    sm.compute("sum", () => [...$.list].reduce((total, n) => total + n, 0));
    sm.compute("has", () => $.profile.exists());
    sm.compute("json", () => JSON.stringify($.user));
    $.user.name = "Grace";
    $.user.age = 1;
    $.list.push(2);
    $.profile = { id: 1 };
    assert.equal(sm.peek("label"), "Grace!");
    assert.equal(sm.peek("keys"), "name,age");
    assert.equal(sm.peek("sum"), 3);
    assert.equal(sm.peek("has"), true);
    assert.equal(sm.peek("json"), '{"name":"Grace","age":1}');
});

// ---- $.x ---------------------------------------------------------------------------------------

test("$.x reads as the live object reads, recording no dependency", () => {
    const { juris, $ } = fluent({ user: { name: "Ada", age: 36 }, list: [1, 2] });
    const sm = juris.stateManager;
    const { dependencies, value } = sm.capture(() => [
        $.x.user.name,
        Object.keys($.x.user),
        "name" in $.x.user,
        [...$.x.list],
        `${$.x.user.name}`,
        JSON.stringify($.x.user),
        $.x.user.exists(),
        $.x.user.raw() === sm.peek("user"),
        $.x.user.valueOf() === sm.peek("user"),
        String($.x.missing),
        Object.entries($.x.user),
        $.x.x.list.length,
    ]);
    assert.deepEqual(value, ["Ada", ["name", "age"], true, [1, 2], "Ada", '{"name":"Ada","age":36}', true, true, true, "", [["name", "Ada"], ["age", 36]], 2]);
    assert.equal(dependencies.size, 0);
});

test("subscriptions are not available through $.x, and saying so is a warning", () => {
    const { $ } = fluent({ user: {} });
    for (const name of ["subscribe", "watch", "onChange"]) {
        const lines = warned(() => assert.equal($.x.user[name], undefined));
        assert.deepEqual(lines, [["FluentState: subscriptions are not available through $.x"]], name);
    }
    assert.equal(typeof $.x.user.unsubscribe, "function");
});

test("$.x writes reach the state", () => {
    const { juris, $ } = fluent({ user: { name: "Ada" }, list: [1, 2] });
    $.x.user.name = "quiet";
    $.x.list.push(3);
    $.x.list.shift();
    $.x.user.update({ age: 1 });
    delete $.x.user.age;
    $.x.other.clear();
    assert.deepEqual(juris.getState("user"), { name: "quiet" });
    assert.deepEqual(juris.getState("list"), [2, 3]);
    assert.equal(juris.getState("other"), null);
});
