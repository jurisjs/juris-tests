// headless.js: createContext (0.91's component context on this core: getState's default and track,
// setState, executeBatch, subscribe, services and headless apis by name, components, element) and
// HeadlessManager (installing on an instance, register, initialize, reinitialize, cleanup, the api
// under each name, what fails and how it is said, the queue, the names the instance gains).
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import { HeadlessManager, createContext } from "juris/headless.js";
import { withSSR } from "../support/ssr-renderer.mjs";

const server = (options = {}) => new Juris(withSSR({ isServer: true, ...options }));
const headless = (options = {}) => server({ features: { headless: HeadlessManager }, ...options });

// console.error and console.warn while `fn` runs, each call's arguments.
function said(fn) {
    const lines = [];
    const original = { error: console.error, warn: console.warn };
    console.error = console.warn = (...args) => lines.push(args);
    try {
        fn();
    } finally {
        Object.assign(console, original);
    }
    return lines;
}

// A headless component that logs its lifecycle and answers its props through its api.
function logged(log, label = "svc") {
    let made = 0;
    return (props, context) => {
        const n = ++made;
        return {
            api: { n, props: () => props, context: () => context },
            hooks: {
                onRegister: () => log.push(`register ${label} ${n}`),
                onUnregister: () => log.push(`unregister ${label} ${n}`),
            },
        };
    };
}

// ---- createContext -----------------------------------------------------------------------------

test("a context is the component api with 0.91's names beside it", () => {
    const juris = headless({ services: { hello: (name) => `hi ${name}` } });
    juris.registerAndInitHeadless("cart", () => ({ api: { size: () => 0 } }));
    const context = createContext(juris);
    for (const name of Object.keys(juris.api)) assert.ok(name in context, name);
    for (const name of ["getState", "setState", "executeBatch", "subscribe", "hello", "cart", "headless", "isSSR", "components", "juris"]) {
        assert.ok(name in context, name);
    }
    for (const name of ["utils", "objectToHtml", "setupIndicators", "logger", "element"]) assert.equal(name in context, false, name);
    assert.equal(context.hello("ada"), "hi ada");
    assert.equal(context.cart, juris.api.cart);
    assert.equal(context.headless, juris.headlessManager.context);
    assert.equal(context.juris, juris);
    assert.equal(context.isSSR, true);
    assert.equal(context.setValue, juris.api.setValue);
});

test("isSSR is the instance's isServer", () => {
    const browser = new Juris({ isServer: false, features: { headless: HeadlessManager } });
    assert.equal(createContext(browser).isSSR, false);
});

test("a context carries the element it was made for", () => {
    const juris = headless();
    const element = { tagName: "DIV" };
    assert.equal(createContext(juris, element).element, element);
    assert.equal(juris.createHeadlessContext(element).element, element);
    assert.equal(juris.createContext(element).element, element);
    assert.equal("element" in createContext(juris, null), false);
});

test("each call answers its own copy, built afresh when the component api changes", () => {
    const juris = headless();
    const first = createContext(juris);
    const second = createContext(juris);
    assert.notEqual(first, second);
    first.mine = 1;
    assert.equal("mine" in second, false);
    assert.equal(first.getState, second.getState, "one shared part for one version of the api");
    juris.extendApi({ extra: "added" });
    const third = createContext(juris);
    assert.equal(third.extra, "added");
    assert.notEqual(third.getState, first.getState);
    assert.equal("extra" in first, false, "a copy made earlier keeps what it had");
});

test("a context works on an instance with no headless manager", () => {
    const juris = server({ state: { a: 1 } });
    const context = createContext(juris);
    assert.equal(context.headless, undefined);
    assert.equal(context.getState("a"), 1);
    assert.equal(context.components.registerHeadless("x", () => ({})), undefined);
    assert.equal(context.components.getHeadless("x"), undefined);
    assert.equal(context.components.initHeadless("x"), undefined);
    assert.equal(context.components.reinitHeadless("x"), undefined);
    assert.equal(context.components.getHeadlessAPI("x"), undefined);
});

test("a context made once the manager has arrived reaches it", () => {
    const juris = server();
    assert.equal(createContext(juris).headless, undefined);
    const manager = new HeadlessManager(juris);
    assert.equal(createContext(juris).headless, manager.context);
});

test("a context made before a headless api arrived still reaches it through headless", () => {
    const juris = headless();
    const early = createContext(juris);
    juris.registerAndInitHeadless("late", () => ({ api: { ok: true } }));
    assert.equal(early.late, undefined, "a copy: the names it was made with");
    assert.equal(early.headless.late, juris.api.late);
    assert.equal(createContext(juris).late, juris.api.late);
});

test("getState answers null for nothing there unless given a default", () => {
    const juris = headless({ state: { zero: 0, nothing: null } });
    const { getState } = createContext(juris);
    assert.equal(getState("missing"), null);
    assert.equal(getState("missing", undefined), null);
    assert.equal(getState("missing", 5), 5);
    assert.equal(getState("missing", 5, false), 5);
    assert.equal(getState("missing", undefined, false), null);
    assert.equal(getState("zero", 5), 0);
    assert.equal(getState("nothing", 5), null);
    assert.equal(getState("zero", 5, false), 0);
});

test("getState reads with a dependency by default, and without one when track is false", () => {
    const juris = headless({ state: { user: { name: "Ada" } } });
    const { getState } = createContext(juris);
    const sm = juris.stateManager;
    const raw = sm.peek("user");
    const tracked = sm.capture(() => getState("user"));
    assert.ok(tracked.dependencies.has("user"));
    assert.notEqual(tracked.value, raw, "inside a binding, the core's tracking view");
    assert.equal(sm.toRaw(tracked.value), raw);
    const untracked = sm.capture(() => getState("user", null, false));
    assert.equal(untracked.value, raw);
    assert.equal(untracked.dependencies.size, 0);
});

test("getState hands an options object through to the core's getState", () => {
    const juris = headless({ state: { user: { name: "Ada" } } });
    const { getState } = createContext(juris);
    const sm = juris.stateManager;
    const { dependencies, value } = sm.capture(() => getState("user", null, { track: false }));
    assert.equal(value, sm.peek("user"), "{ track: false }: the object itself");
    assert.ok(dependencies.has("user"), "a dependency on the path, as the core's getState records");
});

test("setState writes; executeBatch is one notification pass and answers what its callback answers", () => {
    const juris = headless({ state: { a: 0, b: 0 } });
    const { setState, executeBatch } = createContext(juris);
    let runs = 0;
    juris.stateManager.subscribe(["a", "b"], () => (runs += 1));
    setState("a", 1);
    assert.equal(juris.getState("a"), 1);
    assert.equal(runs, 1);
    const result = executeBatch(() => {
        setState("a", 2);
        setState("b", 2);
        return "batched";
    });
    assert.equal(result, "batched");
    assert.equal(runs, 2);
});

test("components reaches the instance's registry and its headless manager", () => {
    const juris = headless();
    const { components } = createContext(juris);
    const Hello = () => ({ p: { textContent: "hello" } });
    components.register("Hello", Hello);
    assert.equal(juris.hasComponent("Hello"), true);
    assert.equal(components.get("Hello"), Hello);
    assert.equal(components.get("Missing"), undefined);
    const log = [];
    components.registerHeadless("svc", logged(log));
    const instance = components.initHeadless("svc", { p: 1 });
    assert.equal(components.getHeadless("svc"), instance);
    assert.equal(components.getHeadlessAPI("svc"), instance.api);
    assert.deepEqual(instance.api.props(), { p: 1 });
    const again = components.reinitHeadless("svc", { p: 2 });
    assert.deepEqual(again.api.props(), { p: 2 });
    assert.deepEqual(log, ["register svc 1", "unregister svc 1", "register svc 2"]);
});

// ---- subscribe ---------------------------------------------------------------------------------

test("subscribe hears its path and every path beneath it, with (value, previous, changedPath)", () => {
    const juris = headless();
    const { subscribe } = createContext(juris);
    const heard = [];
    const copy = (value) => (value === undefined ? undefined : structuredClone(value));
    subscribe("user", (value, previous, changed) => heard.push([copy(value), copy(previous), changed]));
    juris.setValue("user", { name: "a" });
    juris.setValue("user.name", "b");
    juris.setValue("user.address.city", "X");
    juris.deleteState("user.name");
    juris.setValue("username", 1);
    juris.setValue("other", 1);
    assert.deepEqual(heard, [
        [{ name: "a" }, undefined, "user"],
        ["b", "a", "user.name"],
        ["X", undefined, "user.address.city"],
        [undefined, "b", "user.name"],
    ]);
});

test("subscribe with hierarchical false hears its own path only", () => {
    const juris = headless({ state: { user: { name: "a" } } });
    const { subscribe } = createContext(juris);
    const heard = [];
    subscribe("user", (value, previous, changed) => heard.push(changed), false);
    juris.setValue("user.name", "b");
    juris.setValue("user", { name: "c" });
    assert.deepEqual(heard, ["user"]);
});

test("subscribe refuses a path that is not a non-empty string, and a callback that is not a function", () => {
    const { subscribe } = createContext(headless());
    for (const path of ["", undefined, 5, null]) {
        assert.throws(() => subscribe(path, () => { }), { name: "TypeError", message: "subscribe: path is a state path" });
    }
    assert.throws(() => subscribe("a", "no"), { name: "TypeError", message: "subscribe: callback is a function (value, previous, changedPath)" });
});

test("a subscriber that throws is said on the console, the others still run, and the writer sees nothing", () => {
    const juris = headless();
    const { subscribe } = createContext(juris);
    const heard = [];
    const error = new Error("boom");
    subscribe("a", () => {
        throw error;
    });
    subscribe("a", (value) => heard.push(value));
    const lines = said(() => assert.doesNotThrow(() => juris.setValue("a.b", 1)));
    assert.deepEqual(heard, [1]);
    assert.equal(lines.length, 1);
    assert.equal(lines[0][0], 'Juris: a subscriber of "a" threw');
    assert.equal(lines[0][1], error);
});

test("the function subscribe answers stops that subscription only, and twice is harmless", () => {
    const juris = headless();
    const { subscribe } = createContext(juris);
    const heard = [];
    const stop = subscribe("a", () => heard.push("first"));
    subscribe("a", () => heard.push("second"));
    stop();
    stop();
    juris.setValue("a", 1);
    assert.deepEqual(heard, ["second"]);
});

test("once every subscription is stopped, a write reaches no callback", () => {
    const juris = headless();
    const { subscribe } = createContext(juris);
    let calls = 0;
    const stops = [subscribe("a", () => (calls += 1)), subscribe("b.c", () => (calls += 1))];
    for (const stop of stops) stop();
    juris.setValue("a", 1);
    juris.setValue("b.c", 1);
    assert.equal(calls, 0);
});

test("one instance's subscriptions share one observer, and another instance's are apart", () => {
    const one = headless();
    const two = headless();
    const before = one.stateManager.observers.size;
    const heard = [];
    createContext(one).subscribe("a", () => heard.push("one a"));
    createContext(one).subscribe("b", () => heard.push("one b"));
    createContext(two).subscribe("a", () => heard.push("two a"));
    assert.equal(one.stateManager.observers.size, before + 1);
    one.setValue("a", 1);
    two.setValue("a", 1);
    assert.deepEqual(heard, ["one a", "two a"]);
});

// ---- HeadlessManager: installing ---------------------------------------------------------------

test("HeadlessManager refuses anything but a Juris instance, and a second manager on one", () => {
    assert.throws(() => new HeadlessManager(), { name: "TypeError", message: "HeadlessManager: give it the Juris instance it serves" });
    assert.throws(() => new HeadlessManager({}), TypeError);
    const juris = headless();
    assert.throws(() => new HeadlessManager(juris), { name: "Error", message: "HeadlessManager: this instance has one already" });
});

test("a manager made by hand installs itself and 0.91's names on the instance", () => {
    const juris = server();
    const manager = new HeadlessManager(juris);
    assert.equal(juris.headlessManager, manager);
    assert.deepEqual(juris.headlessAPIs, {});
    for (const name of [
        "registerHeadlessComponent",
        "initializeHeadlessComponent",
        "initializeQueuedHeadlessComponent",
        "getHeadlessComponent",
        "getHeadlessAPI",
        "registerAndInitHeadless",
        "getHeadlessStatus",
        "createHeadlessContext",
        "createContext",
    ]) {
        assert.equal(typeof juris[name], "function", name);
    }
    assert.deepEqual(juris.getHeadlessStatus(), { registered: [], initialized: [], queued: [], apis: [] });
});

test("an instance's own createContext is kept", () => {
    const juris = server();
    const own = () => "own";
    juris.createContext = own;
    new HeadlessManager(juris);
    assert.equal(juris.createContext, own);
    assert.equal(typeof juris.createHeadlessContext().getState, "function");
});

test("headlessComponents: a function or { fn, options }, made at once only with autoInit, its options as props", () => {
    const log = [];
    const juris = headless({
        headlessComponents: {
            auto: { fn: logged(log, "auto"), options: { autoInit: true, size: 3 } },
            idle: logged(log, "idle"),
            later: { fn: logged(log, "later") },
        },
    });
    assert.deepEqual(log, ["register auto 1"]);
    assert.deepEqual(juris.getHeadlessAPI("auto").props(), { autoInit: true, size: 3 });
    assert.equal(juris.getHeadlessAPI("idle"), undefined);
    assert.deepEqual(juris.getHeadlessStatus(), { registered: ["auto", "idle", "later"], initialized: ["auto"], queued: [], apis: ["auto"] });
    const config = { headlessComponents: { handMade: { fn: logged(log, "hand"), options: { autoInit: true } } } };
    const instance = server();
    new HeadlessManager(instance, config);
    assert.equal(instance.getHeadlessAPI("handMade").n, 1);
});

test("headlessComponents refuses an entry with no function", () => {
    assert.throws(() => headless({ headlessComponents: { bad: null } }), { name: "TypeError", message: 'HeadlessManager.register: "bad" is a function (props, context) => { api, hooks }' });
    assert.throws(() => headless({ headlessComponents: { bad: { options: { autoInit: true } } } }), TypeError);
});

// ---- register and initialize -------------------------------------------------------------------

test("register refuses a name that is not a non-empty string, and a component that is not a function", () => {
    const juris = headless();
    for (const name of ["", undefined, 3]) {
        assert.throws(() => juris.registerHeadlessComponent(name, () => ({})), { name: "TypeError", message: "HeadlessManager.register: name is a non-empty string" });
    }
    assert.throws(() => juris.registerHeadlessComponent("x", "not a function"), { name: "TypeError", message: 'HeadlessManager.register: "x" is a function (props, context) => { api, hooks }' });
    assert.deepEqual(juris.getHeadlessStatus().registered, []);
});

test("register with autoInit makes the component at once, its options as props", () => {
    const juris = headless();
    const log = [];
    juris.registerHeadlessComponent("svc", logged(log), { autoInit: true, a: 1 });
    assert.deepEqual(log, ["register svc 1"]);
    assert.deepEqual(juris.api.svc.props(), { autoInit: true, a: 1 });
    juris.registerHeadlessComponent("other", logged(log, "other"));
    assert.deepEqual(log, ["register svc 1"], "without autoInit: registered, not made");
});

test("initialize answers the instance and publishes its api before onRegister runs", () => {
    const juris = headless();
    let seenOnRegister = null;
    const api = { ok: true };
    juris.registerHeadlessComponent("svc", () => ({ api, hooks: { onRegister: () => (seenOnRegister = juris.api.svc) } }));
    const instance = juris.initializeHeadlessComponent("svc");
    assert.equal(instance.api, api);
    assert.equal(seenOnRegister, api);
    assert.equal(juris.api.svc, api);
    assert.equal(juris.headlessAPIs.svc, api);
    assert.equal(juris.headlessManager.context.svc, api);
    assert.equal(juris.getHeadlessAPI("svc"), api);
    assert.equal(juris.getHeadlessComponent("svc"), instance);
    assert.equal(Object.isFrozen(juris.api), true);
});

test("initialize gives the component its props ({} by default) and a context with the apis made before it", () => {
    const juris = headless();
    const log = [];
    juris.registerHeadlessComponent("first", logged(log, "first"));
    juris.registerHeadlessComponent("second", logged(log, "second"));
    juris.initializeHeadlessComponent("first");
    const second = juris.initializeHeadlessComponent("second", { mode: "x" });
    assert.deepEqual(juris.api.first.props(), {});
    assert.deepEqual(second.api.props(), { mode: "x" });
    const context = second.api.context();
    assert.equal(context.first, juris.api.first);
    assert.equal(context.juris, juris);
    assert.equal(typeof context.subscribe, "function");
});

test("a component may answer an object with no api and no hooks", () => {
    const juris = headless();
    const before = juris.api;
    juris.registerHeadlessComponent("bare", () => ({ state: 1 }));
    const instance = juris.initializeHeadlessComponent("bare");
    assert.deepEqual(instance, { state: 1 });
    assert.equal(juris.api, before, "nothing published");
    assert.deepEqual(juris.getHeadlessStatus(), { registered: ["bare"], initialized: ["bare"], queued: [], apis: [] });
    juris.headlessManager.cleanup();
    assert.equal(juris.api, before);
    assert.equal(juris.getHeadlessComponent("bare"), undefined);
});

test("initialize again ends the old instance first and replaces its api", () => {
    const juris = headless();
    const log = [];
    juris.registerHeadlessComponent("svc", logged(log));
    const first = juris.initializeHeadlessComponent("svc");
    const second = juris.initializeHeadlessComponent("svc");
    assert.deepEqual(log, ["register svc 1", "unregister svc 1", "register svc 2"]);
    assert.equal(juris.api.svc, second.api);
    assert.notEqual(juris.api.svc, first.api);
    assert.equal(juris.getHeadlessComponent("svc"), second);
});

test("register again replaces the function the next initialize makes", () => {
    const juris = headless();
    juris.registerHeadlessComponent("svc", () => ({ api: { version: 1 } }), { autoInit: true });
    juris.registerHeadlessComponent("svc", () => ({ api: { version: 2 } }));
    assert.equal(juris.api.svc.version, 1, "the instance made stays until made again");
    juris.headlessManager.reinitialize("svc");
    assert.equal(juris.api.svc.version, 2);
});

test("what fails is said on the console and answers null: not registered, a throw, no object", () => {
    const juris = headless();
    const error = new Error("no");
    juris.registerHeadlessComponent("throws", () => {
        throw error;
    });
    juris.registerHeadlessComponent("empty", () => null);
    juris.registerHeadlessComponent("primitive", () => 5);
    const lines = said(() => {
        for (const name of ["missing", "throws", "empty", "primitive"]) assert.equal(juris.initializeHeadlessComponent(name), null, name);
    });
    assert.deepEqual(lines, [
        ['HeadlessManager: no headless component "missing" is registered'],
        ['HeadlessManager: "throws" failed to initialize', error],
        ['HeadlessManager: "empty" answered no object ({ api, hooks })'],
        ['HeadlessManager: "primitive" answered no object ({ api, hooks })'],
    ]);
    assert.deepEqual(juris.getHeadlessStatus().initialized, []);
});

test("an onRegister that throws is said and answers null", () => {
    const juris = headless();
    const error = new Error("in onRegister");
    juris.registerHeadlessComponent("svc", () => ({ api: {}, hooks: { onRegister: () => { throw error; } } }));
    const lines = said(() => assert.equal(juris.initializeHeadlessComponent("svc"), null));
    assert.deepEqual(lines, [['HeadlessManager: "svc" failed to initialize', error]]);
});

test("a name the component api already has is refused, as extendApi refuses it", () => {
    const juris = headless();
    juris.extendApi({ plugin: { mine: true } });
    const getState = juris.api.getState;
    juris.registerHeadlessComponent("getState", () => ({ api: { hijacked: true } }));
    juris.registerHeadlessComponent("plugin", () => ({ api: { hijacked: true } }));
    const lines = said(() => {
        assert.equal(juris.initializeHeadlessComponent("getState"), null);
        assert.equal(juris.initializeHeadlessComponent("plugin"), null);
    });
    assert.equal(lines.length, 2);
    assert.equal(lines[0][1].message, 'HeadlessManager: "getState" is a name the component api already has');
    assert.equal(lines[1][1].message, 'HeadlessManager: "plugin" is a name the component api already has');
    assert.equal(juris.api.getState, getState);
    assert.deepEqual(juris.api.plugin, { mine: true });
    assert.equal(juris.getHeadlessAPI("getState"), undefined);
    assert.equal("getState" in juris.headlessAPIs, false);
    assert.throws(() => juris.headlessManager.publish("setValue", {}), { name: "Error", message: 'HeadlessManager: "setValue" is a name the component api already has' });
});

test("a refused initialize leaves nothing made behind it", () => {
    const juris = headless();
    const log = [];
    juris.registerHeadlessComponent("render", logged(log, "render"));
    said(() => assert.equal(juris.initializeHeadlessComponent("render"), null));
    assert.equal(juris.getHeadlessComponent("render"), undefined);
    assert.deepEqual(juris.getHeadlessStatus().initialized, []);
    juris.headlessManager.cleanup();
    assert.deepEqual(log, [], "never registered, so never unregistered");
});

test("a published name cannot be taken by extendApi afterwards", () => {
    const juris = headless();
    juris.registerAndInitHeadless("cart", () => ({ api: {} }));
    assert.throws(() => juris.extendApi({ cart: {} }), /the api already has "cart"/);
});

// ---- reinitialize, cleanup and the rest ----------------------------------------------------------

test("reinitialize makes it again with the props it is given", () => {
    const juris = headless();
    const log = [];
    juris.registerHeadlessComponent("svc", logged(log));
    juris.initializeHeadlessComponent("svc", { a: 1 });
    const again = juris.headlessManager.reinitialize("svc", { a: 2 });
    assert.deepEqual(again.api.props(), { a: 2 });
    assert.deepEqual(juris.headlessManager.reinitialize("svc").api.props(), {});
    assert.deepEqual(log, ["register svc 1", "unregister svc 1", "register svc 2", "unregister svc 2", "register svc 3"]);
});

test("cleanup ends every instance, its onUnregister first, and takes every api away", () => {
    const juris = headless();
    const log = [];
    const before = juris.api;
    juris.registerAndInitHeadless("one", logged(log, "one"));
    juris.registerAndInitHeadless("two", logged(log, "two"));
    juris.headlessManager.cleanup();
    assert.deepEqual(log, ["register one 1", "register two 1", "unregister one 1", "unregister two 1"]);
    assert.deepEqual(juris.headlessAPIs, {});
    assert.deepEqual(juris.headlessManager.getAllAPIs(), {});
    assert.equal("one" in juris.api, false);
    assert.equal("two" in juris.api, false);
    assert.deepEqual(Object.keys(juris.api), Object.keys(before));
    assert.equal(Object.isFrozen(juris.api), true);
    assert.deepEqual(juris.getHeadlessStatus(), { registered: ["one", "two"], initialized: [], queued: [], apis: [] });
});

test("an onUnregister that throws is said, and the instance and its api go all the same", () => {
    const juris = headless();
    const error = new Error("in onUnregister");
    juris.registerAndInitHeadless("svc", () => ({ api: {}, hooks: { onUnregister: () => { throw error; } } }));
    const lines = said(() => juris.headlessManager.cleanup());
    assert.deepEqual(lines, [['HeadlessManager: "svc"\'s onUnregister threw', error]]);
    assert.equal(juris.getHeadlessComponent("svc"), undefined);
    assert.equal("svc" in juris.api, false);
});

test("getAllAPIs answers a copy of the apis by name", () => {
    const juris = headless();
    juris.registerAndInitHeadless("svc", () => ({ api: { ok: 1 } }));
    const all = juris.headlessManager.getAllAPIs();
    assert.deepEqual(all, { svc: { ok: 1 } });
    all.extra = 1;
    assert.equal("extra" in juris.headlessManager.getAllAPIs(), false);
});

test("registerAndInitHeadless registers and makes it, its options as props", () => {
    const juris = headless();
    const log = [];
    const instance = juris.registerAndInitHeadless("svc", logged(log), { mode: "fast" });
    assert.deepEqual(instance.api.props(), { mode: "fast" });
    assert.deepEqual(juris.registerAndInitHeadless("plain", logged(log, "plain")).api.props(), {});
    assert.deepEqual(log, ["register svc 1", "register plain 1"]);
});

test("getHeadlessComponent answers undefined for a component not made", () => {
    const juris = headless();
    juris.registerHeadlessComponent("svc", () => ({ api: {} }));
    assert.equal(juris.getHeadlessComponent("svc"), undefined);
    assert.equal(juris.getHeadlessComponent("nothing"), undefined);
});

test("initializeQueued makes each queued name not yet made, with its registered options, then empties the queue", () => {
    const juris = headless();
    const log = [];
    const manager = juris.headlessManager;
    juris.registerHeadlessComponent("queued", logged(log, "queued"), { size: 2 });
    juris.registerHeadlessComponent("made", logged(log, "made"), { autoInit: true });
    juris.registerHeadlessComponent("noOptions", logged(log, "noOptions"), null);
    for (const name of ["queued", "made", "noOptions", "unregistered"]) manager.initQueue.add(name);
    assert.deepEqual(juris.getHeadlessStatus().queued, ["queued", "made", "noOptions", "unregistered"]);
    const lines = said(() => juris.initializeQueuedHeadlessComponent());
    assert.deepEqual(log, ["register made 1", "register queued 1", "register noOptions 1"]);
    assert.deepEqual(juris.api.queued.props(), { size: 2 });
    assert.deepEqual(juris.api.noOptions.props(), {});
    assert.deepEqual(lines, [['HeadlessManager: no headless component "unregistered" is registered']]);
    assert.deepEqual(juris.getHeadlessStatus().queued, []);
});

test("a headless api reaches every component through its api, in a server render", () => {
    const juris = headless({
        headlessComponents: {
            cart: {
                fn: (props, context) => ({
                    api: {
                        add: (item) => context.setState("cart.items", [...context.getState("cart.items", []), item]),
                        count: () => context.getState("cart.items", []).length,
                    },
                }),
                options: { autoInit: true },
            },
        },
    });
    juris.api.cart.add("pen");
    juris.api.cart.add("ink");
    juris.registerComponent("Count", (props, api) => ({ p: { textContent: () => `${api.cart.count()} item(s)` } }));
    assert.match(juris.renderToString({ Count: {} }), /<p>2 item\(s\)<\/p>/);
});
