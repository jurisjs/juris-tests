// webcomponent.js, the factory and what an element is when it connects: WebComponentFactory's
// refusals and how it installs itself, create / createMultiple and their options, the element class
// (observed attributes, ids, state paths), the forms a definition takes, the initial state and the
// attributes read as values, and where the layout is drawn (an open or closed shadow root after the
// styles, the element itself in enhanceMode, nothing without autoConnect). Drawn on the stand-in
// browser in tests/support/webcomponent-browser.mjs. Held to REFERENCE.md's "webcomponent.js" and
// the module's own header. Re-draws, hooks, async layouts, errors and the context are in
// webcomponent.lifecycle.test.mjs.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import Juris from "juris/juris.js";
import { WebComponentFactory } from "juris/webcomponent.js";
import { serialize } from "../support/dom.mjs";
import { installBrowser, FakeHTMLElement } from "../support/webcomponent-browser.mjs";

let browser;
beforeEach(() => {
    browser = installBrowser();
});
afterEach(() => {
    browser.restore();
});

const withFactory = (options = {}) => new Juris({ isServer: false, features: { webComponentFactory: WebComponentFactory }, ...options });

// What a root holds, as markup.
const shown = (root) => (root ? serialize(root) : null);

// Runs `fn` with console.warn and console.error collected.
function said(fn) {
    const warned = [];
    const errored = [];
    const original = { warn: console.warn, error: console.error };
    console.warn = (...args) => warned.push(args.map(String).join(" "));
    console.error = (...args) => errored.push(args.map(String).join(" "));
    try {
        return { result: fn(), warned, errored };
    } finally {
        Object.assign(console, original);
    }
}

// ---- the factory ------------------------------------------------------------------------------

test("the factory refuses anything but the Juris instance it draws with", () => {
    for (const juris of [undefined, null, {}, { render: "no" }, 5]) {
        assert.throws(() => new WebComponentFactory(juris), { name: "TypeError", message: "WebComponentFactory: give it the Juris instance it draws with" });
    }
});

test("given as a feature, the factory installs itself on the instance", () => {
    const juris = withFactory();
    assert.ok(juris.webComponentFactory instanceof WebComponentFactory);
    assert.equal(juris.webComponentFactory.juris, juris);
    assert.equal(typeof juris.createWebComponent, "function");
    assert.equal(typeof juris.createWebComponents, "function");
});

test("made on an instance already built, the factory installs itself the same way", () => {
    const juris = new Juris({ isServer: false });
    assert.equal(juris.createWebComponent, undefined);
    const factory = new WebComponentFactory(juris);
    assert.equal(juris.webComponentFactory, factory);
    const Element = juris.createWebComponent("x-late", () => ({ p: "late" }));
    assert.equal(browser.customElements.get("x-late"), Element);
    const many = juris.createWebComponents({ "x-later": () => null });
    assert.equal(browser.customElements.get("x-later"), many["x-later"]);
});

// ---- create -------------------------------------------------------------------------------------

test("a name without a hyphen is refused", () => {
    const juris = withFactory();
    for (const [name, text] of [["card", "card"], ["", ""], [5, "5"], [null, "null"], [undefined, "undefined"]]) {
        assert.throws(() => juris.createWebComponent(name, () => null), { name: "Error", message: `WebComponent name "${text}" must contain a hyphen (-)` });
    }
    assert.deepEqual(browser.customElements.names, []);
});

test("with no custom elements to define into, create refuses", () => {
    const juris = withFactory();
    delete globalThis.customElements;
    assert.throws(() => juris.createWebComponent("x-a", () => null), { name: "Error", message: "WebComponentFactory: custom elements need a browser" });
});

test("create defines the name and answers its class, an HTMLElement", () => {
    const juris = withFactory();
    const Element = juris.createWebComponent("user-card", () => ({ p: "hi" }));
    assert.equal(browser.customElements.get("user-card"), Element);
    assert.ok(Element.prototype instanceof FakeHTMLElement);
    assert.deepEqual(browser.customElements.names, ["user-card"]);
});

test("a name defined already answers the class it has, says so, and defines nothing", () => {
    const juris = withFactory();
    const first = juris.createWebComponent("x-a", () => ({ p: "first" }));
    const { result, warned } = said(() => juris.createWebComponent("x-a", () => ({ p: "second" })));
    assert.equal(result, first);
    assert.deepEqual(warned, ['Juris: the web component "x-a" is defined already']);
    const element = browser.connect(browser.create("x-a"));
    assert.equal(shown(element.shadowRoot), "<p>first</p>");

    class Theirs extends FakeHTMLElement {}
    browser.customElements.define("x-theirs", Theirs);
    assert.equal(said(() => juris.createWebComponent("x-theirs", () => null)).result, Theirs);
});

test("createMultiple defines each, its own options over the global ones", () => {
    const juris = withFactory();
    const drawn = [];
    const created = juris.createWebComponents(
        {
            "x-fn": (props) => { drawn.push("fn"); return { p: `fn ${props.v}` }; },
            "x-wrapped": { component: (props) => { drawn.push("wrapped"); return { p: `wrapped ${props.v}` }; }, options: { shadowMode: "closed", styles: "b{}" } },
            "x-object": { render: (props) => { drawn.push("object"); return { p: `object ${props.v}` }; } },
        },
        { styles: "a{}", attributes: ["v"] },
    );
    assert.deepEqual(Object.keys(created), ["x-fn", "x-wrapped", "x-object"]);
    for (const [name, Element] of Object.entries(created)) {
        assert.equal(browser.customElements.get(name), Element);
        assert.deepEqual(Element.observedAttributes, ["v"]);
    }
    const fn = browser.connect(browser.create("x-fn", { v: "1" }));
    const wrapped = browser.connect(browser.create("x-wrapped", { v: "2" }));
    const object = browser.connect(browser.create("x-object", { v: "3" }));
    assert.equal(shown(fn.shadowRoot), "<style>a{}</style><p>fn 1</p>");
    assert.equal(wrapped.shadowRoot, null);
    assert.equal(wrapped.attachedShadowRoot.mode, "closed");
    assert.equal(shown(wrapped.renderRoot), "<style>b{}</style><p>wrapped 2</p>");
    assert.equal(shown(object.shadowRoot), "<style>a{}</style><p>object 3</p>");
    assert.deepEqual(drawn, ["fn", "wrapped", "object"]);
});

test("createMultiple takes no global options, and a definition of nothing draws nothing", () => {
    const juris = withFactory();
    const { result, warned } = said(() => {
        const created = juris.webComponentFactory.createMultiple({ "x-none": null });
        browser.connect(browser.create("x-none"));
        return created;
    });
    assert.deepEqual(result["x-none"].observedAttributes, []);
    assert.deepEqual(warned, ['Juris: the web component "x-none" has no render, component or template']);
});

// ---- the element class ----------------------------------------------------------------------------

test("observedAttributes are the attributes option, frozen, as they were when the class was made", () => {
    const juris = withFactory();
    const attributes = ["name", "size"];
    const Element = juris.createWebComponent("x-a", () => null, { attributes });
    attributes.push("late");
    assert.deepEqual(Element.observedAttributes, ["name", "size"]);
    assert.ok(Object.isFrozen(Element.observedAttributes));
    assert.deepEqual(juris.createWebComponent("x-b", () => null).observedAttributes, []);
});

test("each element of a kind has its own id, and its own state path under webcomponents", () => {
    const juris = withFactory();
    const draw = () => ({ p: "x" });
    juris.createWebComponent("user-card-item", draw);
    juris.createWebComponent("x-other", draw);
    const one = browser.create("user-card-item");
    const two = browser.create("user-card-item");
    const other = browser.create("x-other");
    assert.equal(one.componentId, "user-card-item-1");
    assert.equal(two.componentId, "user-card-item-2");
    assert.equal(other.componentId, "x-other-1");
    assert.equal(one.componentName, "user-card-item");
    assert.equal(one.isJurisComponent, true);
    assert.equal(one.componentFn, draw);
    assert.equal(one.componentConfig, null);
    assert.equal(one.stateKey, null);
    assert.equal(one.renderRoot, null);
    browser.connect(one);
    browser.connect(two);
    assert.equal(one.stateKey, "webcomponents.user_card_item.user-card-item-1");
    assert.equal(two.stateKey, "webcomponents.user_card_item.user-card-item-2");
});

test("a definition is a function, or an object's render, component or template, in that order", () => {
    const juris = withFactory();
    const pick = (name) => () => ({ p: name });
    const definitions = {
        "x-render": { render: pick("render"), component: pick("component"), template: pick("template") },
        "x-component": { component: pick("component"), template: pick("template") },
        "x-template": { template: pick("template") },
    };
    for (const [name, definition] of Object.entries(definitions)) {
        juris.createWebComponent(name, definition);
        const element = browser.connect(browser.create(name));
        assert.equal(element.componentConfig, definition);
        assert.equal(shown(element.shadowRoot), `<p>${name.slice(2)}</p>`, name);
    }
});

test("the layout is drawn with the props and the context, the element as this", () => {
    const juris = withFactory();
    const calls = [];
    juris.createWebComponent("x-a", function draw(props, context) {
        calls.push({ self: this, props, context });
        return { p: "x" };
    }, { attributes: ["name"] });
    const element = browser.connect(browser.create("x-a", { name: "Ada" }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].self, element);
    assert.deepEqual(calls[0].props, { name: "Ada" });
    assert.equal(calls[0].context, element.getJurisContext());
    assert.equal(calls[0].context.component.element, element);
});

test("a definition with nothing to draw says so, and draws nothing", () => {
    const juris = withFactory();
    juris.createWebComponent("x-empty", { initialState: { a: 1 } }, { styles: "p{}" });
    const { result: element, warned } = said(() => browser.connect(browser.create("x-empty")));
    assert.deepEqual(warned, ['Juris: the web component "x-empty" has no render, component or template']);
    assert.equal(shown(element.shadowRoot), "<style>p{}</style>");
    assert.deepEqual(element.getComponentState(), { a: 1 });
});

// ---- where it is drawn ------------------------------------------------------------------------------

test("the layout is drawn into an open shadow root, after the styles", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", () => ({ div: { className: "card", children: "hello" } }), { styles: ":host { display: block }" });
    const element = browser.connect(browser.create("x-a"));
    assert.equal(element.attachedShadowRoot.mode, "open");
    assert.equal(element.shadowRoot, element.renderRoot);
    assert.equal(element.renderRoot.host, element);
    assert.equal(shown(element.shadowRoot), '<style>:host { display: block }</style><div class="card">hello</div>');
    assert.deepEqual(element.childNodes, []);
    const { component } = element.getJurisContext();
    assert.equal(component.renderRoot, element.renderRoot);
    assert.equal(component.shadowRoot, element.renderRoot);
});

test("a closed shadow root is drawn into, and not exposed as shadowRoot", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", () => ({ p: "secret" }), { shadowMode: "closed" });
    const element = browser.connect(browser.create("x-a"));
    assert.equal(element.shadowRoot, null);
    assert.equal(element.renderRoot, element.attachedShadowRoot);
    assert.equal(element.renderRoot.mode, "closed");
    assert.equal(shown(element.renderRoot), "<p>secret</p>");
    const { component } = element.getJurisContext();
    assert.equal(component.shadowRoot, null);
    assert.equal(component.renderRoot, element.renderRoot);
});

test("no styles, no style element", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", () => ({ p: "x" }));
    const element = browser.connect(browser.create("x-a"));
    assert.equal(shown(element.shadowRoot), "<p>x</p>");
});

test("enhanceMode draws into the element itself, with no shadow root and no styles", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", (props) => ({ span: `count ${props.count}` }), { enhanceMode: true, styles: "p{}", attributes: ["count"] });
    const element = browser.connect(browser.create("x-a", { count: "2" }));
    assert.equal(element.renderRoot, element);
    assert.equal(element.attachedShadowRoot, null);
    assert.equal(element.shadowRoot, null);
    assert.equal(element.childNodes.map(serialize).join(""), "<span>count 2</span>");
    element.setAttribute("count", "3");
    assert.equal(element.childNodes.map(serialize).join(""), "<span>count 3</span>");
});

test("autoConnect false: connecting draws nothing, attaches nothing and writes no state", () => {
    const juris = withFactory();
    let draws = 0;
    juris.createWebComponent("x-a", () => { draws += 1; return { p: "x" }; }, { autoConnect: false, initialState: { a: 1 } });
    const element = browser.connect(browser.create("x-a"));
    assert.equal(element.renderRoot, null);
    assert.equal(element.attachedShadowRoot, null);
    assert.equal(element.stateKey, null);
    assert.equal(juris.getState("webcomponents"), undefined);
    element.render();
    element.forceRender();
    assert.equal(draws, 0);
});

// ---- the initial state ------------------------------------------------------------------------------

test("the initial state is the definition's initialState, copied for each element", () => {
    const juris = withFactory();
    const initialState = { open: false, count: 1 };
    juris.createWebComponent("x-a", { initialState, render: (props) => ({ p: `${props.open} ${props.count}` }) });
    const one = browser.connect(browser.create("x-a"));
    const two = browser.connect(browser.create("x-a"));
    assert.deepEqual(juris.getState(one.stateKey), { open: false, count: 1 });
    one.getJurisContext().component.setState("count", 5);
    assert.deepEqual(two.getComponentState(), { open: false, count: 1 });
    assert.deepEqual(initialState, { open: false, count: 1 });
    assert.equal(shown(one.shadowRoot), "<p>false 5</p>");
});

test("initialState may be a function, called on the element; one that answers nothing is an empty state", () => {
    const juris = withFactory();
    const seen = [];
    juris.createWebComponent("x-a", { initialState() { seen.push(this); return { id: this.componentId }; }, render: () => null });
    juris.createWebComponent("x-b", { initialState: () => null, render: () => null });
    const element = browser.connect(browser.create("x-a"));
    assert.deepEqual(seen, [element]);
    assert.deepEqual(element.getComponentState(), { id: "x-a-1" });
    assert.deepEqual(browser.connect(browser.create("x-b")).getComponentState(), {});
});

test("a draw function's getInitialState is merged over initialState, called on the element", () => {
    const juris = withFactory();
    const seen = [];
    const draw = () => null;
    draw.getInitialState = function () {
        seen.push(this);
        return { b: 2, a: "over" };
    };
    juris.createWebComponent("x-fn", draw);
    juris.createWebComponent("x-obj", { initialState: { a: 1, c: 3 }, render: draw });
    const fn = browser.connect(browser.create("x-fn"));
    const obj = browser.connect(browser.create("x-obj"));
    assert.deepEqual(fn.getComponentState(), { b: 2, a: "over" });
    assert.deepEqual(obj.getComponentState(), { a: "over", c: 3, b: 2 });
    assert.deepEqual(seen, [fn, obj]);
});

test("observed attributes present when it connects are in the initial state, over initialState", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", { initialState: { name: "default", size: 1 }, render: () => null }, { attributes: ["name", "size", "absent"] });
    const element = browser.connect(browser.create("x-a", { name: "Ada", ignored: "x" }));
    assert.deepEqual(element.getComponentState(), { name: "Ada", size: 1 });
});

test("an attribute is read as a value: a bare one true, then booleans, numbers, JSON, else its text", () => {
    const juris = withFactory();
    const cases = {
        bare: ["", true],
        yes: ["true", true],
        no: ["false", false],
        int: ["42", 42],
        neg: ["-3.5", -3.5],
        exp: ["1e3", 1000],
        padded: [" 7 ", 7],
        zero: ["0", 0],
        obj: ['{"a":[1,2]}', { a: [1, 2] }],
        list: ["[1,\"two\"]", [1, "two"]],
        nil: ["null", null],
        quoted: ['"q"', "q"],
        word: ["hello", "hello"],
        blank: ["  ", "  "],
        broken: ["{not json", "{not json"],
    };
    juris.createWebComponent("x-a", () => null, { attributes: Object.keys(cases) });
    const element = browser.connect(browser.create("x-a", Object.fromEntries(Object.entries(cases).map(([name, [text]]) => [name, text]))));
    const state = element.getComponentState();
    for (const [name, [, value]] of Object.entries(cases)) assert.deepEqual(state[name], value, name);
});

test("an attribute written in hex is read as its number or its text, never as 0", () => {
    const juris = withFactory();
    juris.createWebComponent("x-a", () => null, { attributes: ["hex"] });
    const element = browser.connect(browser.create("x-a", { hex: "0x10" }));
    assert.ok([16, "0x10"].includes(element.getComponentState().hex), `read as ${element.getComponentState().hex}`);
});

test("props are the observed attributes with the state over them", () => {
    const juris = withFactory();
    const props = [];
    juris.createWebComponent("x-a", (given) => { props.push(given); return null; }, { attributes: ["name", "title"] });
    const element = browser.connect(browser.create("x-a", { name: "Ada", title: "t" }));
    element.getJurisContext().component.setState("name", "from state");
    assert.deepEqual(props.at(-1), { name: "from state", title: "t" });
    assert.equal(element.getAttribute("name"), "Ada");
});

test("a draw that writes its own state while it draws is not drawn again by that write", () => {
    const juris = withFactory();
    let draws = 0;
    juris.createWebComponent("x-a", (props, context) => {
        draws += 1;
        context.component.setState("seen", draws);
        return { p: `draw ${draws}` };
    });
    const element = browser.connect(browser.create("x-a"));
    assert.equal(draws, 1);
    element.forceRender();
    assert.equal(draws, 2);
    assert.equal(element.getComponentState().seen, 2);
    assert.equal(shown(element.shadowRoot), "<p>draw 2</p>");
});
