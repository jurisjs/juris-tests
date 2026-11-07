// webcomponent.js, an element's life after it connects: drawn again when its state or an observed
// attribute changes (and the options that say otherwise), disposing what it drew each time; the
// hooks; disconnecting and connecting again; a layout that is a promise, a render that throws and a
// layout that cannot be drawn; the context's `component` (state, attributes, emit, slots), a
// contextProvider, and the element's own methods. Drawn on the stand-in browser in
// tests/support/webcomponent-browser.mjs; held to REFERENCE.md's "webcomponent.js" and the
// module's own header.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import Juris from "juris/juris.js";
import { WebComponentFactory } from "juris/webcomponent.js";
import { serialize } from "../support/dom.mjs";
import { installBrowser } from "../support/webcomponent-browser.mjs";

let browser;
beforeEach(() => {
    browser = installBrowser();
});
afterEach(() => {
    browser.restore();
});

const withFactory = (options = {}) => new Juris({ isServer: false, features: { webComponentFactory: WebComponentFactory }, ...options });
const shown = (root) => serialize(root);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

// Collects console.warn and console.error while `fn` runs (awaited, when it answers a promise).
async function saidAsync(fn) {
    const lines = [];
    const original = { warn: console.warn, error: console.error };
    console.warn = console.error = (...args) => lines.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
    try {
        await fn();
    } finally {
        Object.assign(console, original);
    }
    return lines;
}

// A Juris component that says when what drew it is disposed.
function registerProbe(juris, log) {
    juris.registerComponent("Probe", (props, api) => {
        api.onCleanup(() => log.push(`disposed ${props.n}`));
        return { b: `probe ${props.n}` };
    });
}

// ---- drawn again ------------------------------------------------------------------------------

test("a write to the element's state draws it again, disposing what it drew before and keeping the styles", () => {
    const juris = withFactory();
    const log = [];
    registerProbe(juris, log);
    juris.createWebComponent("x-a", { initialState: { n: 1 }, render: (props) => ({ Probe: { n: props.n } }) }, { styles: "b{}" });
    const element = browser.connect(browser.create("x-a"));
    const style = element.shadowRoot.childNodes[0];
    assert.equal(shown(element.shadowRoot), "<style>b{}</style><b>probe 1</b>");
    element.getJurisContext().component.setState("n", 2);
    assert.equal(shown(element.shadowRoot), "<style>b{}</style><b>probe 2</b>");
    assert.deepEqual(log, ["disposed 1"]);
    assert.equal(element.shadowRoot.childNodes[0], style);
});

test("a write beneath the element's path draws it again; a write elsewhere does not", () => {
    const juris = withFactory();
    let draws = 0;
    juris.createWebComponent("x-a", (props) => { draws += 1; return { p: JSON.stringify(props.deep ?? null) }; });
    const element = browser.connect(browser.create("x-a"));
    juris.setValue(`${element.stateKey}.deep.leaf`, 1);
    assert.equal(draws, 2);
    assert.equal(shown(element.shadowRoot), '<p>{"leaf":1}</p>');
    juris.setValue("elsewhere", 1);
    juris.setValue("webcomponents.x_a.other", 1);
    assert.equal(draws, 2);
});

test("only the element whose state was written is drawn again", () => {
    const juris = withFactory();
    const draws = { a: 0, b: 0 };
    juris.createWebComponent("x-a", () => { draws.a += 1; return null; });
    juris.createWebComponent("x-b", () => { draws.b += 1; return null; });
    const a1 = browser.connect(browser.create("x-a"));
    browser.connect(browser.create("x-a"));
    browser.connect(browser.create("x-b"));
    a1.getJurisContext().component.setState("x", 1);
    assert.deepEqual(draws, { a: 3, b: 1 });
});

test("a binding inside what was drawn stops when it is drawn again", () => {
    const juris = withFactory({ state: { label: "one" } });
    let runs = 0;
    juris.createWebComponent("x-a", () => ({ p: { textContent: () => { runs += 1; return juris.getState("label"); } } }));
    const element = browser.connect(browser.create("x-a"));
    element.forceRender();
    assert.equal(runs, 2);
    juris.setValue("label", "two");
    assert.equal(runs, 3);
    assert.equal(shown(element.shadowRoot), "<p>two</p>");
});

test("autoRerender false: a write to the state draws nothing until forceRender", () => {
    const juris = withFactory();
    let draws = 0;
    juris.createWebComponent("x-a", (props) => { draws += 1; return { p: String(props.n ?? 0) }; }, { autoRerender: false });
    const element = browser.connect(browser.create("x-a"));
    element.getJurisContext().component.setState("n", 4);
    assert.equal(draws, 1);
    assert.equal(shown(element.shadowRoot), "<p>0</p>");
    element.forceRender();
    assert.equal(shown(element.shadowRoot), "<p>4</p>");
});

// ---- attributes ----------------------------------------------------------------------------------

test("an observed attribute that changes is written to the state as a value, told to onAttributeChange, and drawn", () => {
    const juris = withFactory();
    const heard = [];
    juris.createWebComponent("x-a", {
        render: (props) => ({ p: `${props.size} ${typeof props.size}` }),
        hooks: { onAttributeChange(name, old, value, context) { heard.push({ self: this, name, old, value, context }); } },
    }, { attributes: ["size"] });
    const element = browser.connect(browser.create("x-a", { size: "1" }));
    element.setAttribute("size", "2");
    assert.equal(shown(element.shadowRoot), "<p>2 number</p>");
    assert.equal(element.getComponentState().size, 2);
    assert.equal(heard.length, 1);
    assert.deepEqual({ ...heard[0], self: undefined, context: undefined }, { self: undefined, name: "size", old: "1", value: "2", context: undefined });
    assert.equal(heard[0].self, element);
    assert.equal(heard[0].context, element.getJurisContext());
});

test("an attribute set to the value it had changes nothing", () => {
    const juris = withFactory();
    let draws = 0;
    let told = 0;
    juris.createWebComponent("x-a", { render: () => { draws += 1; return null; }, hooks: { onAttributeChange: () => { told += 1; } } }, { attributes: ["size"] });
    const element = browser.connect(browser.create("x-a", { size: "1" }));
    element.setAttribute("size", "1");
    assert.equal(draws, 1);
    assert.equal(told, 0);
});

test("an attribute that changes before the element connects is read when it connects, and told to nobody", () => {
    const juris = withFactory();
    let told = 0;
    juris.createWebComponent("x-a", { render: (props) => ({ p: props.name }), hooks: { onAttributeChange: () => { told += 1; } } }, { attributes: ["name"] });
    const element = browser.create("x-a", { name: "first" });
    element.setAttribute("name", "second");
    assert.equal(told, 0);
    browser.connect(element);
    assert.equal(shown(element.shadowRoot), "<p>second</p>");
    assert.equal(told, 0);
});

test("an observed attribute removed is null in the state", () => {
    const juris = withFactory();
    const props = [];
    juris.createWebComponent("x-a", (given) => { props.push(given); return null; }, { attributes: ["name"] });
    const element = browser.connect(browser.create("x-a", { name: "Ada" }));
    element.removeAttribute("name");
    assert.equal(element.getComponentState().name, null);
    assert.deepEqual(props.at(-1), { name: null });
});

test("an unobserved attribute changes nothing", () => {
    const juris = withFactory();
    let draws = 0;
    juris.createWebComponent("x-a", () => { draws += 1; return null; }, { attributes: ["name"] });
    const element = browser.connect(browser.create("x-a"));
    element.setAttribute("other", "x");
    assert.equal(draws, 1);
    assert.deepEqual(element.getComponentState(), {});
});

test("autoRerender false: an attribute change still draws again, unless rerenderOnAttributeChange is false", () => {
    const juris = withFactory();
    const draws = { on: 0, off: 0 };
    juris.createWebComponent("x-on", (props) => { draws.on += 1; return { p: props.v }; }, { attributes: ["v"], autoRerender: false });
    juris.createWebComponent("x-off", (props) => { draws.off += 1; return { p: props.v }; }, { attributes: ["v"], autoRerender: false, rerenderOnAttributeChange: false });
    const on = browser.connect(browser.create("x-on", { v: "a" }));
    const off = browser.connect(browser.create("x-off", { v: "a" }));
    on.setAttribute("v", "b");
    off.setAttribute("v", "b");
    assert.deepEqual(draws, { on: 2, off: 1 });
    assert.equal(shown(on.shadowRoot), "<p>b</p>");
    assert.equal(shown(off.shadowRoot), "<p>a</p>");
    assert.equal(off.getComponentState().v, "b");
});

test("an attribute change after the state was cleared starts the state again from it", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", (props) => ({ p: JSON.stringify(props) }), { attributes: ["v"] });
    const element = browser.connect(browser.create("x-a", { v: "1" }));
    juris.clearState({});
    element.setAttribute("v", "2");
    assert.deepEqual(element.getComponentState(), { v: 2 });
    assert.equal(shown(element.shadowRoot), '<p>{"v":2}</p>');
});

// ---- stateNamespace ----------------------------------------------------------------------------------

test("stateNamespace puts every element of the kind at one path, and a write there draws each", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", { initialState: { n: 0 }, render: (props) => ({ p: String(props.n) }) }, { stateNamespace: "shared.counter", cleanupState: false });
    const one = browser.connect(browser.create("x-a"));
    const two = browser.connect(browser.create("x-a"));
    assert.equal(one.stateKey, "shared.counter");
    assert.equal(two.stateKey, "shared.counter");
    one.getJurisContext().component.setState("n", 5);
    assert.equal(shown(one.shadowRoot), "<p>5</p>");
    assert.equal(shown(two.shadowRoot), "<p>5</p>");
    browser.disconnect(one);
    juris.setValue("shared.counter.n", 6);
    assert.equal(shown(two.shadowRoot), "<p>6</p>");
    assert.equal(shown(one.shadowRoot), "");
});

// ---- hooks ---------------------------------------------------------------------------------------------

test("onConnect runs before the first draw and onMount on the next animation frame, each on the element with its context", () => {
    const juris = withFactory();
    const order = [];
    juris.createWebComponent("x-a", {
        render() { order.push("render"); return null; },
        hooks: {
            onConnect(context) { order.push(["connect", this, context]); },
            onMount(context) { order.push(["mount", this, context]); },
        },
    });
    const element = browser.connect(browser.create("x-a"));
    const context = element.getJurisContext();
    assert.deepEqual(order, [["connect", element, context], "render"]);
    assert.equal(browser.frames.length, 1);
    assert.equal(browser.runFrames(), 1);
    assert.deepEqual(order, [["connect", element, context], "render", ["mount", element, context]]);
});

test("no onMount, no animation frame", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", () => null);
    browser.connect(browser.create("x-a"));
    assert.equal(browser.frames.length, 0);
});

// ---- disconnected, connected again -----------------------------------------------------------------------

test("disconnected, an element stops watching, runs onUnmount, disposes what it drew and deletes its state", () => {
    const juris = withFactory();
    const log = [];
    registerProbe(juris, log);
    let draws = 0;
    juris.createWebComponent("x-a", {
        initialState: { n: 1 },
        render: (props) => { draws += 1; return { Probe: { n: props.n } }; },
        hooks: { onUnmount(context) { log.push(["unmount", this, context]); } },
    }, { styles: "b{}" });
    const element = browser.connect(browser.create("x-a"));
    const context = element.getJurisContext();
    const key = element.stateKey;
    browser.disconnect(element);
    assert.deepEqual(log, [["unmount", element, context], "disposed 1"]);
    assert.equal(shown(element.shadowRoot), "<style>b{}</style>");
    assert.equal(juris.getState(key), undefined);
    assert.deepEqual(element.getComponentState(), {});
    juris.setValue(`${key}.n`, 2);
    assert.equal(draws, 1);
    assert.equal(shown(element.shadowRoot), "<style>b{}</style>");
});

test("cleanupState false keeps the state when the element is disconnected", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", { initialState: { n: 1 }, render: () => null }, { cleanupState: false });
    const element = browser.connect(browser.create("x-a"));
    browser.disconnect(element);
    assert.deepEqual(juris.getState(element.stateKey), { n: 1 });
});

test("connected again, it draws again into the same root, with its initial state and a new context", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", { initialState: { n: 1 }, render: (props) => ({ p: `${props.n} ${props.name}` }) }, { styles: "p{}", attributes: ["name"] });
    const element = browser.connect(browser.create("x-a", { name: "Ada" }));
    const root = element.renderRoot;
    const firstContext = element.getJurisContext();
    element.getJurisContext().component.setState("n", 9);
    browser.disconnect(element);
    element.setAttribute("name", "Bob");
    browser.connect(element);
    assert.equal(element.renderRoot, root);
    assert.equal(element.shadowRoot, root);
    assert.equal(shown(root), "<style>p{}</style><p>1 Bob</p>");
    assert.notEqual(element.getJurisContext(), firstContext);
    element.getJurisContext().component.setState("n", 3);
    assert.equal(shown(root), "<style>p{}</style><p>3 Bob</p>");
});

test("an element that never drew, disconnected, has nothing to dispose or delete", () => {
    const juris = withFactory({ state: { keep: 1 } });
    juris.createWebComponent("x-a", () => ({ p: "x" }), { autoConnect: false });
    const element = browser.connect(browser.create("x-a"));
    browser.disconnect(element);
    assert.equal(element.renderRoot, null);
    assert.deepEqual(juris.getState("keep"), 1);
});

// ---- a layout that is a promise ----------------------------------------------------------------------------

test("a layout that is a promise shows the loading div until it settles, then what it answers", async () => {
    const juris = withFactory();
    const pending = deferred();
    juris.createWebComponent("x-a", () => pending.promise, { styles: "p{}" });
    const element = browser.connect(browser.create("x-a"));
    assert.equal(shown(element.shadowRoot), '<style>p{}</style><div class="juris-loading">Loading...</div>');
    pending.resolve({ p: "loaded" });
    await flush();
    assert.equal(shown(element.shadowRoot), "<style>p{}</style><p>loaded</p>");
});

test("a layout promise that rejects shows its message, said on the console", async () => {
    const juris = withFactory();
    const pending = deferred();
    juris.createWebComponent("x-a", () => pending.promise);
    let element;
    const lines = await saidAsync(async () => {
        element = browser.connect(browser.create("x-a"));
        pending.reject(new Error("fetch failed"));
        await flush();
    });
    assert.equal(shown(element.shadowRoot), "<div>Component Error: fetch failed</div>");
    assert.deepEqual(lines, ['Juris: the web component "x-a" failed to render fetch failed']);
});

test("a draw superseded before its promise settles is dropped, answer or rejection", async () => {
    const juris = withFactory();
    const slow = [deferred(), deferred()];
    let call = 0;
    juris.createWebComponent("x-a", (props) => (props.sync ? { p: "sync" } : slow[call++].promise));
    const element = browser.connect(browser.create("x-a"));
    element.forceRender();
    element.getJurisContext().component.setState("sync", true);
    assert.equal(shown(element.shadowRoot), "<p>sync</p>");
    const lines = await saidAsync(async () => {
        slow[0].resolve({ p: "stale" });
        slow[1].reject(new Error("stale"));
        await flush();
    });
    assert.equal(shown(element.shadowRoot), "<p>sync</p>");
    assert.deepEqual(lines, []);
});

test("a layout promise that settles after the element is disconnected draws nothing", async () => {
    const juris = withFactory();
    const answers = [deferred(), deferred()];
    let call = 0;
    juris.createWebComponent("x-a", () => answers[call++].promise);
    const one = browser.connect(browser.create("x-a"));
    const two = browser.connect(browser.create("x-a"));
    browser.disconnect(one);
    browser.disconnect(two);
    const lines = await saidAsync(async () => {
        answers[0].resolve({ p: "late" });
        answers[1].reject(new Error("late"));
        await flush();
    });
    assert.equal(shown(one.shadowRoot), "");
    assert.equal(shown(two.shadowRoot), "");
    assert.deepEqual(lines, []);
});

test("a layout promise that settles with nothing takes the loading div away", async () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", () => Promise.resolve(null));
    const element = browser.connect(browser.create("x-a"));
    await flush();
    assert.equal(shown(element.shadowRoot), "");
});

// The root is a shadow root, which has no attributes: the element it belongs to shows the wait.
test("a component in the shadow root, whose root function waits on a slow promise, marks the element", async () => {
    const juris = withFactory({ pendingDelay: 0 });
    const value = deferred();
    juris.registerComponent("Lazy", () => () => value.promise);
    juris.createWebComponent("x-a", () => ({ Lazy: {} }));
    const element = browser.connect(browser.create("x-a"));
    await flush();
    assert.equal(element.hasAttribute("data-pending"), true);
    value.resolve({ p: "drawn" });
    await flush();
    assert.equal(element.hasAttribute("data-pending"), false);
    assert.equal(shown(element.shadowRoot), "<p>drawn</p>");
});

// ---- errors ----------------------------------------------------------------------------------------------

test("a render that throws shows its message instead, said on the console", async () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", () => { throw new Error("bad props"); });
    let element;
    const lines = await saidAsync(() => { element = browser.connect(browser.create("x-a")); });
    assert.equal(shown(element.shadowRoot), "<div>Component Error: bad props</div>");
    const box = element.shadowRoot.childNodes[0];
    assert.equal(box.style.color, "red");
    assert.equal(box.style.border, "1px solid red");
    assert.deepEqual(lines, ['Juris: the web component "x-a" failed to render bad props']);
});

test("a throw that is not an Error shows what was thrown", async () => {
    const juris = withFactory();
    juris.createWebComponent("x-str", () => { throw "plain words"; });
    juris.createWebComponent("x-null", () => { throw null; });
    let str;
    let nil;
    await saidAsync(() => {
        str = browser.connect(browser.create("x-str"));
        nil = browser.connect(browser.create("x-null"));
    });
    assert.equal(shown(str.shadowRoot), "<div>Component Error: plain words</div>");
    assert.equal(shown(nil.shadowRoot), "<div>Component Error: null</div>");
});

test("a layout the renderer cannot draw shows the renderer's error instead", async () => {
    const juris = withFactory({ unknownComponents: "throw" });
    juris.createWebComponent("x-list", () => [{ p: "a" }, { p: "b" }]);
    juris.createWebComponent("x-unknown", () => ({ Missing: {} }));
    let list;
    let unknown;
    const lines = await saidAsync(() => {
        list = browser.connect(browser.create("x-list"));
        unknown = browser.connect(browser.create("x-unknown"));
    });
    assert.match(shown(list.shadowRoot), /^<div>Component Error: Juris: a layout is one \{ tag: content \} object/);
    assert.equal(shown(unknown.shadowRoot), '<div>Component Error: Juris: "Missing" is not a registered component (unknownComponents: "throw")</div>');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^Juris: the web component "x-list" failed to render/);
});

test("a draw that answers nothing after drawing something leaves the root empty", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", { initialState: { open: true }, render: (props) => (props.open ? { p: "open" } : null) });
    const element = browser.connect(browser.create("x-a"));
    assert.equal(shown(element.shadowRoot), "<p>open</p>");
    element.getJurisContext().component.setState("open", false);
    assert.equal(shown(element.shadowRoot), "");
});

// ---- the context ------------------------------------------------------------------------------------------

test("the context is the element's createContext, with component beside it", () => {
    const juris = withFactory({ services: { greet: () => "hi" } });
    juris.createWebComponent("x-a", () => null);
    const element = browser.connect(browser.create("x-a"));
    const context = element.getJurisContext();
    assert.equal(context.element, element);
    assert.equal(context.juris, juris);
    assert.equal(context.isSSR, false);
    assert.equal(typeof context.subscribe, "function");
    assert.equal(typeof context.greet, "function");
    assert.deepEqual(Object.keys(context.component).sort(), ["element", "emit", "getAllSlots", "getAttribute", "getSlot", "getState", "id", "name", "renderRoot", "setAttribute", "setState", "shadowRoot", "updateState"]);
    assert.equal(context.component.name, "x-a");
    assert.equal(context.component.id, "x-a-1");
    assert.equal(context.component.element, element);
});

test("component.getState reads the element's state, the whole of it without a key, a default for nothing", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", { initialState: { a: 1, nested: { b: 2 } }, render: () => null });
    const { component } = browser.connect(browser.create("x-a")).getJurisContext();
    assert.equal(component.getState("a"), 1);
    assert.equal(component.getState("nested.b"), 2);
    assert.deepEqual(component.getState(), { a: 1, nested: { b: 2 } });
    assert.equal(component.getState("missing"), null);
    assert.equal(component.getState("missing", "fallback"), "fallback");
});

test("component.setState writes one key or merges an object; updateState merges; each draws once", () => {
    const juris = withFactory();
    let draws = 0;
    juris.createWebComponent("x-a", { initialState: { a: 1, b: 2 }, render: () => { draws += 1; return null; } });
    const element = browser.connect(browser.create("x-a"));
    const { component } = element.getJurisContext();
    component.setState("a", 10);
    assert.deepEqual(element.getComponentState(), { a: 10, b: 2 });
    component.setState({ b: 20, c: 30 });
    assert.deepEqual(element.getComponentState(), { a: 10, b: 20, c: 30 });
    component.updateState({ a: 0 });
    assert.deepEqual(element.getComponentState(), { a: 0, b: 20, c: 30 });
    assert.equal(draws, 4);
});

test("component.setState and updateState start the state again when it was cleared", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", { initialState: { a: 1 }, render: (props) => ({ p: JSON.stringify(props) }) });
    const element = browser.connect(browser.create("x-a"));
    const { component } = element.getJurisContext();
    juris.clearState({});
    component.setState({ b: 2 });
    assert.deepEqual(element.getComponentState(), { b: 2 });
    juris.clearState({});
    component.updateState({ c: 3 });
    assert.deepEqual(element.getComponentState(), { c: 3 });
    juris.clearState({});
    element.forceRender();
    assert.equal(shown(element.shadowRoot), "<p>{}</p>");
});

test("component.getAttribute reads the element's attribute, a default when it is absent", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", () => null);
    const element = browser.connect(browser.create("x-a", { name: "Ada" }));
    const { component } = element.getJurisContext();
    assert.equal(component.getAttribute("name"), "Ada");
    assert.equal(component.getAttribute("name", "other"), "Ada");
    assert.equal(component.getAttribute("absent"), null);
    assert.equal(component.getAttribute("absent", "default"), "default");
});

test("component.getAttribute reads a bare attribute as the empty string, not as the default", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", () => null);
    const element = browser.connect(browser.create("x-a", { disabled: "" }));
    assert.equal(element.getJurisContext().component.getAttribute("disabled", "absent"), "");
});

test("component.setAttribute sets the element's attribute, which an observed one draws", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", (props) => ({ p: String(props.open) }), { attributes: ["open"] });
    const element = browser.connect(browser.create("x-a"));
    element.getJurisContext().component.setAttribute("open", "true");
    assert.equal(element.getAttribute("open"), "true");
    assert.equal(element.getComponentState().open, true);
    assert.equal(shown(element.shadowRoot), "<p>true</p>");
    element.getJurisContext().component.setAttribute("data-x", 1);
    assert.equal(element.getAttribute("data-x"), "1");
});

test("component.emit dispatches a CustomEvent on the element, bubbling and composed, and answers it", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", () => null);
    const element = browser.connect(browser.create("x-a"));
    const heard = [];
    element.addEventListener("picked", (event) => heard.push(event));
    const event = element.getJurisContext().component.emit("picked", { id: 7 });
    assert.ok(event instanceof CustomEvent);
    assert.equal(event.type, "picked");
    assert.deepEqual(event.detail, { id: 7 });
    assert.equal(event.bubbles, true);
    assert.equal(event.composed, true);
    assert.deepEqual(heard, [event]);
    assert.deepEqual(element.events, [event]);
});

test("component.emit's detail is an empty object unless given, and its options are the caller's to change", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", () => null);
    const element = browser.connect(browser.create("x-a"));
    const plain = element.getJurisContext().component.emit("ping");
    assert.deepEqual(plain.detail, {});
    const local = element.getJurisContext().component.emit("local", null, { bubbles: false, composed: false, cancelable: true });
    assert.equal(local.detail, null);
    assert.equal(local.bubbles, false);
    assert.equal(local.composed, false);
    assert.equal(local.cancelable, true);
});

test("component.getSlot finds the first child given to a slot, or with no slot at all", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", () => null);
    const element = browser.create("x-a");
    const child = (slot, text) => {
        const node = document.createElement("span");
        if (slot !== null) node.setAttribute("slot", slot);
        node.textContent = text;
        element.appendChild(node);
        return node;
    };
    const title = child("title", "Title");
    child("title", "Second title");
    const plain = child(null, "body");
    const tricky = child('x"],[slot', "tricky");
    browser.connect(element);
    const { component } = element.getJurisContext();
    assert.equal(component.getSlot("title"), title);
    assert.equal(component.getSlot(), plain);
    assert.equal(component.getSlot(""), plain);
    assert.equal(component.getSlot("missing"), null);
    // The name is escaped into the selector: it names that slot and nothing else.
    assert.equal(component.getSlot('x"],[slot'), tricky);
});

test("component.getAllSlots groups the slotted children by slot name, in order", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", () => null);
    const element = browser.create("x-a");
    const nodes = ["a", "b", "a", null].map((slot) => {
        const node = document.createElement("i");
        if (slot) node.setAttribute("slot", slot);
        element.appendChild(node);
        return node;
    });
    browser.connect(element);
    const slots = element.getJurisContext().component.getAllSlots();
    assert.deepEqual(Object.keys(slots), ["a", "b"]);
    assert.equal(slots.a.length, 2);
    assert.equal(slots.a[0], nodes[0]);
    assert.equal(slots.a[1], nodes[2]);
    assert.deepEqual(slots.b, [nodes[1]]);
    assert.deepEqual(browser.connect(browser.create("x-a")).getJurisContext().component.getAllSlots(), {});
});

test("a contextProvider is called on the element with its createContext, and what it answers is the context", () => {
    const juris = withFactory();
    const seen = [];
    juris.createWebComponent("x-a", (props, context) => ({ p: context.greeting }), {
        contextProvider(context) {
            seen.push([this, context.element, typeof context.getState]);
            return { greeting: "provided", element: context.element };
        },
    });
    const element = browser.connect(browser.create("x-a"));
    assert.deepEqual(seen, [[element, element, "function"]]);
    const context = element.getJurisContext();
    assert.deepEqual(Object.keys(context).sort(), ["component", "element", "greeting"]);
    assert.equal(shown(element.shadowRoot), "<p>provided</p>");
    assert.equal(context.component.element, element);
});

// ---- the element's methods ----------------------------------------------------------------------------------

test("updateComponentState merges into the element's state and draws it again", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", { initialState: { a: 1 }, render: (props) => ({ p: `${props.a} ${props.b}` }) });
    const element = browser.connect(browser.create("x-a"));
    element.updateComponentState({ b: 2 });
    assert.deepEqual(element.getComponentState(), { a: 1, b: 2 });
    assert.equal(shown(element.shadowRoot), "<p>1 2</p>");
});

test("render and forceRender draw again from the state as it is", () => {
    const juris = withFactory();
    let draws = 0;
    juris.createWebComponent("x-a", () => { draws += 1; return { p: String(draws) }; });
    const element = browser.connect(browser.create("x-a"));
    element.render();
    element.forceRender();
    assert.equal(draws, 3);
    assert.equal(shown(element.shadowRoot), "<p>3</p>");
});
