// The DOM renderer (dom-renderer.js), drawing: render and mount, text, elements and their refusals,
// namespaces and the parser's integration points, attributes (their namespaces, aliases, refused
// names and schemes), booleans, `value` (form controls, <option>, <select>), classes, styles,
// listeners, textContent and innerHTML, and disposeTree. Reconcile, components and enhance have
// files of their own. Drawn into the stand-in document of tests/support/dom-renderer-dom.mjs.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import DOMRenderer from "juris/dom-renderer.js";

import { installDom, Element, FakeFragment, FakeNode, HTML, SVG, MATHML, XLINK, XML, XMLNS } from "../support/dom-renderer-dom.mjs";

let dom;
beforeEach(() => { dom = installDom(); });
afterEach(() => dom.restore());

const client = (options = {}) => new Juris({ isServer: false, ...options });
const host = () => dom.document.body.appendChild(new Element("div", HTML));
const said = (mock) => mock.mock.calls.map((call) => call.arguments.map(String).join(" "));

// ---- the renderer and its instance -------------------------------------------------------------

test("Juris builds its DOM renderer, which reaches the instance's state, components and api through it", () => {
    const juris = client({ state: { a: { b: 7 } }, allowTags: ["iframe"], allowSchemes: ["magnet"], devMode: false });
    const renderer = juris.renderer;
    assert.ok(renderer instanceof DOMRenderer);
    assert.equal(renderer.juris, juris);
    assert.equal(renderer.stateManager, juris.stateManager);
    assert.equal(renderer.componentManager, juris.componentManager);
    assert.equal(renderer.componentStack, juris.componentStack);
    assert.equal(renderer.api, juris.api);
    assert.equal(renderer.devMode, false);
    assert.deepEqual([...renderer.allowTags], ["iframe"]);
    assert.deepEqual([...renderer.allowSchemes], ["magnet"]);
    assert.equal(renderer.getState("a.b"), 7);
    assert.equal(client({ devMode: true }).renderer.devMode, true);
});

// ---- render and mount --------------------------------------------------------------------------

test("render appends the layout's node to the target, after what is there, and answers it", () => {
    const juris = client();
    const target = host();
    const before = target.appendChild(new Element("span", HTML));
    const p = juris.render(target, { p: "hello" });
    assert.equal(p.localName, "p");
    assert.equal(p.namespaceURI, HTML);
    assert.deepEqual(target.childNodes, [before, p]);
    assert.equal(p.textContent, "hello");
});

test("render and mount take a target by id, and throw naming the target when no element has it", () => {
    const juris = client();
    const app = host();
    app.setAttribute("id", "app");
    const p = juris.render("app", { p: "one" });
    assert.equal(p.parentNode, app);
    const div = juris.mount("app", { div: "two" });
    assert.deepEqual(app.childNodes, [div]);
    assert.throws(() => juris.render("missing", { p: "x" }), { name: "Error", message: 'Juris.render: target "missing" not found' });
    assert.throws(() => juris.mount("missing", { p: "x" }), { name: "Error", message: 'Juris.mount: target "missing" not found' });
    assert.throws(() => juris.render(null, { p: "x" }), { message: 'Juris.render: target "null" not found' });
});

test("mount replaces the target's content, and what Juris drew there stops following its state", () => {
    const juris = client({ state: { t: "first" } });
    const target = host();
    const old = juris.render(target, { p: { textContent: () => juris.getState("t") } });
    target.appendChild(dom.document.createTextNode("server text"));
    const fresh = juris.mount(target, { div: "new" });
    assert.deepEqual(target.childNodes, [fresh]);
    assert.equal(old.parentNode, null);
    juris.setValue("t", "changed");
    assert.equal(old.textContent, "first", "the old binding was disposed");
});

test("render draws a string or number as a text node, and null or a boolean as an empty one", () => {
    const juris = client();
    const target = host();
    const nodes = ["hello", 42, 0, null, true, false].map((layout) => juris.render(target, layout));
    for (const node of nodes) assert.equal(node.nodeType, FakeNode.TEXT_NODE);
    assert.deepEqual(nodes.map((node) => node.nodeValue), ["hello", "42", "0", "", "", ""]);
});

test("an element's content: a string or number is its text, null an empty element", () => {
    const juris = client();
    const target = host();
    assert.equal(juris.render(target, { p: "words" }).textContent, "words");
    assert.equal(juris.render(target, { p: 3 }).textContent, "3");
    const empty = juris.render(target, { p: null });
    assert.equal(empty.childNodes.length, 0);
    assert.equal(empty.attrs.size, 0);
});

test("children are drawn in order: layouts, text and numbers, and a single layout is a list of one", () => {
    const juris = client();
    const ul = juris.render(host(), { ul: { children: [{ li: "a" }, "b", 3, null] } });
    assert.deepEqual(ul.childNodes.map((n) => n.localName ?? n.nodeValue), ["li", "b", "3", ""]);
    const one = juris.render(host(), { div: { children: { span: "only" } } });
    assert.equal(one.childNodes.length, 1);
    assert.equal(one.firstChild.textContent, "only");
    const none = juris.render(host(), { div: { children: null } });
    assert.equal(none.childNodes.length, 0);
});

// ---- refused tags and unknown components ---------------------------------------------------------

test("a refused tag draws an empty text node in its place, and devMode names it", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const quiet = client();
    const div = quiet.render(host(), { div: { children: [{ script: "alert(1)" }, { p: "after" }] } });
    assert.equal(div.childNodes.length, 2, "the node count still matches the server's");
    assert.equal(div.childNodes[0].nodeType, FakeNode.TEXT_NODE);
    assert.equal(div.childNodes[0].nodeValue, "");
    assert.equal(div.childNodes[1].localName, "p");
    assert.equal(warn.mock.callCount(), 0, "said only in devMode");

    const loud = client({ devMode: true });
    const data = loud.render(host(), { div: { children: [{ iframe: { src: "https://x.test" } }, { "img src=x onerror=alert(1)": {} }] } });
    assert.equal(data.childNodes.length, 2);
    assert.ok(data.childNodes.every((n) => n.nodeType === FakeNode.TEXT_NODE && n.nodeValue === ""));
    const lines = said(warn);
    assert.ok(lines.some((line) => /dropped <iframe> is not allowed/.test(line)), lines.join("\n"));
    assert.ok(lines.some((line) => /dropped tag name .* is not a tag/.test(line)), lines.join("\n"));
});

test("allowTags draws a refused tag the app names", () => {
    const juris = client({ allowTags: ["script"] });
    const script = juris.render(host(), { script: { textContent: "1" } });
    assert.equal(script.localName, "script");
    assert.equal(script.textContent, "1");
});

test("a capitalised tag with no component is drawn as an element by default", () => {
    const juris = client();
    const widget = juris.render(host(), { Widget: { title: "t" } });
    assert.equal(widget.nodeType, FakeNode.ELEMENT_NODE);
    assert.equal(widget.localName, "widget");
    assert.equal(widget.getAttribute("title"), "t");
});

test("unknownComponents: \"throw\" refuses an unregistered capitalised tag, but not inside <svg>", () => {
    const juris = client({ unknownComponents: "throw" });
    assert.throws(() => juris.render(host(), { div: { children: [{ Widget: {} }] } }), { message: 'Juris: "Widget" is not a registered component (unknownComponents: "throw")' });
    const svg = juris.render(host(), { svg: { children: [{ Widget: {} }] } });
    assert.equal(svg.firstChild.namespaceURI, SVG, "inside <svg> it is an SVG element");
    assert.equal(svg.firstChild.localName, "Widget");
});

test("unknownComponents: an unregistered capitalised tag in a MathML token element is HTML's, inside annotation-xml MathML's", () => {
    const juris = client({ unknownComponents: "throw" });
    assert.throws(() => juris.render(host(), { math: { children: [{ mi: { children: [{ Widget: {} }] } }] } }), /"Widget" is not a registered component/);
    const math = juris.render(host(), { math: { children: [{ "annotation-xml": { encoding: "MathML-Content", children: [{ Widget: {} }] } }] } });
    assert.equal(math.firstChild.firstChild.namespaceURI, MATHML);
});

test("unknownComponents: \"warn\" says once per name what is drawn, nothing for a refused tag", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = client({ unknownComponents: "warn" });
    juris.render(host(), { div: { children: [{ Widget: {} }, { Widget: {} }] } });
    const placeholder = juris.render(host(), { Script: {} });
    assert.equal(placeholder.nodeType, FakeNode.TEXT_NODE);
    assert.deepEqual(said(warn), [
        'Juris: "Widget" is not a registered component; rendering it as an HTML element',
        'Juris: "Script" is not a registered component, nor a tag a layout may draw; nothing is drawn for it',
    ]);
});

// ---- namespaces --------------------------------------------------------------------------------

test("children of <svg> are SVG, and HTML again inside foreignObject, title and desc", () => {
    const juris = client();
    const svg = juris.render(host(), {
        svg: { children: [{ g: { children: [{ circle: {} }] } }, { foreignObject: { children: [{ div: {} }] } }, { title: { children: [{ b: "t" }] } }, { desc: { children: [{ i: "d" }] } }] },
    });
    assert.equal(svg.namespaceURI, SVG);
    const [g, foreignObject, title, desc] = svg.childNodes;
    assert.equal(g.namespaceURI, SVG);
    assert.equal(g.firstChild.namespaceURI, SVG);
    assert.equal(foreignObject.namespaceURI, SVG);
    assert.equal(foreignObject.firstChild.namespaceURI, HTML);
    assert.equal(title.firstChild.namespaceURI, HTML);
    assert.equal(desc.firstChild.namespaceURI, HTML);
});

test("children of <math> are MathML; a token element holds HTML, but mglyph and malignmark stay MathML and svg is SVG", () => {
    const juris = client();
    const math = juris.render(host(), {
        math: { children: [{ mrow: { children: [{ mi: { children: [{ span: "x" }, { mglyph: {} }, { malignmark: {} }, { svg: {} }] } }] } }, { mo: { children: [{ b: "+" }] } }] },
    });
    assert.equal(math.namespaceURI, MATHML);
    const mrow = math.childNodes[0];
    assert.equal(mrow.namespaceURI, MATHML);
    const [span, mglyph, malignmark, svg] = mrow.firstChild.childNodes;
    assert.equal(span.namespaceURI, HTML);
    assert.equal(mglyph.namespaceURI, MATHML);
    assert.equal(malignmark.namespaceURI, MATHML);
    assert.equal(svg.namespaceURI, SVG);
    assert.equal(math.childNodes[1].firstChild.namespaceURI, HTML);
});

test("annotation-xml holds HTML for an HTML encoding, in any case, and MathML but for svg otherwise", () => {
    const juris = client();
    const math = juris.render(host(), {
        math: {
            children: [
                { "annotation-xml": { encoding: "TEXT/HTML", children: [{ div: {} }] } },
                { "annotation-xml": { encoding: "application/xhtml+xml", children: [{ div: {} }] } },
                { "annotation-xml": { encoding: "MathML-Presentation", children: [{ mi: {} }, { svg: {} }] } },
                { "annotation-xml": { children: [{ mn: {} }] } },
            ],
        },
    });
    const [html, xhtml, other, none] = math.childNodes;
    assert.equal(html.firstChild.namespaceURI, HTML);
    assert.equal(xhtml.firstChild.namespaceURI, HTML);
    assert.equal(other.childNodes[0].namespaceURI, MATHML);
    assert.equal(other.childNodes[1].namespaceURI, SVG);
    assert.equal(none.firstChild.namespaceURI, MATHML);
});

test("render and mount draw in the target's own namespace unless given one, null being HTML", () => {
    const juris = client();
    const svg = juris.render(host(), { svg: {} });
    assert.equal(juris.render(svg, { circle: {} }).namespaceURI, SVG);
    assert.equal(juris.render(svg, { p: {} }, null).namespaceURI, HTML);
    assert.equal(juris.render(host(), { circle: {} }, SVG).namespaceURI, SVG);
    assert.equal(juris.mount(svg, { rect: {} }).namespaceURI, SVG);
    assert.equal(juris.mount(svg, { p: {} }, { namespace: null }).namespaceURI, HTML);
    assert.equal(juris.renderer.mount(svg, { p: {} }, null).namespaceURI, HTML, "the renderer's own mount takes it third");
    const foreignObject = juris.render(svg, { foreignObject: {} });
    assert.equal(juris.render(foreignObject, { div: {} }).namespaceURI, HTML);
    const fragment = new FakeFragment();
    assert.equal(juris.render(fragment, { p: {} }).namespaceURI, HTML, "a fragment holds HTML");
});

// ---- attributes ----------------------------------------------------------------------------------

test("attributes are written as given; className is class and htmlFor is for", () => {
    const juris = client();
    const label = juris.render(host(), { label: { className: "field", htmlFor: "name", title: `a "quoted" <title>`, tabindex: 0, "data-id": 7, "aria-label": "Name" } });
    assert.equal(label.getAttribute("class"), "field");
    assert.equal(label.getAttribute("for"), "name");
    assert.equal(label.getAttribute("title"), `a "quoted" <title>`);
    assert.equal(label.getAttribute("tabindex"), "0");
    assert.equal(label.getAttribute("data-id"), "7");
    assert.equal(label.getAttribute("aria-label"), "Name");
    assert.equal(label.hasAttribute("className"), false);
});

test("null and undefined write nothing, and a reactive value turning null takes the attribute off", () => {
    const juris = client({ state: { title: "one" } });
    const p = juris.render(host(), { p: { title: () => juris.getState("title"), lang: null, dir: undefined } });
    assert.equal(p.getAttribute("title"), "one");
    assert.equal(p.hasAttribute("lang"), false);
    assert.equal(p.hasAttribute("dir"), false);
    juris.setValue("title", "two");
    assert.equal(p.getAttribute("title"), "two");
    juris.setValue("title", null);
    assert.equal(p.hasAttribute("title"), false);
    juris.setValue("title", "three");
    assert.equal(p.getAttribute("title"), "three");
});

test("an attribute's function is given its element and runs again when the state it read changes", () => {
    const juris = client({ state: { n: 1 } });
    const given = [];
    const p = juris.render(host(), { p: { "data-n": (element) => { given.push(element); return juris.getState("n"); } } });
    juris.setValue("n", 2);
    assert.equal(p.getAttribute("data-n"), "2");
    assert.deepEqual(given, [p, p]);
});

test("a refused attribute name or URL scheme is not written, and takes off a value that got through", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = client({ devMode: true, state: { href: "https://example.test/" } });
    const a = juris.render(host(), { a: { href: () => juris.getState("href"), "x onmouseover": "alert(1)", onclick: "alert(1)", srcdoc: "<p>", "bad name": null } });
    assert.equal(a.getAttribute("href"), "https://example.test/");
    assert.deepEqual([...a.attrs.keys()], ["href"], "no refused name was written");
    assert.equal(a.listeners.length, 0, "an on… string is not a listener either");
    juris.setValue("href", "javascript:alert(1)");
    assert.equal(a.hasAttribute("href"), false, "the value before it was taken off");
    juris.setValue("href", "/again");
    assert.equal(a.getAttribute("href"), "/again");
    const lines = said(warn);
    assert.ok(lines.some((line) => /dropped attribute name "x onmouseover" is not allowed/.test(line)), lines.join("\n"));
    assert.ok(lines.some((line) => /dropped href refuses "javascript:alert\(1\)": scheme not allowed/.test(line)), lines.join("\n"));
    assert.ok(lines.some((line) => /dropped srcdoc takes a document/.test(line)), lines.join("\n"));
});

test("allowSchemes opens a URL scheme by name, and only that one", () => {
    const juris = client({ allowSchemes: ["magnet"] });
    assert.equal(juris.render(host(), { a: { href: "magnet:?xt=urn:x" } }).getAttribute("href"), "magnet:?xt=urn:x");
    assert.equal(juris.render(host(), { a: { href: "web+app:thing" } }).hasAttribute("href"), false);
    assert.equal(client().render(host(), { a: { href: "magnet:?xt=urn:x" } }).hasAttribute("href"), false);
});

test("a layout given where text belongs is ignored, and devMode names where", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = client({ devMode: true, state: { v: "text" } });
    const p = juris.render(host(), { p: { title: { b: "x" }, "data-list": ["a"], textContent: () => (juris.getState("v") === "layout" ? { b: "x" } : juris.getState("v")) } });
    assert.equal(p.hasAttribute("title"), false);
    assert.equal(p.hasAttribute("data-list"), false);
    assert.equal(p.textContent, "text");
    juris.setValue("v", "layout");
    assert.equal(p.textContent, "text", "the text before it stays");
    const lines = said(warn);
    assert.ok(lines.some((line) => line.startsWith('Juris: "title" was given an object, and takes text')), lines.join("\n"));
    assert.ok(lines.some((line) => line.startsWith('Juris: "data-list" was given a list')), lines.join("\n"));
    assert.ok(lines.some((line) => line.startsWith('Juris: "textContent" was given an object')), lines.join("\n"));
});

// The tag's whole content as a function gives text ({ b: () => api.call("count") }), so a layout it
// returns draws nothing. The author wrote no textContent, so the warning does not speak of one.
test("devMode: a function as the whole content that returns a layout is pointed at children", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = client({ devMode: true, state: { n: 0 } });
    const ul = juris.render(host(), { ul: () => [{ li: String(juris.getState("n")) }] });
    const div = juris.render(host(), { div: () => ({ p: String(juris.getState("n")) }) });
    assert.equal(ul.childNodes.length, 0, "what it draws has not changed: text, and a list is none");
    assert.equal(div.childNodes.length, 0);
    assert.deepEqual(said(warn), [
        "Juris: <ul> was given a function as its whole content, which gives text, and it returned a list"
            + " (to draw layouts, make the function its children: { ul: { children: () => [...] } }); ignored [object Object]",
        "Juris: <div> was given a function as its whole content, which gives text, and it returned an object"
            + " (to draw layouts, make the function its children: { div: { children: () => [...] } }); ignored [object Object]",
    ]);
});

test("a function as the whole content that returns text draws it, and says nothing", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = client({ devMode: true, state: { n: 3 } });
    const b = juris.render(host(), { b: () => juris.getState("n") });
    assert.equal(b.textContent, "3");
    assert.deepEqual(said(warn), []);
});

test("textContent written out, given a layout, keeps its own words: the author did write textContent", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = client({ devMode: true, state: { n: 0 } });
    juris.render(host(), { p: { textContent: () => ({ b: String(juris.getState("n")) }) } });
    assert.deepEqual(said(warn), [
        'Juris: "textContent" was given an object, and takes text (a string or a number;'
            + " a layout goes in children); ignored [object Object]",
    ]);
});

test("on SVG and MathML, xlink:, xml: and xmlns attributes are set in their namespaces", () => {
    const juris = client();
    const svg = juris.render(host(), {
        svg: { xmlns: SVG, "xmlns:xlink": XLINK, children: [{ use: { "xlink:href": "#icon", "xml:lang": "en", "data-x": "1", "foo:bar": "b" } }] },
    });
    assert.equal(svg.attrs.get("xmlns").ns, XMLNS);
    assert.equal(svg.attrs.get("xmlns:xlink").ns, XMLNS);
    const use = svg.firstChild;
    assert.equal(use.attrs.get("xlink:href").ns, XLINK);
    assert.equal(use.attrs.get("xlink:href").value, "#icon");
    assert.equal(use.attrs.get("xml:lang").ns, XML);
    assert.equal(use.attrs.get("data-x").ns, null);
    assert.equal(use.attrs.get("foo:bar").ns, null, "a prefix the parser does not know is a plain name");
    const math = juris.render(host(), { math: { "xml:lang": "en" } });
    assert.equal(math.attrs.get("xml:lang").ns, XML);
});

test("on an HTML element, xlink: and xml: attributes stay plain, as the parser keeps them", () => {
    const juris = client();
    const a = juris.render(host(), { a: { "xml:lang": "en", "xlink:href": "#x" } });
    assert.equal(a.attrs.get("xml:lang").ns, null);
    assert.equal(a.attrs.get("xlink:href").ns, null);
});

test("an SVG URL attribute is held to the scheme rule", () => {
    const juris = client();
    const svg = juris.render(host(), { svg: { children: [{ use: { "xlink:href": "javascript:alert(1)" } }, { a: { href: "data:text/html,x" } }] } });
    assert.equal(svg.childNodes[0].hasAttribute("xlink:href"), false);
    assert.equal(svg.childNodes[1].hasAttribute("href"), false);
});

// ---- booleans ----------------------------------------------------------------------------------

test("a boolean attribute is present when truthy and absent when falsy, and sets the element's property", () => {
    const juris = client({ state: { on: true } });
    const input = juris.render(host(), { input: { checked: () => juris.getState("on"), disabled: 0, readOnly: "yes" } });
    assert.equal(input.getAttribute("checked"), "");
    assert.equal(input.checked, true);
    assert.equal(input.hasAttribute("disabled"), false);
    assert.equal(input.disabled, false);
    assert.equal(input.getAttribute("readonly"), "", "matched in any case");
    juris.setValue("on", false);
    assert.equal(input.hasAttribute("checked"), false);
    assert.equal(input.checked, false);
    const div = juris.render(host(), { div: { hidden: 1, inert: null } });
    assert.equal(div.getAttribute("hidden"), "");
    assert.equal(div.hasAttribute("inert"), false);
    assert.equal("hidden" in div, false, "no property is invented where the element has none");
});

test("hidden=\"until-found\" is set as given, in any case, and a later true or false is the boolean again", () => {
    const juris = client({ state: { h: "Until-Found" } });
    const div = juris.render(host(), { div: { hidden: () => juris.getState("h") } });
    assert.equal(div.getAttribute("hidden"), "Until-Found");
    juris.setValue("h", true);
    assert.equal(div.getAttribute("hidden"), "");
    juris.setValue("h", "until-found");
    assert.equal(div.getAttribute("hidden"), "until-found");
    juris.setValue("h", false);
    assert.equal(div.hasAttribute("hidden"), false);
    assert.equal(juris.render(host(), { div: { hidden: "until" } }).getAttribute("hidden"), "", "any other text is the boolean");
});

test("on an SVG or MathML element, a name HTML holds as a boolean is an attribute like any other", () => {
    const juris = client();
    const svg = juris.render(host(), { svg: { hidden: false, children: [{ rect: { disabled: "no" } }] } });
    assert.equal(svg.getAttribute("hidden"), "false");
    assert.equal(svg.childNodes[0].getAttribute("disabled"), "no");
    const math = juris.render(host(), { math: { children: [{ mfenced: { open: "[", close: "]" } }] } });
    assert.equal(math.childNodes[0].getAttribute("open"), "[");
});

// HTML has no indeterminate attribute: it is an <input>'s property alone, which the server writes
// nothing for.
test("indeterminate on an <input> is its property, never an attribute, and follows its state", () => {
    const juris = client({ state: { some: true } });
    const box = juris.render(host(), {
        input: { type: "checkbox", indeterminate: () => juris.getState("some") },
    });
    assert.equal(box.indeterminate, true);
    assert.equal(box.hasAttribute("indeterminate"), false);
    juris.setValue("some", 0);
    assert.equal(box.indeterminate, false);
    assert.equal(juris.render(host(), { input: { indeterminate: "yes" } }).indeterminate, true);
});

test("indeterminate on another element, or inside <svg>, is an attribute like any other", () => {
    const juris = client();
    const custom = juris.render(host(), { "x-check": { indeterminate: true } });
    assert.equal(custom.getAttribute("indeterminate"), "true");
    const svg = juris.render(host(), { svg: { children: [{ input: { indeterminate: true } }] } });
    assert.equal(svg.firstChild.getAttribute("indeterminate"), "true");
});

test("an <input> reused for a layout that gives no indeterminate is indeterminate no longer", () => {
    const juris = client({ state: { some: true } });
    const form = juris.render(host(), {
        form: {
            children: () => [
                juris.getState("some")
                    ? { input: { type: "checkbox", indeterminate: true } }
                    : { input: { type: "checkbox" } },
            ],
        },
    });
    const box = form.firstChild;
    assert.equal(box.indeterminate, true);
    juris.setValue("some", false);
    assert.equal(form.firstChild, box, "the same element, reused");
    assert.equal(box.indeterminate, false);
});

// ---- value -------------------------------------------------------------------------------------

test("value on a form control is its property, nothing turning it empty", () => {
    const juris = client({ state: { v: "typed" } });
    const input = juris.render(host(), { input: { value: () => juris.getState("v") } });
    assert.equal(input.value, "typed");
    assert.equal(input.hasAttribute("value"), false, "the property, not the default");
    juris.setValue("v", null);
    assert.equal(input.value, "");
    juris.setValue("v", 5);
    assert.equal(input.value, "5");
    const textarea = juris.render(host(), { textarea: { value: undefined } });
    assert.equal(textarea.value, "");
});

test("value is assigned only when it changed, so a redraw does not reset what the user typed", () => {
    const juris = client({ state: { v: "a", other: 0 } });
    // A control of the app's own (a custom element with a value property), adopted by enhance.
    const field = host().appendChild(new Element("my-field", HTML));
    let current = "";
    let assigned = 0;
    Object.defineProperty(field, "value", { get: () => current, set: (next) => { assigned += 1; current = next; } });
    juris.enhance(field, { value: () => { juris.getState("other"); return juris.getState("v"); } });
    assert.equal(current, "a");
    assert.equal(assigned, 1);
    current = "ab"; // the user typed
    juris.setValue("v", "ab");
    assert.equal(assigned, 1, "already that value: not assigned");
    juris.setValue("other", 1);
    assert.equal(assigned, 1);
    juris.setValue("v", "abc");
    assert.equal(assigned, 2);
    assert.equal(current, "abc");
});

test("an option's value is its attribute, written even when empty, so an empty option does not submit its label", () => {
    const juris = client({ state: { v: "" } });
    const select = juris.render(host(), { select: { children: [{ option: { value: () => juris.getState("v"), textContent: "Pick one" } }] } });
    const option = select.firstChild;
    assert.equal(option.getAttribute("value"), "");
    assert.equal(option.value, "");
    juris.setValue("v", "x");
    assert.equal(option.getAttribute("value"), "x");
    juris.setValue("v", null);
    assert.equal(option.getAttribute("value"), "");
});

test("a select's value is applied once its options are in place", () => {
    const juris = client();
    const select = juris.render(host(), { select: { value: "b", children: [{ option: { value: "a" } }, { option: { value: "b" } }] } });
    assert.equal(select.value, "b");
    assert.equal(select.childNodes[1].selected, true);
});

test("a select keeps its value when its options are drawn anew, and follows a value of its own", () => {
    const juris = client({ state: { options: ["a", "b"], v: "b" } });
    const select = juris.render(host(), {
        select: { value: () => juris.getState("v"), children: () => juris.getState("options").map((value) => ({ option: { value, textContent: value.toUpperCase() } })) },
    });
    assert.equal(select.value, "b");
    const before = select.childNodes[1];
    juris.setValue("options", ["a", "b", "c"]); // a length change: drawn anew
    assert.notEqual(select.childNodes[1], before, "the options were replaced");
    assert.equal(select.value, "b", "the selection was put back on the new option");
    assert.equal(select.childNodes[1].selected, true);
    juris.setValue("v", "c");
    assert.equal(select.value, "c");
    juris.setValue("options", ["a"]);
    assert.equal(select.value, "", "nothing can select an option that no longer exists");
});

test("value on an element with no value property is an attribute", () => {
    const juris = client();
    const div = juris.render(host(), { div: { value: "x" } });
    assert.equal(div.getAttribute("value"), "x");
});

// ---- classes -----------------------------------------------------------------------------------

test("class is applied before classList, so a toggled class survives whatever order the layout gives", () => {
    const juris = client();
    const a = juris.render(host(), { a: { classList: { active: true }, class: "btn" } });
    assert.deepEqual(a.classList.tokens(), ["btn", "active"]);
    const b = juris.render(host(), { a: { classList: { active: true }, className: "btn", title: "t" } });
    assert.deepEqual(b.classList.tokens(), ["btn", "active"]);
    assert.equal(b.getAttribute("title"), "t");
});

test("a classList key is one or more class names, an empty key is nothing, and each follows its value", () => {
    const juris = client({ state: { on: true } });
    const div = juris.render(host(), { div: { classList: { "btn active": () => juris.getState("on"), "": true, "  ": true, off: false, " x ": 1 } } });
    assert.deepEqual(div.classList.tokens(), ["btn", "active", "x"]);
    juris.setValue("on", false);
    assert.deepEqual(div.classList.tokens(), ["x"]);
});

test("a function as classList draws the classes its object turns on, after class, its keys split as an object's", () => {
    const juris = client({ state: { open: true } });
    const nav = juris.render(host(), {
        nav: {
            classList: () => ({
                open: juris.getState("open"),
                shut: false,
                "btn  active": 1,
                "": true,
                "\t": true,
            }),
            className: "menu",
        },
    });
    assert.deepEqual(nav.classList.tokens(), ["menu", "open", "btn", "active"]);
});

test("a classList function runs again on a change: a class it turns off or no longer names goes", () => {
    const juris = client({ state: { menu: { open: true, wide: true } } });
    const nav = juris.render(host(), {
        nav: { className: "menu", classList: () => juris.getState("menu") },
    });
    assert.deepEqual(nav.classList.tokens(), ["menu", "open", "wide"]);
    // A class something else put on the element is not the function's to take off.
    nav.classList.toggle("focused", true);
    juris.setValue("menu", { open: false, tall: true });
    assert.deepEqual(nav.classList.tokens(), ["menu", "focused", "tall"], "open turned off, wide no longer named");
    juris.setValue("menu", {});
    assert.deepEqual(nav.classList.tokens(), ["menu", "focused"]);
    juris.setValue("menu", { "open wide": true });
    assert.deepEqual(nav.classList.tokens(), ["menu", "focused", "open", "wide"]);
    juris.setValue("menu", null);
    assert.deepEqual(nav.classList.tokens(), ["menu", "focused"], "className's class is never touched");
});

test("the object a classList function gives is used as it is: a function in it is not run, and is true", () => {
    const juris = client({ state: { open: false } });
    let runs = 0;
    const isOpen = () => {
        runs += 1;
        return juris.getState("open");
    };
    const nav = juris.render(host(), {
        nav: { classList: () => ({ open: isOpen, shown: juris.getState("open") }) },
    });
    assert.deepEqual(nav.classList.tokens(), ["open"]);
    assert.equal(runs, 0);
});

test("a classList function's binding is labelled classList, with no class name as its part", () => {
    const juris = client({ state: { open: true } });
    const labels = [];
    const bind = juris.renderer.bindState;
    juris.renderer.bindState = function (resolver, apply, target, key, part) {
        labels.push([key, part]);
        return bind.call(this, resolver, apply, target, key, part);
    };
    juris.render(host(), {
        nav: {
            classList: () => ({ open: juris.getState("open") }),
            children: [{ a: { classList: { active: () => juris.getState("open") } } }],
        },
    });
    assert.deepEqual(labels, [["classList", null], ["classList", "active"]]);
});

test("a reactive className runs again over a classList object: what it turns on stays on, and off stays off", () => {
    const juris = client({ state: { c: "a" } });
    const nav = juris.render(host(), {
        nav: { className: () => juris.getState("c"), classList: { x: true, y: false } },
    });
    assert.equal(nav.getAttribute("class"), "a x");
    juris.setValue("c", "b y");
    assert.equal(nav.getAttribute("class"), "b x");
    juris.setValue("c", null);
    assert.equal(nav.getAttribute("class"), "x", "with no base, the classList's classes are the attribute");
});

test("a reactive className runs again over a class's own function: the class is what its function last gave", () => {
    const juris = client({ state: { c: "a", on: true } });
    const nav = juris.render(host(), {
        nav: { className: () => juris.getState("c"), classList: { x: () => juris.getState("on") } },
    });
    assert.equal(nav.getAttribute("class"), "a x");
    juris.setValue("c", "b");
    assert.equal(nav.getAttribute("class"), "b x");
    juris.setValue("on", false);
    juris.setValue("c", "c x");
    assert.equal(nav.getAttribute("class"), "c", "turned off, though className names it");
    juris.setValue("on", true);
    assert.equal(nav.getAttribute("class"), "c x");
});

test("a reactive className runs again over a classList function: the classes its object turns on stay on", () => {
    const juris = client({ state: { c: "menu", menu: { open: true, wide: false } } });
    const nav = juris.render(host(), {
        nav: { className: () => juris.getState("c"), classList: () => juris.getState("menu") },
    });
    assert.equal(nav.getAttribute("class"), "menu open");
    juris.setValue("c", "bar wide");
    assert.equal(nav.getAttribute("class"), "bar open");
});

test("classList decides a class className names too, whichever of them runs again", () => {
    const juris = client({ state: { c: "menu open", open: false } });
    const nav = juris.render(host(), {
        nav: { className: () => juris.getState("c"), classList: { open: () => juris.getState("open") } },
    });
    assert.equal(nav.getAttribute("class"), "menu");
    juris.setValue("c", "menu open wide");
    assert.equal(nav.getAttribute("class"), "menu wide");
    juris.setValue("open", true);
    assert.equal(nav.getAttribute("class"), "menu wide open");
});

test("where two classList keys name a class, the later decides it, on every run", () => {
    const juris = client({ state: { on: true } });
    const p = juris.render(host(), {
        p: { classList: { "a b": () => juris.getState("on"), "b c": true } },
    });
    assert.equal(p.getAttribute("class"), "a b c");
    juris.setValue("on", false);
    assert.equal(p.getAttribute("class"), "b c", "b is the later key's");
    const q = juris.render(host(), {
        q: { classList: { "a b": () => juris.getState("on"), b: false } },
    });
    assert.equal(q.hasAttribute("class"), false);
    juris.setValue("on", true);
    assert.equal(q.getAttribute("class"), "a", "b is the later key's");
});

test("a class a classList function no longer names is as className leaves it", () => {
    const juris = client({ state: { menu: { open: false } } });
    const nav = juris.render(host(), {
        nav: { className: "menu open", classList: () => juris.getState("menu") },
    });
    assert.equal(nav.getAttribute("class"), "menu");
    juris.setValue("menu", {});
    assert.equal(nav.getAttribute("class"), "menu open", "className gives it");
    juris.setValue("menu", { wide: true });
    juris.setValue("menu", {});
    assert.equal(nav.getAttribute("class"), "menu open", "className does not give it");
});

test("class and className are one attribute: given both, the later is it, and the earlier is never run", () => {
    const juris = client({ state: { c: "a" } });
    let runs = 0;
    const p = juris.render(host(), {
        p: {
            class: () => {
                runs += 1;
                return juris.getState("c");
            },
            className: "b",
        },
    });
    assert.equal(p.getAttribute("class"), "b");
    assert.equal(runs, 0);
    const q = juris.render(host(), {
        p: { className: "b", class: "a", classList: { x: true } },
    });
    assert.equal(q.getAttribute("class"), "a x");
});

// ---- style -------------------------------------------------------------------------------------

test("a style string is the element's whole inline style", () => {
    const juris = client({ state: { css: "color: red" } });
    const div = juris.render(host(), { div: { style: () => juris.getState("css") } });
    assert.equal(div.style.color, "red");
    juris.setValue("css", "margin-top: 2px");
    assert.equal(div.style.color, "");
    assert.equal(div.style.marginTop, "2px");
});

test("a style object writes camelCase and custom properties, and leaves out keys whose value is nothing", () => {
    const juris = client();
    const div = juris.render(host(), { div: { style: { marginTop: 4, cssFloat: "left", "--accent": "blue", color: "", opacity: null, width: undefined } } });
    assert.equal(div.style.getPropertyValue("margin-top"), "4");
    assert.equal(div.style.getPropertyValue("float"), "left");
    assert.equal(div.style.getPropertyValue("--accent"), "blue");
    assert.equal(div.style.length, 3);
});

test("a reactive style object takes off the keys, custom ones included, that a later value no longer gives", () => {
    const juris = client({ state: { s: { color: "red", marginTop: "1px", "--accent": "blue" } } });
    const div = juris.render(host(), { div: { style: () => juris.getState("s") } });
    assert.equal(div.style.length, 3);
    juris.setValue("s", { color: "green" });
    assert.equal(div.style.color, "green");
    assert.equal(div.style.marginTop, "");
    assert.equal(div.style.getPropertyValue("--accent"), "");
    juris.setValue("s", { "--accent": "red", color: "" });
    assert.equal(div.style.getPropertyValue("--accent"), "red");
    assert.equal(div.style.color, "");
    juris.setValue("s", null);
    assert.equal(div.style.length, 0, "a style of nothing takes off what it gave");
});

test("a style key that is no property is left alone, and a refused value takes off the value before it", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = client({ devMode: true, state: { c: "red" } });
    const div = juris.render(host(), { div: { style: () => ({ color: juris.getState("c"), "--x": juris.getState("c"), cssText: "position: fixed", "a;b": "1" }) } });
    assert.equal(div.style.color, "red");
    assert.equal(div.style.getPropertyValue("--x"), "red");
    assert.equal(div.style.position, "", "cssText was never assigned");
    juris.setValue("c", "blue;position:fixed");
    assert.equal(div.style.color, "");
    assert.equal(div.style.getPropertyValue("--x"), "");
    assert.equal(div.style.position, "");
    const lines = said(warn);
    assert.ok(lines.some((line) => /dropped style key "cssText" is not a property/.test(line)), lines.join("\n"));
    assert.ok(lines.some((line) => /dropped style color refuses/.test(line)), lines.join("\n"));
});

test("a style that turns from a string into an object writes the object's keys", () => {
    const juris = client({ state: { s: "color: red" } });
    const div = juris.render(host(), { div: { style: () => juris.getState("s") } });
    juris.setValue("s", { marginTop: "3px" });
    assert.equal(div.style.marginTop, "3px");
});

test("a style that turns from a string into an object, or back, leaves exactly what the new one gives, as the server writes it", () => {
    const juris = client({ state: { s: "color: red; margin-top: 1px" } });
    const div = juris.render(host(), { div: { style: () => juris.getState("s") } });
    juris.setValue("s", { color: "blue" });
    assert.equal(div.style.cssText, "color: blue;");
    juris.setValue("s", "padding: 2px");
    assert.equal(div.style.cssText, "padding: 2px;");
});

// ---- listeners -----------------------------------------------------------------------------------

test("an on… function is a listener for the lower-cased event, taken off when the element is disposed", () => {
    const juris = client();
    const events = [];
    const onClick = (event) => events.push(event.type);
    const button = juris.render(host(), { button: { onClick, onmouseover: () => events.push("over") } });
    assert.deepEqual(button.listeners.map((l) => l.type), ["click", "mouseover"]);
    button.fire("click");
    button.fire("mouseover");
    assert.deepEqual(events, ["click", "over"]);
    assert.equal(button.hasAttribute("onclick"), false);
    juris.disposeTree(button);
    assert.deepEqual(button.listeners, []);
});

// ---- textContent and innerHTML ------------------------------------------------------------------

test("textContent is text, and a reactive one follows its state, nothing turning it empty", () => {
    const juris = client({ state: { t: "<b>not markup</b>" } });
    const p = juris.render(host(), { p: { textContent: () => juris.getState("t") } });
    assert.equal(p.textContent, "<b>not markup</b>");
    assert.equal(p.childNodes[0].nodeType, FakeNode.TEXT_NODE);
    juris.setValue("t", null);
    assert.equal(p.textContent, "");
});

test("innerHTML is left out unless the instance allows it, and devMode names the refusal", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const p = client({ devMode: true }).render(host(), { p: { innerHTML: '<img src=x onerror="alert(1)">' } });
    assert.equal(p.html, undefined, "nothing was given to innerHTML");
    assert.ok(said(warn).some((line) => /dropped innerHTML: markup is not written from a layout/.test(line)));
});

test("with allowInnerHTML, innerHTML is written as given and a reactive one follows its state", () => {
    const juris = client({ allowInnerHTML: true, state: { h: "<b>x</b>" } });
    const p = juris.render(host(), { p: { innerHTML: () => juris.getState("h") } });
    assert.equal(p.innerHTML, "<b>x</b>");
    juris.setValue("h", undefined);
    assert.equal(p.innerHTML, "");
});

// What an element holds is one thing (REFERENCE.md, "Components and layouts"): its textContent, or
// an innerHTML the instance allows, the later of the two; else an <output>'s or a <textarea>'s
// value; else its children. The keys decide it, whatever their values and order, as on the server.
test("textContent is all an element holds: children beside it are not drawn, whatever its value", () => {
    const juris = client({ state: { t: "y" } });
    const children = ["a", { b: "c" }];
    const texts = [
        ["y", "y"],
        ["", ""],
        [null, ""],
        [undefined, ""],
        [false, ""],
        [() => juris.getState("t"), "y"],
        [{ i: "x" }, ""],
    ];
    for (const [text, shown] of texts) {
        const p = juris.render(host(), { p: { textContent: text, children } });
        assert.equal(p.textContent, shown, String(text));
        assert.equal(p.children.length, 0, String(text));
    }
    const p = juris.render(host(), { p: { children, textContent: "y" } });
    assert.equal(p.textContent, "y", "in either order");
    juris.setValue("t", "z");
    const reactive = juris.render(host(), { p: { textContent: () => juris.getState("t"), children } });
    juris.setValue("t", null);
    assert.equal(reactive.childNodes.length, 0, "a text turning empty brings no children in");
});

test("an allowed innerHTML is all an element holds; a refused one is left out, and the children are drawn", () => {
    const allowed = client({ allowInnerHTML: true });
    const p = allowed.render(host(), { p: { innerHTML: "<b>y</b>", children: ["a"] } });
    assert.equal(p.innerHTML, "<b>y</b>");
    assert.equal(p.childNodes.length, 0);
    const refusedValue = allowed.render(host(), { p: { children: ["a"], innerHTML: { i: "x" } } });
    assert.equal(refusedValue.childNodes.length, 0);
    const refused = client().render(host(), { p: { innerHTML: "<b>y</b>", children: ["a"] } });
    assert.equal(refused.textContent, "a");
});

test("an <output> or a <textarea> holds its textContent over its value, and its value over its children", () => {
    const juris = client();
    assert.equal(juris.render(host(), { output: { textContent: "x", value: 42 } }).textContent, "x");
    assert.equal(juris.render(host(), { output: { value: 42, textContent: "x" } }).textContent, "x");
    const textarea = juris.render(host(), { textarea: { textContent: "x", value: "y" } });
    assert.equal(textarea.textContent, "x");
    assert.equal(textarea.value, "x", "its value is never set: it shows its text");
    assert.equal(juris.render(host(), { output: { value: 42, children: ["a", { b: "c" }] } }).textContent, "42");
    const typed = juris.render(host(), { textarea: { children: "a", value: "y" } });
    assert.equal(typed.childNodes.length, 0);
    assert.equal(typed.value, "y");
});

test("devMode names the children, or the value, that what an element holds leaves out", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = client({ devMode: true, allowInnerHTML: true });
    juris.render(host(), { p: { textContent: "y", children: ["a"] } });
    juris.render(host(), { p: { innerHTML: "<b>y</b>", children: "a" } });
    juris.render(host(), { output: { textContent: "x", value: 42 } });
    juris.render(host(), { textarea: { value: "y", children: ["a"] } });
    juris.render(host(), { p: { textContent: "y", children: null } });
    juris.render(host(), { p: { textContent: "y", children: undefined } });
    juris.render(host(), { input: { textContent: "y", children: ["a"] } });
    assert.deepEqual(said(warn), [
        "Juris: dropped children: <p> holds its textContent, and nothing beside it",
        "Juris: dropped children: <p> holds its innerHTML, and nothing beside it",
        "Juris: dropped value: <output> holds its textContent, and nothing beside it",
        "Juris: dropped children: <textarea> holds its value, and nothing beside it",
    ]);
});

test("true and false as the content, in textContent or in innerHTML, are nothing, as in children", () => {
    const juris = client({ state: { on: true } });
    assert.equal(juris.render(host(), { p: false }).childNodes.length, 0);
    assert.equal(juris.render(host(), { p: true }).childNodes.length, 0);
    assert.equal(juris.render(host(), { p: { textContent: false } }).textContent, "");
    const reactive = juris.render(host(), { p: { textContent: () => juris.getState("on") && "On" } });
    assert.equal(reactive.textContent, "On");
    juris.setValue("on", false);
    assert.equal(reactive.textContent, "");
    const markup = client({ allowInnerHTML: true }).render(host(), { p: { innerHTML: false } });
    assert.equal(markup.innerHTML, "");
    assert.equal(juris.render(host(), { p: { children: [false, "a", true] } }).textContent, "a");
    assert.equal(juris.render(host(), { p: 0 }).textContent, "0", "a number is text, 0 included");
});

// Found by the content matrix (content.test.mjs): only a form control's value is state.
test("a value attribute a reused element no longer gets is taken off; a form control's value is left alone", () => {
    const juris = client({ state: { first: true } });
    const list = juris.render(host(), {
        ol: {
            children: () => [
                juris.getState("first") ? { li: { value: 3, textContent: "Milk" } } : { li: "Milk" },
                juris.getState("first") ? { input: { value: "typed" } } : { input: {} },
            ],
        },
    });
    const [item, input] = list.childNodes;
    juris.setValue("first", false);
    assert.equal(list.childNodes[0], item, "the same element, reused");
    assert.equal(item.hasAttribute("value"), false);
    assert.equal(input.value, "typed");
});

test("an element that held something, reused for a layout that puts nothing in its place, is emptied", () => {
    const juris = client({ state: { step: 0 } });
    const steps = [
        { output: { value: 42 } },
        { output: {} },
        { output: { children: ["a", { b: "c" }] } },
        { output: { children: null } },
        { output: { innerHTML: "<b>refused</b>" } },
    ];
    const form = juris.render(host(), { form: { children: () => [steps[juris.getState("step")]] } });
    const output = form.firstChild;
    const held = [];
    for (let step = 1; step < steps.length; step += 1) {
        juris.setValue("step", step - 1);
        juris.setValue("step", step);
        assert.equal(form.firstChild, output, "the same element, reused");
        held.push(output.childNodes.length);
    }
    assert.deepEqual(held, [0, 2, 0, 0]);
});

test("an element reused for a layout giving textContent beside children holds the text alone", () => {
    const juris = client({ state: { text: false } });
    const div = juris.render(host(), {
        div: {
            children: () => [
                juris.getState("text")
                    ? { p: { textContent: "y", children: ["a"] } }
                    : { p: { children: ["a", { b: "c" }] } },
            ],
        },
    });
    const p = div.firstChild;
    juris.setValue("text", true);
    assert.equal(div.firstChild, p, "the same element, reused");
    assert.equal(p.textContent, "y");
    assert.equal(p.children.length, 0);
});

test("disposing an element removes every listener it holds, whichever removal throws, and throws the first error after", () => {
    const juris = client({ state: { show: true } });
    const error = new Error("bad");
    const div = juris.render(host(), { div: { children: () => (juris.getState("show") ? [{ button: { onclick: () => { }, onkeydown: () => { } } }] : []) } });
    const button = div.firstChild;
    const remove = button.removeEventListener.bind(button);
    button.removeEventListener = (type, listener) => { remove(type, listener); if (type === "click") throw error; };
    assert.throws(() => juris.setValue("show", false), (thrown) => thrown === error);
    assert.deepEqual(button.listeners, []);
});

test("mount puts the new layout in place even when what it replaces throws as it goes, and throws that error after", () => {
    const juris = client({ state: { on: true } });
    const error = new Error("cleanup");
    juris.registerComponent("Old", (props, api) => { api.onCleanup(() => { throw error; }); return { p: "old" }; });
    const target = host();
    juris.mount(target, { Old: {} });
    assert.throws(() => juris.mount(target, { p: "new" }), (thrown) => thrown === error);
    assert.deepEqual(target.childNodes.map((n) => n.textContent), ["new"]);
});

// ---- disposeTree -------------------------------------------------------------------------------

test("disposeTree stops the bindings and listeners of an element and of everything inside it", () => {
    const juris = client({ state: { t: "a" } });
    const cleaned = [];
    juris.registerComponent("Leaf", (props, api) => {
        api.onCleanup(() => cleaned.push("leaf"));
        return { i: { textContent: () => juris.getState("t") } };
    });
    const div = juris.render(host(), {
        div: {
            title: () => juris.getState("t"),
            "data-t": () => juris.getState("t"),
            lang: () => juris.getState("t"),
            onclick: () => { },
            children: [{ span: { textContent: () => juris.getState("t") } }, () => juris.getState("t"), { Leaf: {} }, "text"],
        },
    });
    juris.disposeTree(div);
    juris.setValue("t", "b");
    assert.equal(div.getAttribute("title"), "a");
    assert.equal(div.getAttribute("data-t"), "a");
    assert.equal(div.getAttribute("lang"), "a");
    assert.deepEqual(div.listeners, []);
    assert.equal(div.childNodes[0].textContent, "a");
    assert.equal(div.childNodes[1].nodeValue, "a", "the seat no longer runs");
    assert.equal(div.childNodes[2].textContent, "a");
    assert.deepEqual(cleaned, ["leaf"]);
    juris.disposeTree(div); // twice is nothing more
    assert.deepEqual(cleaned, ["leaf"]);
});
