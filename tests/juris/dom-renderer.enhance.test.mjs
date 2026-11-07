// The DOM renderer (dom-renderer.js), enhance(): adopting markup Juris did not draw. Its targets (an
// element, a list, an id, a selector within a root), the handle it answers, dryRun, rebinding,
// unenhance, function enhancers (an anonymous component given the element), its refusals (inside a
// Juris-rendered subtree, a refused tag, innerHTML unless allowHtml), server rows' data-key, a
// component adopting an element as its root, and observe (a MutationObserver fired by hand).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";

import { installDom, el, Element, SVG, FakeNode, FakeText, FakeMutationObserver, settle, deferred } from "../support/dom-renderer-dom.mjs";
import { attributesIn } from "../support/markup.mjs";
import { withSSR } from "../support/ssr-renderer.mjs";

let dom;
beforeEach(() => { dom = installDom(); });
afterEach(() => dom.restore());

const client = (options = {}) => new Juris({ isServer: false, ...options });
const body = () => dom.document.body;
const put = (element) => body().appendChild(element);
const TEXT = FakeNode.TEXT_NODE;

// ---- targets and the handle ------------------------------------------------------------------------

test("enhance takes an element, a list of elements, an id or a selector, and answers a handle of what it matched", () => {
    const juris = client();
    const a = put(el("p", { id: "one", class: "item" }));
    const b = put(el("p", { class: "item" }));
    const c = put(el("p"));

    const byElement = juris.enhance(c, { title: "element" });
    assert.equal(byElement.size, 1);
    assert.equal(byElement.has(c), true);
    assert.equal(byElement.has(a), false);
    assert.deepEqual([...byElement], [c]);
    assert.deepEqual(byElement.elements, [c]);
    assert.equal(byElement.disposed, false);
    assert.equal(c.getAttribute("title"), "element");

    const byId = juris.enhance("one", { "data-by": "id" });
    assert.deepEqual(byId.elements, [a]);
    const bySelector = juris.enhance("p.item", { "data-sel": "yes" });
    assert.deepEqual(bySelector.elements, [a, b]);
    assert.equal(b.getAttribute("data-sel"), "yes");
    const byList = juris.enhance(new Set([b, c]), { "data-list": "yes" });
    assert.deepEqual(byList.elements, [b, c]);
    assert.equal(c.getAttribute("data-list"), "yes");
});

test("a target that is no element, list, id or selector is refused", () => {
    const juris = client();
    const message = "Juris.enhance: target must be an element, a list of elements, an id, or a selector";
    assert.throws(() => juris.enhance(42, {}), { name: "Error", message });
    assert.throws(() => juris.enhance(null, {}), { message });
});

test("a selector is read within options.within, the document by default", () => {
    const juris = client();
    const section = put(el("section", {}, el("p", { class: "x" })));
    put(el("p", { class: "x" }));
    assert.equal(juris.enhance(".x", {}, { within: section, dryRun: true }).size, 1);
    assert.equal(juris.enhance(".x", {}, { dryRun: true }).size, 2);
});

test("devMode: enhance says how many elements it matched", (t) => {
    const debug = t.mock.method(console, "debug", () => { });
    const juris = client({ devMode: true });
    put(el("p", { class: "x" }));
    juris.enhance(".x", { title: "t" });
    assert.equal(debug.mock.callCount(), 1);
    assert.equal(debug.mock.calls[0].arguments[0], "Juris.enhance: 1 element(s) matched");
    assert.equal(debug.mock.calls[0].arguments[1], ".x");
});

test("dryRun answers the matches and binds nothing", () => {
    const juris = client();
    const p = put(el("p"));
    const handle = juris.enhance(p, { title: "x", onclick: () => { } }, { dryRun: true });
    assert.deepEqual(handle.elements, [p]);
    assert.equal(p.hasAttribute("title"), false);
    assert.deepEqual(p.listeners, []);
    handle.dispose();
    assert.equal(handle.disposed, true);
    assert.deepEqual(handle.elements, [p], "nothing was bound, so nothing is let go");
});

test("an enhanced element takes the layout's properties and listeners, and dispose takes them away, once", () => {
    const juris = client({ state: { cls: "on" } });
    const button = put(el("button", { type: "button" }, "Server label"));
    const log = [];
    const clicks = [];
    const handle = juris.enhance(button, (api) => {
        api.onCleanup(() => log.push("cleanup"));
        return { className: () => juris.getState("cls"), onclick: () => clicks.push("click") };
    });
    assert.equal(button.getAttribute("class"), "on");
    assert.equal(button.getAttribute("type"), "button", "what the layout leaves out is the server's");
    assert.equal(button.textContent, "Server label");
    button.fire("click");
    assert.deepEqual(clicks, ["click"]);
    handle.dispose();
    assert.equal(handle.disposed, true);
    assert.equal(handle.size, 0);
    assert.deepEqual(button.listeners, []);
    juris.setValue("cls", "off");
    assert.equal(button.getAttribute("class"), "on", "its binding was disposed");
    handle.dispose();
    assert.deepEqual(log, ["cleanup"]);
});

test("enhancing an element twice rebinds it: listeners and cleanups never stack", () => {
    const juris = client();
    const button = put(el("button"));
    const log = [];
    const first = () => log.push("first click");
    const second = () => log.push("second click");
    juris.enhance(button, (api) => { api.onCleanup(() => log.push("first cleaned")); return { onclick: first }; });
    juris.enhance(button, { onclick: second });
    assert.deepEqual(button.listeners.map((l) => l.listener), [second]);
    button.fire("click");
    assert.deepEqual(log, ["first cleaned", "second click"]);
});

test("unenhance lets an enhanced element go; an element never enhanced is left alone", () => {
    const juris = client({ state: { t: "a" } });
    const p = put(el("p"));
    juris.enhance(p, { title: () => juris.getState("t") });
    juris.unenhance(p);
    juris.setValue("t", "b");
    assert.equal(p.getAttribute("title"), "a");
    const drawn = juris.render(put(el("div")), { button: { onclick: () => { } } });
    juris.unenhance(drawn);
    assert.equal(drawn.listeners.length, 1, "a drawn element's listeners are its layout's");
});

// ---- function enhancers ----------------------------------------------------------------------------

test("a function enhancer runs as a component given the api and the element; onMount gets the element, cleanups run on unenhance", () => {
    const juris = client();
    const section = put(el("section"));
    const log = [];
    let given = null;
    juris.enhance(section, (api) => {
        given = api;
        api.onMount((root) => {
            log.push(["mount", root === section]);
            return () => log.push("mount cleanup");
        });
        api.onCleanup(() => log.push("cleanup"));
        return { title: "enhanced" };
    });
    assert.equal(given.element, section);
    assert.equal(given.getState, juris.api.getState);
    assert.ok(Object.isFrozen(given));
    assert.equal(section.getAttribute("title"), "enhanced");
    assert.deepEqual(log, [["mount", true]]);
    juris.unenhance(section);
    assert.deepEqual(log, [["mount", true], "cleanup", "mount cleanup"]);
});

test("a function enhancer may answer nothing", () => {
    const juris = client();
    const p = put(el("p", { title: "server" }, "text"));
    const handle = juris.enhance(p, () => null);
    assert.equal(handle.size, 1);
    assert.equal(p.getAttribute("title"), "server");
    assert.equal(p.textContent, "text");
});

test("an enhancer that throws leaves the component stack as it was", () => {
    const juris = client();
    const p = put(el("p"));
    assert.throws(() => juris.enhance(p, () => { throw new Error("enhancer failed"); }), { message: "enhancer failed" });
    assert.equal(juris.componentStack.length, 0);
    assert.throws(() => juris.api.onCleanup(() => { }), /must be called during component setup/);
});

test("devMode: a disposed enhancement's function enhancer leaves the component tree", (t) => {
    t.mock.method(console, "debug", () => { });
    const juris = client({ devMode: true });
    const handle = juris.enhance(put(el("p")), () => ({ title: "x" }));
    assert.deepEqual(juris.componentTree().map((node) => [node.name, node.adopted]), [["enhance", true]]);
    handle.dispose();
    assert.deepEqual(juris.componentTree().map((node) => node.name), []);
});

test("devMode: an enhancer with cleanups is in the component tree until its enhancement is disposed", (t) => {
    t.mock.method(console, "debug", () => { });
    const juris = client({ devMode: true });
    const handle = juris.enhance(put(el("p")), (api) => { api.onCleanup(() => { }); return { title: "x" }; });
    assert.deepEqual(juris.componentTree().map((node) => [node.name, node.adopted, node.disposed]), [["enhance", true, false]]);
    handle.dispose();
    assert.deepEqual(juris.componentTree(), []);
});

// ---- refusals ------------------------------------------------------------------------------------

test("enhance refuses an element inside a Juris-rendered subtree, unless forced", () => {
    const juris = client();
    const target = put(el("div"));
    const div = juris.render(target, { div: { children: [{ span: "drawn" }] } });
    const span = div.firstChild;
    assert.throws(() => juris.enhance(span, { title: "x" }), {
        message: "Juris.enhance: element is inside a Juris-rendered subtree; its properties belong to that layout (pass { force: true } to override)",
    });
    assert.equal(span.hasAttribute("title"), false);
    juris.enhance(span, { title: "forced" }, { force: true });
    assert.equal(span.getAttribute("title"), "forced");
    juris.enhance(target, { title: "host" });
    assert.equal(target.getAttribute("title"), "host", "the element Juris drew into is not inside what it drew");
});

test("enhance refuses an element of a refused tag, unless allowTags names it", () => {
    const frame = put(el("iframe"));
    assert.throws(() => client().enhance(frame, { src: "https://elsewhere.test/" }), {
        message: 'Juris.enhance: cannot enhance it: <iframe> is not allowed in a layout (pass allowTags: ["iframe"] if it really is wanted)',
    });
    assert.equal(frame.hasAttribute("src"), false);
    client({ allowTags: ["iframe"] }).enhance(frame, { src: "https://example.test/" });
    assert.equal(frame.getAttribute("src"), "https://example.test/");
});

test("innerHTML is refused anywhere inside an enhancement, a child a binding draws later included", () => {
    const juris = client({ state: { show: false } });
    const message = "Juris.enhance: innerHTML is not allowed inside an enhanced element (use textContent, or pass { allowHtml: true })";
    assert.throws(() => juris.enhance(put(el("div")), { innerHTML: "<b>x</b>" }), { message });
    assert.throws(() => juris.enhance(put(el("div")), { children: [{ p: { children: [{ i: { innerHTML: "<b>x</b>" } }] } }] }), { message });
    const later = put(el("div"));
    juris.enhance(later, { children: () => (juris.getState("show") ? [{ p: { innerHTML: "<b>x</b>" } }] : []) });
    assert.throws(() => juris.setValue("show", true), { message });
    assert.equal(later.textContent, "");
});

test("allowHtml opens innerHTML inside that enhancement, for what a binding draws later too, where the instance refuses it", () => {
    const juris = client({ state: { show: false } });
    const div = put(el("div"));
    juris.enhance(div, { children: () => (juris.getState("show") ? [{ p: { innerHTML: "<b>x</b>" } }] : []) }, { allowHtml: true });
    juris.setValue("show", true);
    assert.equal(div.firstChild.innerHTML, "<b>x</b>");
    const own = put(el("div"));
    juris.enhance(own, { innerHTML: "<i>root</i>" }, { allowHtml: true });
    assert.equal(own.innerHTML, "<i>root</i>");
    assert.equal(juris.render(put(el("div")), { p: { innerHTML: "<b>x</b>" } }).html, undefined, "outside it, the instance's rule");
});

// ---- server markup ---------------------------------------------------------------------------------

test("an enhanced element's children are reconciled against the server's: rows of the same tags are kept", () => {
    const juris = client();
    const ul = put(el("ul", {}, el("li", {}, "one"), el("li", {}, "two")));
    const [one, two] = ul.childNodes;
    juris.enhance(ul, { children: [{ li: "ONE" }, { li: "TWO" }] });
    assert.deepEqual(ul.childNodes, [one, two]);
    assert.deepEqual(ul.childNodes.map((n) => n.textContent), ["ONE", "TWO"]);
});

test("server rows carrying data-key become keyed children, so a keyed list keeps and moves them", () => {
    const juris = client({ state: { items: ["a", "b"] } });
    const ul = put(el("ul", {}, el("li", { "data-key": "a" }, "A"), el("li", { "data-key": "b" }, "B")));
    const [a, b] = ul.childNodes;
    const layout = { children: () => juris.getState("items").map((key) => ({ li: { key, "data-key": key, textContent: key.toUpperCase() } })) };
    juris.enhance(ul, layout);
    assert.deepEqual(ul.childNodes, [a, b]);
    juris.setValue("items", ["b", "a"]);
    assert.deepEqual(ul.childNodes, [b, a]);
    juris.enhance(ul, layout); // again: the rows are already keyed
    assert.deepEqual(ul.childNodes, [b, a]);
    juris.setValue("items", ["b", "a", "c"]);
    assert.deepEqual(ul.childNodes.slice(0, 2), [b, a]);
    assert.equal(ul.childNodes[2].textContent, "C");
});

test("a keyed server row of a refused tag is not reused for a layout naming it", () => {
    const juris = client();
    const div = put(el("div", {}, el("iframe", { "data-key": "f" }), el("p", { "data-key": "p" }, "server")));
    const [frame, p] = div.childNodes;
    juris.enhance(div, { children: [{ iframe: { key: "f", src: "https://elsewhere.test/" } }, { p: { key: "p", textContent: "kept" } }] });
    assert.ok(!div.childNodes.includes(frame), "the server's iframe was not handed the layout");
    assert.equal(frame.hasAttribute("src"), false);
    assert.equal(div.childNodes[0].nodeType, TEXT, "the refused tag's empty text node stands in");
    assert.equal(div.childNodes[1], p);
    assert.equal(p.textContent, "kept");
});

test("an element Juris has not drawn into keeps what its layout leaves out", () => {
    const juris = client();
    const p = put(el("p", { title: "server", class: "s" }, "text"));
    juris.enhance(p, { "data-x": "1" });
    assert.equal(p.getAttribute("title"), "server");
    assert.equal(p.getAttribute("class"), "s");
    assert.equal(p.textContent, "text");
});

test("enhanced with a classList function, the server's element keeps its classes, then follows the state", () => {
    const state = () => ({ menu: { open: true } });
    const server = new Juris(withSSR({ isServer: true, state: state() }));
    const markup = server.renderToString({
        nav: { className: "menu", classList: () => server.getState("menu") },
    });
    assert.equal(markup, '<nav class="menu open"></nav>');
    const nav = put(el("nav", attributesIn(markup)));
    const juris = client({ state: state() });
    juris.enhance(nav, { classList: () => juris.getState("menu") });
    assert.deepEqual(nav.classList.tokens(), ["menu", "open"], "the first frame is the server's");
    juris.setValue("menu", { wide: true });
    assert.equal(nav.parentNode, body(), "adopted, never redrawn");
    assert.deepEqual(nav.classList.tokens(), ["menu", "wide"], "the server's other class is left alone");
});

// Every value the element's class attribute is given, null for a removal.
function classWrites(element) {
    const written = [];
    const { setAttribute, removeAttribute } = element;
    element.setAttribute = function (name, value) {
        if (name === "class") written.push(String(value));
        return setAttribute.call(this, name, value);
    };
    element.removeAttribute = function (name) {
        if (name === "class") written.push(null);
        return removeAttribute.call(this, name);
    };
    return written;
}

test("enhanced with class and classList, the server's classes are never taken off and put back", () => {
    const state = () => ({ base: "menu open", open: false, on: true, menu: { wide: true, card: false } });
    const layouts = (juris) => [
        {
            className: () => juris.getState("base"),
            classList: { open: () => juris.getState("open"), "x y": () => juris.getState("on"), y: false },
        },
        { class: "card", classList: () => juris.getState("menu") },
    ];
    const server = new Juris(withSSR({ isServer: true, state: state() }));
    const markup = layouts(server).map((layout) => server.renderToString({ nav: layout }));
    assert.deepEqual(markup, ['<nav class="menu x"></nav>', '<nav class="wide"></nav>']);
    const navs = markup.map((html) => put(el("nav", attributesIn(html))));
    const written = navs.map(classWrites);
    const juris = client({ state: state() });
    layouts(juris).forEach((layout, index) => juris.enhance(navs[index], layout));
    assert.deepEqual(written, [[], []], "the server's class attributes are left as they are");
    juris.setValue("base", "bar open");
    assert.equal(navs[0].getAttribute("class"), "bar x", "the classList's classes stay as className runs again");
    juris.setValue("menu", { card: true });
    assert.equal(navs[1].getAttribute("class"), "card");
});

// `data-key` is text, whatever the key was (the server writes String(key)), so a row adopted from the
// server holds its key as text until a layout names it: a numeric key is the same row.
const numberRows = (ids) => ids.map((id) => ({ li: { key: id, "data-key": id, textContent: `drawn ${id}` } }));

test("server rows match a layout's numeric keys: data-key is text, and 7 is the row the server wrote as \"7\"", () => {
    const juris = client({ state: { ids: [7, 8] } });
    const ul = put(el("ul", {}, el("li", { "data-key": "7" }, "seven"), el("li", { "data-key": "8" }, "eight")));
    const [seven, eight] = ul.childNodes;
    juris.enhance(ul, { children: () => numberRows(juris.getState("ids")) });
    assert.deepEqual(ul.childNodes, [seven, eight], "the server's rows are kept");
    assert.equal(seven.textContent, "drawn 7");
});

test("a server row that took a numeric key keeps it: later reconciles move it, and a row that goes is removed", () => {
    const juris = client({ state: { ids: [7, 8] } });
    const ul = put(el("ul", {}, el("li", { "data-key": "7" }), el("li", { "data-key": "8" })));
    const [seven, eight] = ul.childNodes;
    juris.enhance(ul, { children: () => numberRows(juris.getState("ids")) });
    juris.setValue("ids", [8, 7]);
    assert.deepEqual(ul.childNodes, [eight, seven]);
    juris.setValue("ids", [8, 9, 7]);
    assert.equal(ul.childNodes[0], eight);
    assert.equal(ul.childNodes[1].textContent, "drawn 9");
    assert.equal(ul.childNodes[2], seven);
    juris.setValue("ids", [9]);
    assert.equal(ul.childNodes.length, 1);
    assert.equal(ul.childNodes[0].textContent, "drawn 9");
});

test("static children with numeric keys match the server's rows too", () => {
    const juris = client();
    const ul = put(el("ul", {}, el("li", { "data-key": "1" }, "one"), el("li", { "data-key": "2" }, "two")));
    const [one, two] = ul.childNodes;
    juris.enhance(ul, { children: numberRows([2, 1]) });
    assert.deepEqual(ul.childNodes, [two, one]);
});

test("a keyed component's row is matched by its numeric key as well, and takes the element over", () => {
    const juris = client();
    juris.registerComponent("Row", (props) => ({ li: { textContent: `row ${props.id}` } }));
    const ul = put(el("ul", {}, el("li", { "data-key": "1" }, "server")));
    const [row] = ul.childNodes;
    juris.enhance(ul, { children: () => [{ Row: { key: 1, id: 1 } }] });
    assert.deepEqual(ul.childNodes, [row]);
    assert.equal(row.textContent, "row 1");
});

test("a text key still matches the server's row as it is, whichever key a number would be", () => {
    const juris = client();
    const ul = put(el("ul", {}, el("li", { "data-key": "1" }, "one")));
    const [one] = ul.childNodes;
    juris.enhance(ul, { children: () => [{ li: { key: "1", textContent: "text key" } }] });
    assert.deepEqual(ul.childNodes, [one]);
});

test("the keys 1 and \"1\" are two rows: one takes the server's, and no element is placed twice", () => {
    const juris = client();
    const ul = put(el("ul", {}, el("li", { "data-key": "1" }, "server")));
    const [row] = ul.childNodes;
    juris.enhance(ul, { children: () => [{ li: { key: 1, textContent: "number" } }, { li: { key: "1", textContent: "text" } }] });
    assert.equal(ul.childNodes.length, 2);
    assert.notEqual(ul.childNodes[0], ul.childNodes[1]);
    assert.ok(ul.childNodes.includes(row));
});

test("only a server row takes a key by its text: a row a layout drew under \"1\" is not the row of 1", () => {
    const juris = client({ state: { key: "1" } });
    const ul = juris.render(put(el("div")), { ul: { children: () => [{ li: { key: juris.getState("key"), textContent: "x" } }] } });
    const [row] = ul.childNodes;
    juris.setValue("key", 1);
    assert.notEqual(ul.childNodes[0], row, "a key that changed is another row, drawn anew");
});

test("only the list's first keyed reconcile claims rows: a row drawn since then is not the row of a number", () => {
    const juris = client({ state: { rows: [1] } });
    const ul = put(el("ul", {}, el("li", { "data-key": "1" }, "server")));
    juris.enhance(ul, { children: () => juris.getState("rows").map((key) => ({ li: { key, textContent: String(key) } })) });
    juris.setValue("rows", [1, "2"]);
    const drawn = ul.childNodes[1];
    juris.setValue("rows", [1, 2]);
    assert.notEqual(ul.childNodes[1], drawn, "a key that changed is another row, drawn anew");
});

// ---- a component adopting the element ------------------------------------------------------------

test("a component adopts an element of its root tag: the element is kept and updated in place", () => {
    const juris = client();
    juris.registerComponent("Card", (props) => ({ article: { className: "card", textContent: props.label } }));
    const article = put(el("article", { class: "server" }, "server text"));
    const handle = juris.enhance(article, { Card: { label: "client" } });
    assert.deepEqual(handle.elements, [article]);
    assert.equal(body().childNodes.at(-1), article);
    assert.equal(article.getAttribute("class"), "card");
    assert.equal(article.textContent, "client");
});

test("an adopted component's root function is given the element and redraws it in place", () => {
    const juris = client({ state: { t: "one" } });
    const given = [];
    juris.registerComponent("Live", () => (root) => { given.push(root); return { section: { textContent: juris.getState("t") } }; });
    const section = put(el("section"));
    juris.enhance(section, { Live: {} });
    juris.setValue("t", "two");
    assert.equal(section.textContent, "two");
    assert.equal(body().childNodes.at(-1), section);
    assert.deepEqual(given, [section, section]);
});

test("an adopted component's onMount runs with the element, and its cleanups run on unenhance", () => {
    const juris = client();
    const log = [];
    juris.registerComponent("Widget", (props, api) => {
        api.onMount((root) => log.push(["mount", root.localName]));
        api.onCleanup(() => log.push("cleanup"));
        return { div: { className: "widget" } };
    });
    const div = put(el("div"));
    juris.enhance(div, { Widget: {} });
    assert.deepEqual(log, [["mount", "div"]]);
    juris.unenhance(div);
    assert.deepEqual(log, [["mount", "div"], "cleanup"]);
});

test("a component that draws text, nothing, or a function cannot adopt an element", () => {
    const juris = client();
    juris.registerComponent("Text", () => "just text");
    juris.registerComponent("Nothing", () => null);
    juris.registerComponent("Seat", () => () => () => ({ div: {} }));
    for (const name of ["Text", "Nothing", "Seat"]) {
        assert.throws(() => juris.enhance(put(el("div")), { [name]: {} }), { message: `Juris.enhance: component "${name}" must return an element layout to adopt <div>` }, name);
    }
});

test("a component that returns a list cannot adopt an element, and is told as anywhere a component returns one", () => {
    const juris = client();
    juris.registerComponent("Rows", () => [{ div: "Milk" }, { div: "Eggs" }]);
    assert.throws(() => juris.enhance(put(el("div")), { Rows: {} }), {
        message: "Juris: a layout is one { tag: content } object; a component cannot return an array"
            + ": wrap the children in an element",
    });
});

test("a component that draws another tag, or another component, cannot adopt an element", () => {
    const juris = client();
    juris.registerComponent("Span", () => ({ span: {} }));
    juris.registerComponent("Wrap", () => ({ Span: {} }));
    assert.throws(() => juris.enhance(put(el("div")), { Span: {} }), { message: 'Juris.enhance: component "Span" renders <span> but is adopting <div>' });
    assert.throws(() => juris.enhance(put(el("div")), { Wrap: {} }), { message: 'Juris.enhance: component "Wrap" renders <Span> but is adopting <div>' });
});

test("a component cannot adopt an element of a refused tag, unless allowTags names it", () => {
    const frame = put(el("iframe"));
    const refusing = client();
    refusing.registerComponent("Frame", () => ({ iframe: { src: "https://example.test/" } }));
    assert.throws(() => refusing.enhance(frame, { Frame: {} }), { message: /^Juris\.enhance: component "Frame" cannot adopt it: <iframe> is not allowed/ });
    assert.equal(frame.hasAttribute("src"), false);
    const allowing = client({ allowTags: ["iframe"] });
    allowing.registerComponent("Frame", () => ({ iframe: { src: "https://example.test/" } }));
    allowing.enhance(frame, { Frame: {} });
    assert.equal(frame.getAttribute("src"), "https://example.test/");
});

test("a function enhancer may answer a component, which adopts the element; unenhance disposes both", () => {
    const juris = client();
    const log = [];
    juris.registerComponent("Card", (props, api) => {
        api.onCleanup(() => log.push("card"));
        return { article: { textContent: props.label } };
    });
    const article = put(el("article", { id: "a1" }));
    juris.enhance(article, (api) => {
        api.onCleanup(() => log.push("enhancer"));
        return { Card: { label: `card ${api.element.id}` } };
    });
    assert.equal(article.textContent, "card a1");
    juris.unenhance(article);
    // Innermost first, as every disposal is: the adopted card is inside the enhancer that answered it.
    assert.deepEqual(log, ["card", "enhancer"]);
});

test("an adopted component that is a boundary shows only its fallback when a binding in its first draw throws", () => {
    const juris = client();
    juris.registerComponent("Card", (props, api) => {
        api.onError(() => ({ div: { className: "fallback", textContent: "oops" } }));
        return { div: { children: [{ p: { textContent: () => { juris.getState("x"); throw new Error("bad"); } } }] } };
    });
    const div = put(el("div", {}, "server"));
    juris.enhance(div, (api) => { api.onCleanup(() => { }); return { Card: {} }; });
    assert.equal(div.getAttribute("class"), "fallback");
    assert.deepEqual(div.childNodes.map((n) => n.nodeValue ?? n.localName), ["oops"]);
});

test("a fallback an adopted boundary shows after its first draw disposes only what was inside it, never the enhancer that answered it", () => {
    const juris = client({ state: { bad: false } });
    const log = [];
    juris.registerComponent("Card", (props, api) => {
        api.onCleanup(() => log.push("card"));
        api.onError(() => ({ div: { className: "fallback", textContent: "oops" } }));
        return { div: { children: [{ p: { textContent: () => { if (juris.getState("bad")) throw new Error("bad"); return "ok"; } } }] } };
    });
    const div = put(el("div", {}, "server"));
    juris.enhance(div, (api) => { api.onCleanup(() => log.push("enhancer")); return { Card: {} }; });
    juris.setValue("bad", true);
    assert.equal(div.getAttribute("class"), "fallback");
    assert.deepEqual(log, [], "neither the enhancer nor the boundary goes");
    juris.unenhance(div);
    assert.deepEqual(log, ["card", "enhancer"], "innermost first");
});

test("a function enhancer that is a boundary shows only its fallback when a binding in its first draw throws", () => {
    const juris = client();
    const fallback = () => ({ div: { className: "fallback", textContent: "oops" } });
    const failing = () => ({ p: { textContent: () => { juris.getState("x"); throw new Error("bad"); } } });
    juris.registerComponent("Card", () => ({ div: { children: [failing()] } }));
    const own = put(el("div", {}, "server"));
    juris.enhance(own, (api) => { api.onError(fallback); return { children: [failing()] }; });
    const adopted = put(el("div", {}, "server"));
    juris.enhance(adopted, (api) => { api.onError(fallback); return { Card: {} }; });
    for (const div of [own, adopted]) {
        assert.equal(div.getAttribute("class"), "fallback");
        assert.deepEqual(div.childNodes.map((n) => n.nodeValue ?? n.localName), ["oops"]);
    }
});

test("a component adopted in a first draw that its enhancer's fallback replaces is disposed: its cleanups run and it leaves the tree", (t) => {
    t.mock.method(console, "debug", () => { });
    const juris = client({ devMode: true });
    const log = [];
    juris.registerComponent("Card", (props, api) => {
        api.onCleanup(() => log.push("card"));
        return { div: { children: [{ p: { textContent: () => { juris.getState("x"); throw new Error("bad"); } } }] } };
    });
    const div = put(el("div", {}, "server"));
    juris.enhance(div, (api) => { api.onError(() => ({ div: { className: "fallback", textContent: "oops" } })); return { Card: {} }; });
    assert.equal(div.getAttribute("class"), "fallback");
    assert.deepEqual(log, ["card"]);
    assert.deepEqual(juris.componentTree().map((node) => [node.name, node.children.map((child) => child.name)]), [["enhance", []]]);
});

test("a later fallback of an enhanced or adopted SVG element is drawn in SVG, where the element was drawn", () => {
    const juris = client({ state: { bad: false } });
    const failing = () => ({ circle: { r: () => { if (juris.getState("bad")) throw new Error("bad"); return "1"; } } });
    juris.registerComponent("Mark", (props, api) => {
        api.onError(() => ({ text: "oops" }));
        return { g: { children: [failing()] } };
    });
    const svg = put(new Element("svg", SVG));
    juris.enhance(svg.appendChild(new Element("g", SVG)), (api) => { api.onError(() => ({ text: "oops" })); return { children: [failing()] }; });
    juris.enhance(svg.appendChild(new Element("g", SVG)), { Mark: {} });
    juris.setValue("bad", true);
    assert.deepEqual(svg.childNodes.map((n) => [n.localName, n.namespaceURI]), [["text", SVG], ["text", SVG]]);
});

test("a fallback of another tag stands in for the enhanced element it replaced: unenhance, given that element, disposes what moved to it", () => {
    const juris = client({ state: { bad: false, n: 0 } });
    const log = [];
    juris.registerComponent("Card", (props, api) => {
        api.onCleanup(() => log.push("card"));
        api.onError(() => ({ p: { textContent: () => `oops ${juris.getState("n")}` } }));
        return { div: { children: [{ span: { textContent: () => { if (juris.getState("bad")) throw new Error("bad"); return "ok"; } } }] } };
    });
    const div = put(el("div", {}, "server"));
    const handle = juris.enhance(div, (api) => { api.onCleanup(() => log.push("enhancer")); return { Card: {} }; });
    juris.setValue("bad", true);
    const p = body().firstChild;
    assert.equal(p.textContent, "oops 0");
    handle.dispose();
    assert.deepEqual(log, ["card", "enhancer"]);
    juris.setValue("n", 1);
    assert.equal(p.textContent, "oops 0", "the fallback's binding went with them");
    const other = put(el("div"));
    juris.enhance(other, { Card: {} }); // its first draw fails: its fallback replaces it at once
    juris.unenhance(body().childNodes[1]);
    assert.deepEqual(log, ["card", "enhancer", "card"], "given what stands in its place, too");
});

test("observe keeps an enhanced element's stand-in: the fallback's swap unenhances nothing, and the handle holds the stand-in", () => {
    const juris = client({ state: { bad: false } });
    const log = [];
    juris.registerComponent("Card", (props, api) => {
        api.onCleanup(() => log.push("card"));
        api.onError(() => ({ p: { class: "card", textContent: "oops" } }));
        return { div: { children: [{ span: { textContent: () => { if (juris.getState("bad")) throw new Error("bad"); return "ok"; } } }] } };
    });
    const div = put(el("div", { class: "card" }, "server"));
    const handle = juris.enhance(".card", { Card: {} }, { observe: true });
    const [observer] = FakeMutationObserver.instances;
    juris.setValue("bad", true);
    const p = body().firstChild;
    observer.deliver({ removedNodes: [div], addedNodes: [p] });
    assert.deepEqual(log, []);
    assert.deepEqual(handle.elements, [p]);
    handle.dispose();
    assert.deepEqual(log, ["card"]);
});

test("without observe, the handle names a replaced element's stand-in: elements, has(), size and iteration describe what is enhanced now", () => {
    const juris = client({ state: { bad: false } });
    juris.registerComponent("Card", (props, api) => {
        api.onError(() => ({ p: "oops" }));
        return { div: { children: [{ span: { textContent: () => { if (juris.getState("bad")) throw new Error("bad"); return "ok"; } } }] } };
    });
    const div = put(el("div"));
    const handle = juris.enhance(div, { Card: {} });
    const elements = handle.elements;
    juris.setValue("bad", true);
    const p = body().firstChild;
    assert.deepEqual(handle.elements, [p]);
    assert.equal(handle.elements, elements, "the same list, brought up to date");
    assert.equal(handle.has(p), true);
    assert.equal(handle.has(div), false);
    assert.deepEqual([...handle], [p]);
    assert.equal(handle.size, 1);
});

test("an error no boundary takes, escaping an enhancement's first draw, disposes the adopted component and the enhancer, innermost first, and reaches the caller", (t) => {
    t.mock.method(console, "debug", () => { });
    const juris = client({ devMode: true });
    const log = [];
    const error = new Error("bad");
    juris.registerComponent("Done", (props, api) => { api.onCleanup(() => log.push("done")); return { span: "drawn" }; });
    juris.registerComponent("Card", (props, api) => {
        api.onCleanup(() => log.push("card"));
        return { div: { children: [{ Done: {} }, { p: { textContent: () => { juris.getState("x"); throw error; } } }] } };
    });
    const div = put(el("div", {}, "server"));
    assert.throws(() => juris.enhance(div, (api) => { api.onCleanup(() => log.push("enhancer")); return { Card: {} }; }), (thrown) => thrown === error);
    assert.deepEqual(log, ["done", "card", "enhancer"]);
    assert.deepEqual(juris.componentTree(), []);
});

test("an enhancement whose first draw throws is undone, with the ones the same call made before it: none stays enhanced, nothing disposed stays on it", (t) => {
    t.mock.method(console, "debug", () => { });
    const juris = client({ devMode: true });
    const log = [];
    const error = new Error("bad");
    const enhancer = (api) => {
        api.onCleanup(() => log.push(api.element.id));
        return { title: () => { juris.getState("x"); if (api.element.hasAttribute("data-bad")) throw error; return "ok"; } };
    };
    const a = put(el("p", { class: "row", id: "a" }));
    const b = put(el("p", { class: "row", id: "b", "data-bad": "" }));
    assert.throws(() => juris.enhance(".row", enhancer), (thrown) => thrown === error);
    assert.deepEqual(log, ["b", "a"], "the one that threw, then the one before it");
    for (const p of [a, b]) {
        assert.equal(juris.renderer.enhanced.has(p), false);
        assert.equal(juris.componentInstances.get(p), undefined);
    }
    assert.deepEqual(juris.componentTree(), []);
    // A match observe adds later whose draw throws is undone the same way, and never listed.
    const handle = juris.enhance(".late", enhancer, { observe: true });
    const observer = FakeMutationObserver.instances[FakeMutationObserver.instances.length - 1];
    const ok = put(el("p", { class: "late", id: "ok" }));
    const bad = put(el("p", { class: "late", id: "bad", "data-bad": "" }));
    assert.throws(() => observer.deliver({ addedNodes: [ok, bad] }), (thrown) => thrown === error);
    assert.deepEqual(handle.elements, [ok]);
    assert.equal(juris.renderer.enhanced.has(bad), false);
    assert.equal(juris.componentInstances.get(bad), undefined);
    assert.deepEqual(log, ["b", "a", "bad"]);
});

test("observe goes through every added match whatever one throws: the one that threw is undone, and the first error is thrown once all are done", () => {
    const juris = client();
    const first = new Error("first");
    const enhancer = (api) => ({
        title: () => {
            juris.getState("x");
            const bad = api.element.getAttribute("data-bad");
            if (bad) throw bad === "1" ? first : new Error("second");
            return "ok";
        },
    });
    const handle = juris.enhance(".late", enhancer, { observe: true });
    const observer = FakeMutationObserver.instances[FakeMutationObserver.instances.length - 1];
    const one = put(el("p", { class: "late", "data-bad": "1" }));
    const two = put(el("p", { class: "late" }));
    const three = put(el("p", { class: "late", "data-bad": "2" }));
    const four = put(el("p", { class: "late" }));
    assert.throws(() => observer.deliver({ addedNodes: [one, two] }, { addedNodes: [three, four] }), (thrown) => thrown === first);
    assert.deepEqual(handle.elements, [two, four]);
    assert.deepEqual([one, three].map((p) => juris.renderer.enhanced.has(p)), [false, false]);
    assert.deepEqual([two, four].map((p) => p.getAttribute("title")), ["ok", "ok"]);
});

// A root function's binding has the adopted element to mark, as a property's has: nothing was given
// it, so $async.slow counted the wait and no element ever showed it.
test("an adopting component whose root function waits on a slow promise marks the element it adopted", async () => {
    const juris = client({ pendingDelay: 0 });
    const value = deferred();
    juris.registerComponent("Card", () => () => value.promise);
    const card = put(el("p", {}, "server"));
    juris.enhance(card, { Card: {} });
    await settle();
    assert.equal(juris.getState("$async.slow"), 1);
    assert.equal(card.hasAttribute("data-pending"), true);
    value.resolve({ p: "drawn" });
    await settle();
    assert.equal(card.hasAttribute("data-pending"), false);
    assert.equal(card.textContent, "drawn");
});

test("an adopting component's async definition is refused in the words of a layout it does not return", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    t.mock.method(console, "debug", () => { });
    const juris = client({ devMode: true });
    juris.registerComponent("Card", async () => ({ p: "drawn" }));
    const card = put(el("p", {}, "server"));
    assert.throws(() => juris.enhance(card, { Card: {} }), {
        message: 'Juris.enhance: component "Card" must return an element layout to adopt <p>',
    });
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /^Juris: dropped component "Card": its definition returned a promise/);
});

// ---- observe -------------------------------------------------------------------------------------

test("observe watches the root it reads selectors in, for nodes added anywhere below", () => {
    const juris = client();
    const section = put(el("section"));
    juris.enhance(".row", {}, { observe: true });
    juris.enhance(".row", {}, { observe: true, within: section });
    assert.deepEqual(FakeMutationObserver.instances.map((o) => o.observed), [
        [{ target: dom.document, options: { childList: true, subtree: true } }],
        [{ target: section, options: { childList: true, subtree: true } }],
    ]);
});

test("observe enhances matches added later, inside an added element too, each once", () => {
    const juris = client();
    const list = put(el("ul", {}, el("li", { class: "row" }, "1")));
    const handle = juris.enhance(".row", { "data-enhanced": "yes" }, { observe: true });
    const [observer] = FakeMutationObserver.instances;
    const added = list.appendChild(el("li", { class: "row" }, "2"));
    const nested = el("p", { class: "row" });
    const wrapper = put(el("div", {}, nested, el("span")));
    observer.deliver({ addedNodes: [added, wrapper, new FakeText("text")] });
    assert.equal(added.getAttribute("data-enhanced"), "yes");
    assert.equal(nested.getAttribute("data-enhanced"), "yes");
    assert.equal(wrapper.hasAttribute("data-enhanced"), false);
    assert.equal(handle.size, 3);
    observer.deliver({ addedNodes: [added] });
    assert.equal(handle.size, 3, "already enhanced: not again");
    const outer = el("li", { class: "row" }, el("b", { class: "row" }));
    list.appendChild(outer);
    observer.deliver({ addedNodes: [outer] });
    assert.ok(handle.has(outer) && handle.has(outer.firstChild), "a match and the matches inside it");
});

test("observe disposes enhanced elements that leave the document, inside a removed element too, and drops them from the handle", () => {
    const juris = client();
    const log = [];
    const a = put(el("button", { id: "a", class: "b" }));
    const inner = el("button", { id: "c", class: "b" });
    const wrapper = put(el("div", {}, inner));
    put(el("button", { id: "d", class: "b" }));
    const handle = juris.enhance(".b", (api) => {
        api.onCleanup(() => log.push(api.element.id));
        return { onclick: () => { } };
    }, { observe: true });
    const [observer] = FakeMutationObserver.instances;
    assert.equal(handle.size, 3);
    a.remove();
    observer.deliver({ removedNodes: [a, new FakeText("gone")] });
    assert.deepEqual(log, ["a"]);
    assert.equal(handle.has(a), false);
    assert.deepEqual(a.listeners, []);
    wrapper.remove();
    observer.deliver({ removedNodes: [wrapper] });
    assert.deepEqual(log, ["a", "c"]);
    assert.equal(handle.size, 1);
    handle.dispose();
    assert.equal(observer.connected, false, "dispose disconnects the observer");
    assert.deepEqual(log, ["a", "c", "d"]);
});

test("observe with an element target only lets go of what leaves; nothing added is matched", () => {
    const juris = client();
    const p = put(el("p"));
    const handle = juris.enhance(p, { title: "x" }, { observe: true });
    const [observer] = FakeMutationObserver.instances;
    const other = put(el("p"));
    observer.deliver({ addedNodes: [other] });
    assert.equal(handle.size, 1);
    assert.equal(other.hasAttribute("title"), false);
    p.remove();
    observer.deliver({ removedNodes: [p] });
    assert.equal(handle.size, 0);
});

test("observe where there is no MutationObserver enhances what is there, and nothing later", () => {
    delete globalThis.MutationObserver;
    const juris = client();
    put(el("p", { class: "row" }));
    const handle = juris.enhance(".row", { title: "x" }, { observe: true });
    assert.equal(handle.size, 1);
    assert.equal(FakeMutationObserver.instances.length, 0);
    handle.dispose();
    assert.equal(handle.disposed, true);
});

test("a re-enhancement whose draw throws after the previous one's components went leaves nothing of theirs on the element", (t) => {
    const juris = client();
    const error = new Error("bad");
    juris.registerComponent("Card", () => ({ div: { children: [{ span: "card" }] } }));
    const div = put(el("div"));
    juris.enhance(div, () => ({ Card: {} }));
    assert.equal(div.textContent, "card");
    assert.throws(() => juris.enhance(div, () => ({ title: () => { juris.getState("x"); throw error; } })), (thrown) => thrown === error);
    assert.equal(div.childNodes.length, 0);
    assert.equal(juris.renderer.enhanced.has(div), false);
});

test("observe's removals all go, whichever one's cleanup throws, and the first error is thrown once the batch is done", () => {
    const juris = client();
    const log = [];
    const first = new Error("first");
    const container = put(el("section", {}, el("p", { class: "row", id: "a" }), el("p", { class: "row", id: "b" })));
    const c = put(el("p", { class: "row", id: "c" }));
    const handle = juris.enhance(".row", (api) => { api.onCleanup(() => { log.push(api.element.id); if (api.element.id === "a") throw first; }); return {}; }, { observe: true });
    const observer = FakeMutationObserver.instances[FakeMutationObserver.instances.length - 1];
    container.remove();
    c.remove();
    assert.throws(() => observer.deliver({ removedNodes: [container] }, { removedNodes: [c] }), (thrown) => thrown === first);
    assert.deepEqual(log, ["a", "b", "c"]);
    assert.equal(handle.size, 0);
});

test("a handle's dispose unenhances every element whichever one's cleanup throws, and throws the first error after", () => {
    const juris = client();
    const log = [];
    const first = new Error("first");
    put(el("p", { class: "row", id: "a" }));
    put(el("p", { class: "row", id: "b" }));
    const handle = juris.enhance(".row", (api) => { api.onCleanup(() => { log.push(api.element.id); if (api.element.id === "a") throw first; }); return {}; });
    assert.throws(() => handle.dispose(), (thrown) => thrown === first);
    assert.deepEqual(log, ["a", "b"]);
});

test("an enhance call undone after one element's draw throws undoes every one before it, whichever cleanup throws, and hands on the draw's error", () => {
    const juris = client();
    const log = [];
    const draw = new Error("draw");
    const elements = ["a", "b", "c"].map((id) => put(el("p", { class: "row", id })));
    const enhancer = (api) => {
        api.onCleanup(() => { log.push(api.element.id); if (api.element.id === "a") throw new Error("cleanup"); });
        return { title: () => { juris.getState("x"); if (api.element.id === "c") throw draw; return "ok"; } };
    };
    assert.throws(() => juris.enhance(".row", enhancer), (thrown) => thrown === draw);
    assert.deepEqual(log, ["c", "a", "b"]);
    assert.deepEqual(elements.map((p) => juris.renderer.enhanced.has(p)), [false, false, false]);
});

test("a re-enhancement disposes every part of the previous one, whichever throws, and is undone with that error", () => {
    const juris = client();
    const log = [];
    const error = new Error("removal");
    const div = put(el("div"));
    juris.enhance(div, (api) => { api.onCleanup(() => log.push("previous")); return { onclick: () => { } }; });
    const remove = div.removeEventListener.bind(div);
    div.removeEventListener = (type, listener) => { remove(type, listener); throw error; };
    assert.throws(() => juris.enhance(div, () => ({ title: "next" })), (thrown) => thrown === error);
    assert.deepEqual(log, ["previous"]);
    assert.equal(juris.renderer.enhanced.has(div), false);
});

test("a component adopted by an enhancement whose setup throws is disposed: its cleanups run and it leaves the tree", (t) => {
    t.mock.method(console, "debug", () => { });
    const juris = client({ devMode: true });
    const log = [];
    const error = new Error("setup");
    juris.registerComponent("Card", (props, api) => { api.onCleanup(() => log.push("card")); throw error; });
    assert.throws(() => juris.enhance(put(el("div")), { Card: {} }), (thrown) => thrown === error);
    assert.deepEqual(log, ["card"]);
    assert.deepEqual(juris.componentTree(), []);
});

test("an adopted component's setup error is offered to the boundaries: its own handler first, then the enhancer's, whose fallback is drawn in the element's place and namespace", (t) => {
    t.mock.method(console, "warn", () => { });
    const juris = client();
    const error = new Error("setup");
    juris.registerComponent("Card", () => { throw error; });
    juris.registerComponent("Mark", (props, api) => { api.onError(() => ({ text: "oops" })); throw error; });
    juris.registerComponent("Quiet", (props, api) => { api.onError(() => undefined); throw error; });
    const byEnhancer = put(el("div", {}, "server"));
    juris.enhance(byEnhancer, (api) => { api.onError(() => ({ div: { class: "fallback", textContent: "oops" } })); return { Card: {} }; });
    assert.equal(byEnhancer.getAttribute("class"), "fallback");
    assert.deepEqual(byEnhancer.childNodes.map((n) => n.nodeValue), ["oops"]);
    const svg = put(new Element("svg", SVG));
    juris.enhance(svg.appendChild(new Element("g", SVG)), { Mark: {} });
    assert.deepEqual(svg.childNodes.map((n) => [n.localName, n.namespaceURI, n.textContent]), [["text", SVG, "oops"]], "its own handler's fallback, in SVG");
    const quiet = put(el("p", {}, "server"));
    juris.enhance(quiet, { Quiet: {} });
    assert.equal(quiet.parentNode, null, "swallowed, it renders nothing, as createComponent's does");
});

// ---- an element a layout draws again ---------------------------------------------------------------

const first = (root, selector) => root.querySelectorAll(selector)[0] ?? null;

// A page holding a design from state: `{ main: { children: () => design } }`, drawn by the layout, and
// enhanced by selector, as a layout stored in a database is.
function designPage(juris, design) {
    juris.setValue("design", design);
    const page = put(el("div"));
    juris.render(page, { main: { children: () => juris.getState("design") } });
    return page;
}

test("an enhanced element a new layout reuses is enhanced again, on what it is now", () => {
    const juris = client();
    juris.setValue("lot", { yield: "98%", step: 3 });
    const bound = (name) => [{ b: { className: "bound", "data-state": name, textContent: "-" } }];
    const page = designPage(juris, bound("lot.yield"));
    const handle = juris.enhance(".bound", ({ element, getState }) => ({
        textContent: () => String(getState(element.getAttribute("data-state"))),
    }), { observe: true, force: true });
    const element = first(page, ".bound");
    assert.equal(element.textContent, "98%");

    juris.setValue("design", bound("lot.step"));

    assert.equal(first(page, ".bound"), element, "the element was reused");
    assert.equal(element.textContent, "3");
    juris.setValue("lot.step", 4);
    assert.equal(element.textContent, "4", "it is live on the path it names now");
    juris.setValue("lot.yield", "1%");
    assert.equal(element.textContent, "4", "and no longer on the old one");
    assert.equal(handle.size, 1);
});

test("the enhancer that a redraw replaces has its cleanups run, once", () => {
    const juris = client();
    const cleanups = [];
    const page = designPage(juris, [{ b: { className: "bound", textContent: "a" } }]);
    juris.enhance(".bound", ({ onCleanup, element }) => {
        const was = element.textContent;
        onCleanup(() => cleanups.push(was));
        return {};
    }, { observe: true, force: true });
    assert.ok(first(page, ".bound"));

    juris.setValue("design", [{ b: { className: "bound", textContent: "b" } }]);

    assert.deepEqual(cleanups, ["a"]);
});

test("an element a new layout stops matching is let go, and the handle says so", () => {
    const juris = client();
    let cleaned = 0;
    const page = designPage(juris, [{ b: { className: "bound", textContent: "a" } }]);
    const handle = juris.enhance(".bound", ({ onCleanup }) => {
        onCleanup(() => {
            cleaned += 1;
        });
        return { "data-enhanced": "yes" };
    }, { observe: true, force: true });
    const element = first(page, ".bound");
    assert.equal(handle.size, 1);

    juris.setValue("design", [{ b: { className: "plain", textContent: "b" } }]);

    assert.equal(first(page, "b"), element, "the element was reused");
    assert.equal(handle.size, 0);
    assert.equal(cleaned, 1);
    assert.equal(element.textContent, "b", "what the layout drew stays");
});

test("an element a new layout starts matching is taken, by an enhancement that observes", () => {
    const juris = client();
    const page = designPage(juris, [{ b: { className: "plain", textContent: "a" } }]);
    const handle = juris.enhance(".bound", { "data-enhanced": "yes" }, { observe: true, force: true });
    const element = first(page, "b");
    assert.equal(handle.size, 0);

    juris.setValue("design", [{ b: { className: "bound", textContent: "b" } }]);

    assert.equal(first(page, "b"), element, "the element was reused");
    assert.equal(element.getAttribute("data-enhanced"), "yes");
    assert.ok(handle.has(element));
});

test("an enhancement with no observe still follows a reused element it holds, and takes no new one", () => {
    const juris = client();
    const page = designPage(juris, [{ b: { className: "bound", textContent: "a" } }, { i: { className: "plain" } }]);
    const handle = juris.enhance(".bound", { "data-enhanced": "yes" }, { force: true });
    const element = first(page, "b");

    juris.setValue("design", [{ b: { className: "bound", textContent: "b" } }, { i: { className: "bound" } }]);

    assert.equal(element.getAttribute("data-enhanced"), "yes");
    assert.equal(handle.size, 1);
    assert.equal(first(page, "i").hasAttribute("data-enhanced"), false);
});

test("a disposed enhancement follows nothing: a redraw leaves the element to the layout", () => {
    const juris = client();
    let runs = 0;
    const page = designPage(juris, [{ b: { className: "bound", textContent: "a" } }]);
    const handle = juris.enhance(".bound", () => {
        runs += 1;
        return {};
    }, { observe: true, force: true });
    assert.equal(runs, 1);
    const kept = first(page, "main");
    handle.dispose();

    juris.setValue("design", [{ b: { className: "bound", textContent: "b" } }]);

    assert.equal(runs, 1);
    assert.ok(first(kept, "b"));
});

test("an element that comes to match is taken only inside the root the enhancement watches", () => {
    const juris = client();
    const inside = put(el("section"));
    const outside = put(el("section"));
    juris.setValue("design", [{ b: { className: "plain" } }]);
    const layout = { main: { children: () => juris.getState("design") } };
    juris.render(inside, layout);
    juris.render(outside, layout);
    const handle = juris.enhance(".bound", { "data-enhanced": "yes" }, { observe: true, force: true, within: inside });

    juris.setValue("design", [{ b: { className: "bound" } }]);

    assert.equal(first(inside, "b").getAttribute("data-enhanced"), "yes");
    assert.equal(first(outside, "b").hasAttribute("data-enhanced"), false);
    assert.equal(handle.size, 1);
});

test("what a layout gave and its next layout leaves out goes, from an enhanced element too", () => {
    const juris = client();
    juris.setValue("stock", 12);
    const page = designPage(juris, [{ b: { className: "bound", title: "was here" } }]);
    const handle = juris.enhance(".bound", ({ getState }) => ({
        textContent: () => String(getState("stock")),
    }), { observe: true, force: true });
    const element = first(page, "b");
    assert.equal(element.textContent, "12");

    juris.setValue("design", [{ b: { textContent: "Sold out" } }]);

    assert.equal(first(page, "b"), element, "the element was reused");
    assert.equal(element.hasAttribute("class"), false);
    assert.equal(element.hasAttribute("title"), false);
    assert.equal(element.textContent, "Sold out");
    assert.equal(handle.size, 0, "it no longer matches, so it is let go");
});

test("what an enhancer gave and the next layout leaves out goes too, until it is enhanced again", () => {
    const juris = client();
    const page = designPage(juris, [{ b: { className: "bound" } }]);
    juris.enhance(".bound", { title: "enhanced" }, { force: true });
    const element = first(page, "b");
    assert.equal(element.getAttribute("title"), "enhanced");

    juris.setValue("design", [{ b: { className: "plain" } }]);

    assert.equal(element.hasAttribute("title"), false);
});
