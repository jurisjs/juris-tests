// The DOM renderer (dom-renderer.js), redrawing: seats (a function in a child position) and the
// function chains they bind, data-pending while a binding waits on a slow promise, the unkeyed and
// the keyed reconcile of a children list (and the longest increasing subsequence the keyed one moves
// by), and an element reused for another layout of its tag: what it keeps, what it loses (F27).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";

import { installDom, Element, FakeFragment, FakeNode, HTML, SVG, settle, deferred } from "../support/dom-renderer-dom.mjs";

let dom;
beforeEach(() => { dom = installDom(); });
afterEach(() => dom.restore());

const client = (options = {}) => new Juris({ isServer: false, ...options });
const host = () => dom.document.body.appendChild(new Element("div", HTML));
const TEXT = FakeNode.TEXT_NODE;
const names = (parent) => parent.childNodes.map((n) => (n.nodeType === TEXT ? `#${n.nodeValue}` : n.localName));

// ---- seats ---------------------------------------------------------------------------------------

test("a function child is a seat: one node, redrawn alone when what it read changes", () => {
    const juris = client({ state: { x: "middle" } });
    const div = juris.render(host(), { div: { children: ["a", () => juris.getState("x"), "b"] } });
    const [first, , last] = div.childNodes;
    assert.deepEqual(names(div), ["#a", "#middle", "#b"]);
    juris.setValue("x", { p: "P" });
    assert.deepEqual(names(div), ["#a", "p", "#b"]);
    assert.equal(div.childNodes[0], first);
    assert.equal(div.childNodes[2], last);
    juris.setValue("x", null);
    assert.deepEqual(names(div), ["#a", "#", "#b"], "showing nothing, it still holds its place");
    juris.setValue("x", "back");
    assert.deepEqual(names(div), ["#a", "#back", "#b"]);
});

test("a seat's function is given the node drawn in its place, null before the first draw", () => {
    const juris = client({ state: { n: 1 } });
    const given = [];
    const div = juris.render(host(), { div: { children: [(node) => { given.push(node); return { span: String(juris.getState("n")) }; }] } });
    const span = div.firstChild;
    juris.setValue("n", 2);
    assert.deepEqual(given, [null, span]);
    assert.equal(div.firstChild, span, "the same tag: updated in place");
    assert.equal(span.textContent, "2");
});

test("a seat that draws the same text again keeps its text node", () => {
    const juris = client({ state: { n: 1 } });
    const div = juris.render(host(), { div: { children: [() => (juris.getState("n") > 0 ? "positive" : "not")] } });
    const node = div.firstChild;
    juris.setValue("n", 2);
    assert.equal(div.firstChild, node);
    assert.equal(node.nodeValue, "positive");
    juris.setValue("n", -1);
    assert.equal(div.firstChild, node);
    assert.equal(node.nodeValue, "not");
});

test("a seat whose function gives a function binds that one in its place, and lets it go when the first gives something else", () => {
    const juris = client({ state: { mode: "inner", x: 1 } });
    let innerRuns = 0;
    const div = juris.render(host(), {
        div: {
            children: [() => (juris.getState("mode") === "inner" ? () => { innerRuns += 1; return { b: String(juris.getState("x")) }; } : "plain")],
        },
    });
    assert.deepEqual(names(div), ["b"]);
    juris.setValue("x", 2);
    assert.equal(div.firstChild.textContent, "2");
    assert.equal(innerRuns, 2);
    juris.setValue("mode", "outer");
    assert.deepEqual(names(div), ["#plain"]);
    juris.setValue("x", 3);
    assert.equal(innerRuns, 2, "the inner function's binding went with it");
    assert.deepEqual(names(div), ["#plain"]);
});

test("disposing a seat lets go of the function its function gave", () => {
    const juris = client({ state: { x: 1 } });
    let innerRuns = 0;
    const div = juris.render(host(), { div: { children: [() => () => { innerRuns += 1; return String(juris.getState("x")); }] } });
    assert.equal(div.textContent, "1");
    juris.disposeTree(div);
    juris.setValue("x", 2);
    assert.equal(innerRuns, 1);
    assert.equal(div.textContent, "1");
});

test("a seat still waiting on its promise holds an empty text node until the value arrives", async () => {
    const juris = client();
    const value = deferred();
    const div = juris.render(host(), { div: { children: ["before", () => value.promise, "after"] } });
    assert.deepEqual(names(div), ["#before", "#", "#after"]);
    value.resolve({ em: "loaded" });
    await settle();
    assert.deepEqual(names(div), ["#before", "em", "#after"]);
    assert.equal(div.childNodes[1].textContent, "loaded");
});

test("a seat that turns from an element to a component hands the element to the component, which keeps it", () => {
    const juris = client({ state: { card: false } });
    juris.registerComponent("Card", () => ({ div: { className: "card", textContent: "card" } }));
    const outer = juris.render(host(), { section: { children: [() => (juris.getState("card") ? { Card: {} } : { div: { id: "plain", textContent: "plain" } })] } });
    const div = outer.firstChild;
    juris.setValue("card", true);
    assert.equal(outer.firstChild, div, "the component took the element over");
    assert.equal(div.getAttribute("class"), "card");
    assert.equal(div.hasAttribute("id"), false, "what the old layout gave and the new one leaves out is gone");
    assert.equal(div.textContent, "card");
});

test("a seat inside <svg> draws its elements in SVG on every draw", () => {
    const juris = client({ state: { shape: "circle" } });
    const svg = juris.render(host(), { svg: { children: [() => ({ [juris.getState("shape")]: {} })] } });
    assert.equal(svg.firstChild.namespaceURI, SVG);
    juris.setValue("shape", "rect");
    assert.equal(svg.firstChild.localName, "rect");
    assert.equal(svg.firstChild.namespaceURI, SVG);
});

// ---- data-pending --------------------------------------------------------------------------------

test("an element whose binding waits on a slow promise carries data-pending until it settles", async () => {
    const juris = client({ pendingDelay: 0 });
    const value = deferred();
    const p = juris.render(host(), { p: { textContent: () => value.promise } });
    assert.equal(p.hasAttribute("data-pending"), false, "looked up once the tree is settled");
    await settle();
    assert.equal(p.getAttribute("data-pending"), "");
    value.resolve("done");
    await settle();
    assert.equal(p.hasAttribute("data-pending"), false);
    assert.equal(p.textContent, "done");
});

test("data-pending stays while any of an element's bindings is still waiting", async () => {
    const juris = client({ pendingDelay: 0 });
    const title = deferred();
    const text = deferred();
    const p = juris.render(host(), { p: { title: () => title.promise, textContent: () => text.promise } });
    await settle();
    assert.equal(p.hasAttribute("data-pending"), true);
    title.resolve("t");
    await settle();
    assert.equal(p.hasAttribute("data-pending"), true, "one is still waiting");
    assert.equal(p.getAttribute("title"), "t");
    text.reject(new Error("no"));
    await settle();
    assert.equal(p.hasAttribute("data-pending"), false, "a rejection settles it too");
});

test("a seat waiting on a slow promise marks the element it sits in", async () => {
    const juris = client({ pendingDelay: 0 });
    const value = deferred();
    const div = juris.render(host(), { div: { children: [() => value.promise] } });
    await settle();
    assert.equal(div.hasAttribute("data-pending"), true);
    value.resolve("x");
    await settle();
    assert.equal(div.hasAttribute("data-pending"), false);
    assert.equal(div.textContent, "x");
});

test("a children function waiting on a slow promise marks its element", async () => {
    const juris = client({ pendingDelay: 0 });
    const value = deferred();
    const ul = juris.render(host(), { ul: { children: () => value.promise } });
    await settle();
    assert.equal(ul.hasAttribute("data-pending"), true);
    value.resolve([{ li: "a" }, { li: "b" }]);
    await settle();
    assert.equal(ul.hasAttribute("data-pending"), false);
    assert.deepEqual(names(ul), ["li", "li"]);
});

test("a binding that gives a value before its slow promise was looked up leaves no data-pending, and the promise is dropped", async () => {
    const juris = client({ pendingDelay: 0, state: { ready: false } });
    const value = deferred();
    const p = juris.render(host(), { p: { textContent: () => (juris.getState("ready") ? "now" : value.promise) } });
    juris.setValue("ready", true);
    await settle();
    assert.equal(p.hasAttribute("data-pending"), false);
    value.resolve("late");
    await settle();
    assert.equal(p.textContent, "now", "the superseded run's value is not applied");
});

test("a node built outside any tree, waiting on a slow promise, marks nothing and still takes its value", async () => {
    const juris = client({ pendingDelay: 0 });
    const value = deferred();
    const node = juris.renderer.createElement(() => value.promise);
    assert.equal(node.nodeType, TEXT);
    assert.equal(node.parentNode, null);
    await settle();
    value.resolve("arrived");
    await settle();
    assert.equal(node.nodeValue, "arrived");
});

test("a seat in a <template>'s content, waiting on a slow promise, marks nothing: a fragment has none", async () => {
    const juris = client({ pendingDelay: 0 });
    const value = deferred();
    const template = juris.render(host(), { template: { children: [() => value.promise] } });
    await settle();
    assert.equal(juris.getState("$async.slow"), 1);
    assert.equal(template.hasAttribute("data-pending"), false);
    value.resolve("arrived");
    await settle();
    assert.equal(template.content.textContent, "arrived");
});

test("a seat drawn straight into a shadow root, waiting on a slow promise, marks the root's host", async () => {
    const juris = client({ pendingDelay: 0 });
    const value = deferred();
    const element = host();
    const shadowRoot = new FakeFragment();
    shadowRoot.host = element;
    juris.render(shadowRoot, () => value.promise);
    await settle();
    assert.equal(element.hasAttribute("data-pending"), true);
    value.resolve("arrived");
    await settle();
    assert.equal(element.hasAttribute("data-pending"), false);
    assert.equal(shadowRoot.textContent, "arrived");
});

// ---- unkeyed reconcile ---------------------------------------------------------------------------

test("an unkeyed list of the same length and shapes is patched in place", () => {
    const juris = client({ state: { items: ["a", "b"] } });
    const ul = juris.render(host(), { ul: { children: () => juris.getState("items").map((text) => ({ li: { textContent: text } })) } });
    const [first, second] = ul.childNodes;
    juris.setValue("items", ["c", "d"]);
    assert.equal(ul.childNodes[0], first);
    assert.equal(ul.childNodes[1], second);
    assert.deepEqual(ul.childNodes.map((n) => n.textContent), ["c", "d"]);
});

test("an unkeyed list patches its text nodes in place, and leaves alone one whose text is the same", () => {
    const juris = client({ state: { items: ["a", "b"] } });
    const p = juris.render(host(), { p: { children: () => juris.getState("items") } });
    const [a, b] = p.childNodes;
    juris.setValue("items", ["a", "B"]);
    assert.deepEqual(p.childNodes, [a, b]);
    assert.deepEqual(names(p), ["#a", "#B"]);
});

test("an unkeyed list whose length changes is drawn anew, and what was there stops running", () => {
    const juris = client({ state: { items: ["a"], t: "x" } });
    const ul = juris.render(host(), { ul: { children: () => juris.getState("items").map((text) => ({ li: { title: () => juris.getState("t"), textContent: text } })) } });
    const old = ul.firstChild;
    juris.setValue("items", ["a", "b"]);
    assert.notEqual(ul.firstChild, old);
    assert.equal(old.parentNode, null);
    juris.setValue("t", "y");
    assert.equal(old.getAttribute("title"), "x", "the replaced element's binding was disposed");
    assert.deepEqual(ul.childNodes.map((n) => n.getAttribute("title")), ["y", "y"]);
});

test("an unkeyed list that would change a node's kind or tag draws anew", () => {
    const juris = client({ state: { items: ["text"] } });
    const div = juris.render(host(), { div: { children: () => juris.getState("items") } });
    juris.setValue("items", [{ b: "bold" }]);
    assert.deepEqual(names(div), ["b"]);
    juris.setValue("items", ["text again"]);
    assert.deepEqual(names(div), ["#text again"]);
    juris.setValue("items", [{ i: "1" }]);
    const i = div.firstChild;
    juris.setValue("items", [{ b: "2" }]);
    assert.deepEqual(names(div), ["b"]);
    assert.equal(i.parentNode, null);
});

test("an unkeyed list rebinds a seat in place to its new function", () => {
    const juris = client({ state: { round: 1, x: "a" } });
    const runs = { 1: 0, 2: 0 };
    const div = juris.render(host(), {
        div: {
            children: () => {
                const round = juris.getState("round");
                return [() => { runs[round] += 1; return `${round}:${juris.getState("x")}`; }];
            },
        },
    });
    const node = div.firstChild;
    juris.setValue("round", 2);
    assert.equal(div.firstChild, node, "the seat's node is kept");
    assert.equal(node.nodeValue, "2:a");
    juris.setValue("x", "b");
    assert.equal(node.nodeValue, "2:b");
    assert.deepEqual(runs, { 1: 1, 2: 2 }, "the old function no longer runs");
});

test("an unkeyed list does not take a node that is not a seat for a seat", () => {
    const juris = client({ state: { seat: false } });
    const div = juris.render(host(), { div: { children: () => [juris.getState("seat") ? () => "from seat" : "plain"] } });
    juris.setValue("seat", true);
    assert.deepEqual(names(div), ["#from seat"]);
});

test("an unkeyed list leaves an unchanged component alone, and re-invokes one whose props changed with its local state", () => {
    const juris = client({ state: { label: "one", tick: 0 } });
    let invoked = 0;
    juris.registerComponent("Counter", (props, api) => {
        invoked += 1;
        const [count, setCount] = api.useState("count", 0);
        return { button: { onclick: () => setCount((n) => n + 1), textContent: () => `${props.label} ${count()}` } };
    });
    const div = juris.render(host(), { div: { children: () => { juris.getState("tick"); return [{ Counter: { label: juris.getState("label") } }]; } } });
    const button = div.firstChild;
    button.fire("click");
    assert.equal(button.textContent, "one 1");
    juris.setValue("tick", 1);
    assert.equal(invoked, 1, "same props: not re-invoked");
    juris.setValue("label", "two");
    assert.equal(invoked, 2);
    assert.equal(div.firstChild, button, "the component's root element is kept");
    assert.equal(button.textContent, "two 1", "its local state carried over");
});

test("an unkeyed list does not patch a component's layout onto an element no instance of it drew", () => {
    const juris = client({ state: { comp: false } });
    juris.registerComponent("Box", () => ({ div: "box" }));
    const outer = juris.render(host(), { section: { children: () => [juris.getState("comp") ? { Box: {} } : { div: "plain" }] } });
    const plain = outer.firstChild;
    juris.setValue("comp", true);
    assert.notEqual(outer.firstChild, plain, "drawn anew");
    assert.equal(outer.firstChild.textContent, "box");
});

test("a component re-invoked in place under another key starts with fresh local state", () => {
    const juris = client({ state: { key: "a" } });
    juris.registerComponent("Counter", (props, api) => {
        const [count, setCount] = api.useState("count", 0);
        return { button: { onclick: () => setCount((n) => n + 1), textContent: () => String(count()) } };
    });
    // a text sibling with no key keeps the list unkeyed, so the component is patched in place
    const div = juris.render(host(), { div: { children: () => [{ Counter: { key: juris.getState("key") } }, "sibling"] } });
    div.firstChild.fire("click");
    assert.equal(div.firstChild.textContent, "1");
    juris.setValue("key", "b");
    assert.equal(div.firstChild.textContent, "0");
});

test("duplicate keys make an unkeyed list", () => {
    const juris = client({ state: { items: ["x", "y"] } });
    const ul = juris.render(host(), { ul: { children: () => juris.getState("items").map((t) => ({ li: { key: "same", textContent: t } })) } });
    const [first] = ul.childNodes;
    juris.setValue("items", ["y", "x"]);
    assert.equal(ul.firstChild, first, "patched by position, not moved by key");
    assert.equal(first.textContent, "y");
});

test("children that turn null or undefined empty the element, and a single layout is a list of one", () => {
    const juris = client({ state: { v: [{ p: "a" }] } });
    const div = juris.render(host(), { div: { children: () => juris.getState("v") } });
    juris.setValue("v", null);
    assert.equal(div.childNodes.length, 0);
    juris.setValue("v", { p: "one" });
    assert.deepEqual(names(div), ["p"]);
    juris.setValue("v", undefined);
    assert.equal(div.childNodes.length, 0);
});

test("a children function is given its element", () => {
    const juris = client({ state: { n: 0 } });
    const given = [];
    const div = juris.render(host(), { div: { children: (element) => { given.push(element); return [String(juris.getState("n"))]; } } });
    juris.setValue("n", 1);
    assert.deepEqual(given, [div, div]);
});

// ---- keyed reconcile ---------------------------------------------------------------------------

const keyedList = (juris, extra = {}) =>
    juris.render(host(), { ul: { children: () => juris.getState("items").map((key) => ({ li: { key, textContent: key, ...extra } })) } });

test("a keyed list moves its elements instead of redrawing them, moving as few as it can", () => {
    const juris = client({ state: { items: ["a", "b", "c", "d"] } });
    const ul = keyedList(juris);
    const byKey = Object.fromEntries(ul.childNodes.map((n) => [n.textContent, n]));
    let moves = 0;
    const insertBefore = ul.insertBefore.bind(ul);
    ul.insertBefore = (node, ref) => { moves += 1; return insertBefore(node, ref); };
    juris.setValue("items", ["d", "a", "b", "c"]);
    assert.deepEqual(ul.childNodes.map((n) => n.textContent), ["d", "a", "b", "c"]);
    assert.deepEqual(ul.childNodes, ["d", "a", "b", "c"].map((k) => byKey[k]), "the same elements");
    assert.equal(moves, 1, "only d moved");
    juris.setValue("items", ["c", "b", "a", "d"]);
    assert.deepEqual(ul.childNodes, ["c", "b", "a", "d"].map((k) => byKey[k]));
});

test("a keyed list removes the elements whose key went, stopping their bindings, and draws new keys", () => {
    const juris = client({ state: { items: ["a", "b"], t: "1" } });
    const ul = keyedList(juris, { title: () => juris.getState("t") });
    const [a, b] = ul.childNodes;
    juris.setValue("items", ["b", "c"]);
    assert.deepEqual(ul.childNodes.map((n) => n.textContent), ["b", "c"]);
    assert.equal(ul.firstChild, b);
    assert.equal(a.parentNode, null);
    juris.setValue("t", "2");
    assert.equal(a.getAttribute("title"), "1", "the removed element's binding was disposed");
    assert.deepEqual(ul.childNodes.map((n) => n.getAttribute("title")), ["2", "2"]);
});

test("a keyed item whose tag changed is drawn anew, as a fresh draw would draw it", () => {
    const juris = client({ state: { tag: "i" } });
    const div = juris.render(host(), { div: { children: () => [{ [juris.getState("tag")]: { key: "k", textContent: "x" } }, { span: { key: "s" } }] } });
    const i = div.firstChild;
    juris.setValue("tag", "b");
    assert.deepEqual(names(div), ["b", "span"]);
    assert.equal(i.parentNode, null);
});

test("a keyed list drops the stray unkeyed nodes an unkeyed pass left", () => {
    const juris = client({ state: { keyed: false } });
    const div = juris.render(host(), { div: { children: () => (juris.getState("keyed") ? [{ p: { key: "a", textContent: "keyed" } }] : ["loose text", { p: "unkeyed" }]) } });
    assert.deepEqual(names(div), ["#loose text", "p"]);
    juris.setValue("keyed", true);
    assert.deepEqual(names(div), ["p"]);
    assert.equal(div.firstChild.textContent, "keyed");
});

test("a keyed component whose root is not an element keeps its place and its state as the list moves", () => {
    const juris = client({ state: { items: ["e", "r"], tick: 0 } });
    let created = 0;
    juris.registerComponent("Empty", (props, api) => {
        created += 1;
        api.useState("seen", 0);
        return null;
    });
    juris.registerComponent("Row", (props) => ({ li: { textContent: props.id } }));
    const ul = juris.render(host(), {
        ul: { children: () => { juris.getState("tick"); return juris.getState("items").map((id) => (id === "e" ? { Empty: { key: id } } : { Row: { key: id, id } })); } },
    });
    const text = ul.firstChild;
    assert.equal(text.nodeType, TEXT);
    juris.setValue("tick", 1);
    juris.setValue("items", ["r", "e"]);
    assert.equal(created, 1, "kept, not drawn anew");
    assert.equal(ul.childNodes[1], text);
    assert.equal(ul.childNodes[0].localName, "li");
});

test("a keyed text root is not kept for an element layout of its key", () => {
    const juris = client({ state: { comp: true } });
    juris.registerComponent("Empty", () => null);
    const ul = juris.render(host(), { ul: { children: () => [juris.getState("comp") ? { Empty: { key: "k" } } : { li: { key: "k", textContent: "li" } }] } });
    const text = ul.firstChild;
    juris.setValue("comp", false);
    assert.deepEqual(names(ul), ["li"]);
    assert.equal(text.parentNode, null);
});

test("a keyed component with the same props is not invoked again; new props re-invoke it, keeping its local state", () => {
    const juris = client({ state: { items: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } });
    const invoked = [];
    juris.registerComponent("Item", (props, api) => {
        invoked.push(props.id);
        const [n, setN] = api.useState("n", 0);
        return { li: { onclick: () => setN((v) => v + 1), textContent: () => `${props.label}${n()}` } };
    });
    const ul = juris.render(host(), { ul: { children: () => juris.getState("items").map(({ id, label }) => ({ Item: { key: id, id, label } })) } });
    ul.firstChild.fire("click");
    assert.deepEqual(ul.childNodes.map((n) => n.textContent), ["A1", "B0"]);
    juris.setValue("items", [{ id: "b", label: "B" }, { id: "a", label: "A" }]);
    assert.deepEqual(invoked, ["a", "b"], "moved, not re-invoked");
    assert.deepEqual(ul.childNodes.map((n) => n.textContent), ["B0", "A1"]);
    juris.setValue("items", [{ id: "b", label: "B" }, { id: "a", label: "Z" }]);
    assert.deepEqual(invoked, ["a", "b", "a"]);
    assert.deepEqual(ul.childNodes.map((n) => n.textContent), ["B0", "Z1"], "re-invoked with its state");
});

test("a keyed component takes over the element of its key that a plain layout drew", () => {
    const juris = client({ state: { comp: false } });
    juris.registerComponent("Item", () => ({ li: { className: "item", textContent: "component" } }));
    const ul = juris.render(host(), { ul: { children: () => [juris.getState("comp") ? { Item: { key: "k" } } : { li: { key: "k", textContent: "plain" } }] } });
    const li = ul.firstChild;
    juris.setValue("comp", true);
    assert.equal(ul.firstChild, li);
    assert.equal(li.textContent, "component");
    assert.equal(li.getAttribute("class"), "item");
});

test("a keyed list inside <svg> draws new items in SVG", () => {
    const juris = client({ state: { items: ["a"] } });
    const svg = juris.render(host(), { svg: { children: () => juris.getState("items").map((key) => ({ circle: { key, id: key } })) } });
    juris.setValue("items", ["a", "b"]);
    assert.deepEqual(svg.childNodes.map((n) => n.namespaceURI), [SVG, SVG]);
});

// A list that has keys and cannot use them is matched by place: the warning says so, and which row did it.
const keyedRows = (rows) => rows.map((row) => ({ li: { key: row.id, textContent: row.text } }));

test("devMode: a key two rows share sends the list to matching by place, and says which key", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = client({ devMode: true, state: { rows: [{ id: 1, text: "a" }, { id: 2, text: "b" }, { id: 2, text: "c" }] } });
    const ul = juris.render(host(), { ul: { children: () => keyedRows(juris.getState("rows")) } });
    assert.deepEqual(ul.childNodes.map((row) => row.textContent), ["a", "b", "c"], "it still draws");
    assert.deepEqual(warn.mock.calls.map((call) => call.arguments[0]), [
        'Juris: dropped the keys of the list in <ul>: key 2 is on two rows, so every row is matched by place,'
            + " and a row's element and state stay with its place, not its item. Give every row a key of its own",
    ]);
});

test("devMode: a row with no key among keyed rows sends the list to matching by place, and says which row", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = client({ devMode: true });
    juris.render(host(), { ol: { children: () => [{ li: { key: "a" } }, { li: "no key" }, { li: { key: "c" } }] } });
    assert.deepEqual(warn.mock.calls.map((call) => call.arguments[0]).filter((line) => line.startsWith("Juris")), [
        'Juris: dropped the keys of the list in <ol>: row 2 has no key, so every row is matched by place,'
            + " and a row's element and state stay with its place, not its item. Give every row a key of its own",
    ]);
});

test("devMode: the warning goes through refused, with the key, the parent and the component", () => {
    const juris = client({ devMode: true, state: { key: "x" } });
    const kept = [];
    juris.refused = (rule, reason, detail) => kept.push({ rule, reason, ...detail });
    juris.registerComponent("Rows", () => ({
        ul: {
            children: () => {
                const key = juris.getState("key");
                return [{ li: { key } }, { li: { key } }];
            },
        },
    }));
    const ul = juris.render(host(), { Rows: {} });
    assert.equal(kept.length, 1);
    assert.equal(kept[0].rule, "keyed-list");
    assert.equal(kept[0].name, "key");
    assert.equal(kept[0].value, "x");
    assert.equal(kept[0].node, ul);
    assert.equal(kept[0].component.name, "Rows");
    assert.match(kept[0].reason, /^the keys of the list in <ul>: key "x" is on two rows/);
});

test("devMode: a key that is no text or number is named in the warning, whatever it is", () => {
    const juris = client({ devMode: true });
    const kept = [];
    juris.refused = (rule, reason) => kept.push(reason);
    juris.render(host(), { ul: { children: () => [{ li: { key: 12n } }, { li: { key: 12n } }] } });
    assert.match(kept[0], /key 12 is on two rows/);
});

test("devMode: a <template>'s rows are named by the <template>, whose content is what holds them", () => {
    const juris = client({ devMode: true });
    const kept = [];
    juris.refused = (rule, reason) => kept.push(reason);
    juris.render(host(), { template: { children: () => [{ li: { key: 1 } }, { li: "no key" }] } });
    assert.match(kept[0], /^the keys of the list in <template>: row 2 has no key/);
});

test("devMode: a list with no keys at all, or with a key on every row, says nothing", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = client({ devMode: true, state: { n: 0 } });
    juris.render(host(), {
        div: {
            children: () => {
                juris.getState("n");
                return [{ p: "a" }, "text", null];
            },
        },
    });
    const rows = () => [{ id: juris.getState("n"), text: "a" }, { id: "b", text: "b" }];
    juris.render(host(), { ul: { children: () => keyedRows(rows()) } });
    juris.render(host(), { ul: { children: () => juris.getState("none", []) } });
    assert.deepEqual(warn.mock.calls.map((call) => call.arguments[0]), []);
});

test("outside devMode a list matched by place says nothing", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = client({ state: { rows: [{ id: 1, text: "a" }, { id: 1, text: "b" }] } });
    juris.render(host(), { ul: { children: () => keyedRows(juris.getState("rows")) } });
    assert.equal(warn.mock.callCount(), 0);
});

// ---- the longest increasing subsequence --------------------------------------------------------

// The length of the longest strictly increasing subsequence of the non-zero values, by brute force.
function longestLength(values) {
    const best = values.map(() => 0);
    let longest = 0;
    values.forEach((value, i) => {
        if (value === 0) return;
        best[i] = 1;
        for (let j = 0; j < i; j += 1) if (values[j] !== 0 && values[j] < value) best[i] = Math.max(best[i], best[j] + 1);
        longest = Math.max(longest, best[i]);
    });
    return longest;
}

test("getLongestIncreasingSubsequence answers the indexes of a longest strictly increasing run of the non-zero values", () => {
    const lis = (values) => client().renderer.getLongestIncreasingSubsequence(values);
    assert.deepEqual(lis([]), []);
    assert.deepEqual(lis([0, 0]), [], "zeros (new items) are never stable");
    assert.deepEqual(lis([1, 2, 3]), [0, 1, 2]);
    assert.deepEqual(lis([3, 1, 2]), [1, 2]);
    assert.deepEqual(lis([4, 1, 2, 3]), [1, 2, 3]);
    assert.deepEqual(lis([2, 0, 3, 1]), [0, 2]);
    // a sweep of pseudo-random permutations with gaps, held to the brute force
    let seed = 7;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let round = 0; round < 200; round += 1) {
        const values = Array.from({ length: Math.floor(random() * 12) }, (_, i) => (random() < 0.2 ? 0 : i + 1)).sort(() => random() - 0.5);
        const indexes = lis(values);
        for (let k = 1; k < indexes.length; k += 1) {
            assert.ok(indexes[k - 1] < indexes[k], `indexes rise: ${values}`);
            assert.ok(values[indexes[k - 1]] < values[indexes[k]], `values rise: ${values}`);
        }
        assert.ok(indexes.every((i) => values[i] !== 0), `no zero: ${values}`);
        assert.equal(indexes.length, longestLength(values), `longest: ${values}`);
    }
});

// ---- an element reused for another layout --------------------------------------------------------

test("an element reused for another layout of its tag loses what that layout leaves out", () => {
    const juris = client({ state: { first: true } });
    const clicks = [];
    const div = juris.render(host(), {
        div: {
            children: () => [
                juris.getState("first")
                    ? { label: { class: "a", title: "t", htmlFor: "f", hidden: true, "data-x": "1", style: { color: "red" }, classList: { on: true, "x y": true }, onclick: () => clicks.push(1), onfocus: "string" } }
                    : { label: {} },
            ],
        },
    });
    const label = div.firstChild;
    assert.deepEqual(label.classList.tokens(), ["a", "on", "x", "y"]);
    juris.setValue("first", false);
    assert.equal(div.firstChild, label, "reused");
    assert.deepEqual([...label.attrs.keys()], [], "every attribute it gave is gone");
    assert.equal(label.style.length, 0);
    assert.deepEqual(label.listeners, []);
    label.fire("click");
    assert.deepEqual(clicks, []);
});

test("a form control reused for another layout keeps its value, which is the user's", () => {
    const juris = client({ state: { first: true } });
    const div = juris.render(host(), { div: { children: () => [juris.getState("first") ? { input: { value: "typed", disabled: true } } : { input: {} }] } });
    const input = div.firstChild;
    juris.setValue("first", false);
    assert.equal(div.firstChild, input);
    assert.equal(input.value, "typed");
    assert.equal(input.disabled, false, "a boolean it no longer names is cleared, property too");
    assert.equal(input.hasAttribute("disabled"), false);
});

test("a reused element keeps its class when the new layout gives it under the other name", () => {
    const juris = client({ state: { first: true } });
    const div = juris.render(host(), { div: { children: () => [juris.getState("first") ? { p: { class: "x" } } : { p: { className: "y", classList: { z: true } } }] } });
    juris.setValue("first", false);
    assert.deepEqual(div.firstChild.classList.tokens(), ["y", "z"]);
});

test("a reused element whose new layout names nothing inside it is emptied, and what was inside stops running (F27)", () => {
    const juris = client({ state: { on: true, t: "x" } });
    const seen = [];
    const div = juris.render(host(), {
        div: { children: () => [juris.getState("on") ? { span: { className: "badge", children: [{ b: { textContent: () => { seen.push(juris.getState("t")); return juris.getState("t"); } } }] } } : { span: {} }] },
    });
    const span = div.firstChild;
    juris.setValue("on", false);
    assert.equal(div.firstChild, span);
    assert.equal(span.childNodes.length, 0);
    assert.equal(span.hasAttribute("class"), false);
    juris.setValue("t", "y");
    assert.deepEqual(seen, ["x"], "the old child's binding was disposed");
    juris.setValue("on", true);
    assert.equal(span.textContent, "y", "drawn again when the layout names it again");
});

test("a reused element given textContent drops its old children and their bindings", () => {
    const juris = client({ state: { on: true, t: "x" } });
    let runs = 0;
    const div = juris.render(host(), {
        div: { children: () => [juris.getState("on") ? { p: { children: [{ b: { textContent: () => { runs += 1; return juris.getState("t"); } } }] } } : { p: { textContent: "plain" } }] },
    });
    juris.setValue("on", false);
    assert.equal(div.firstChild.textContent, "plain");
    juris.setValue("t", "y");
    assert.equal(runs, 1);
});

test("with allowInnerHTML, a reused element given innerHTML drops its old children and their bindings", () => {
    const juris = client({ allowInnerHTML: true, state: { on: true, t: "x" } });
    let runs = 0;
    const div = juris.render(host(), {
        div: { children: () => [juris.getState("on") ? { p: { children: [{ b: { textContent: () => { runs += 1; return juris.getState("t"); } } }] } } : { p: { innerHTML: "<i>markup</i>" } }] },
    });
    juris.setValue("on", false);
    assert.equal(div.firstChild.innerHTML, "<i>markup</i>");
    juris.setValue("t", "y");
    assert.equal(runs, 1);
});

test("a reused element drawn in <svg> draws what it adds inside in SVG", () => {
    const juris = client({ state: { n: 1 } });
    const div = juris.render(host(), { div: { children: () => [{ svg: { "data-n": juris.getState("n"), children: Array.from({ length: juris.getState("n") }, () => ({ circle: {} })) } }] } });
    const svg = div.firstChild;
    juris.setValue("n", 2);
    assert.equal(div.firstChild, svg);
    assert.deepEqual(svg.childNodes.map((n) => n.namespaceURI), [SVG, SVG]);
});

test("a reused element's style loses the keys the new layout's style no longer gives, as the server leaves them out", () => {
    const juris = client({ state: { first: true } });
    const div = juris.render(host(), { div: { children: () => [juris.getState("first") ? { span: { style: { color: "red", marginTop: "1px" } } } : { span: { style: { color: "blue" } } }] } });
    juris.setValue("first", false);
    const span = div.firstChild;
    assert.equal(span.style.color, "blue");
    assert.equal(span.style.marginTop, "", "the server's markup for the new layout has no margin-top");
});

test("a reused element's string style is gone when the new layout's style is an object, as the server writes the object alone", () => {
    const juris = client({ state: { first: true } });
    const div = juris.render(host(), { div: { children: () => [juris.getState("first") ? { span: { style: "color: red; margin-top: 1px" } } : { span: { style: { color: "blue" } } }] } });
    juris.setValue("first", false);
    assert.equal(div.firstChild.style.cssText, "color: blue;");
});

test("a reused element's classes are only those the new classList names, as the server writes them", () => {
    const juris = client({ state: { first: true } });
    const div = juris.render(host(), { div: { children: () => [juris.getState("first") ? { span: { classList: { a: true, b: true } } } : { span: { classList: { a: true } } }] } });
    juris.setValue("first", false);
    assert.deepEqual(div.firstChild.classList.tokens(), ["a"]);
});

test("a reused element loses the classes its last layout's classList function turned on", () => {
    const juris = client({ state: { shape: "function", on: true } });
    const layouts = {
        function: () => ({ span: { classList: () => ({ a: juris.getState("on"), b: true }) } }),
        object: () => ({ span: { classList: { a: true } } }),
        other: () => ({ span: { classList: () => ({ c: true }) } }),
    };
    const div = juris.render(host(), {
        div: { children: () => [layouts[juris.getState("shape")]()] },
    });
    const span = div.firstChild;
    assert.deepEqual(span.classList.tokens(), ["a", "b"]);
    juris.setValue("shape", "object");
    assert.equal(div.firstChild, span);
    assert.deepEqual(span.classList.tokens(), ["a"], "a function, then an object");
    juris.setValue("shape", "other");
    assert.deepEqual(span.classList.tokens(), ["c"], "an object, then a function");
    juris.setValue("shape", "function");
    assert.deepEqual(span.classList.tokens(), ["a", "b"], "a function, then another");
    juris.setValue("on", false);
    assert.deepEqual(span.classList.tokens(), ["b"], "and the new one follows its state");
});

test("a reused <template> draws, redraws and empties what is inside it in its content, never as its children", () => {
    const juris = client({ state: { on: true, rows: ["a", "b"] } });
    const div = juris.render(host(), { div: { children: () => [juris.getState("on") ? { template: { children: () => juris.getState("rows").map((row) => ({ p: row })) } } : { template: {} }] } });
    const template = div.firstChild;
    assert.deepEqual(names(template.content), ["p", "p"]);
    juris.setValue("rows", ["c"]);
    assert.deepEqual(names(template.content), ["p"]);
    juris.setValue("on", false);
    assert.equal(div.firstChild, template);
    assert.deepEqual(names(template.content), [], "a layout naming nothing inside empties its content");
    assert.equal(template.childNodes.length, 0);
    assert.equal(juris.render(host(), { template: "text" }).content.textContent, "text", "its text is its content's too");
});

test("what a <template>'s content holds is disposed with the template", () => {
    const juris = client({ state: { on: true, t: "x" } });
    let runs = 0;
    const div = juris.render(host(), { div: { children: () => [juris.getState("on") ? { template: { children: [{ p: { textContent: () => { runs += 1; return juris.getState("t"); } } }] } } : { span: {} }] } });
    assert.equal(div.firstChild.content.firstChild.textContent, "x");
    juris.setValue("on", false);
    juris.setValue("t", "y");
    assert.equal(runs, 1);
});

test("a keyed pass that throws disposes every row it made but had not placed; rows already in place stay as they were", () => {
    const juris = client({ devMode: true, state: { rows: ["a"] } });
    const log = [];
    const error = new Error("bad");
    juris.registerComponent("Row", (props, api) => {
        api.onCleanup(() => log.push(props.k));
        if (props.k === "bad") throw error;
        return { li: props.k };
    });
    const ul = juris.render(host(), { ul: { children: () => juris.getState("rows").map((k) => ({ Row: { key: k, k } })) } });
    const a = ul.firstChild;
    assert.throws(() => juris.setValue("rows", ["a", "b", "c", "bad"]), (thrown) => thrown === error);
    assert.deepEqual(log, ["bad", "b", "c"]);
    assert.deepEqual(juris.componentTree().map((node) => node.props.k), ["a"]);
    assert.deepEqual(names(ul), ["li"]);
    assert.equal(ul.firstChild, a);
});

test("a seat whose re-draw throws stays on its node, so the parent's removal of the node disposes it", () => {
    const juris = client({ state: { v: 1, show: true } });
    const error = new Error("bad");
    juris.registerComponent("Broken", () => { throw error; });
    let runs = 0;
    juris.render(host(), { div: { children: () => (juris.getState("show") ? [() => { runs += 1; return juris.getState("v") === 1 ? { p: "one" } : { p: { children: [{ Broken: {} }] } }; }] : []) } });
    assert.throws(() => juris.setValue("v", 2), (thrown) => thrown === error);
    juris.setValue("show", false);
    const before = runs;
    juris.setValue("v", 3);
    assert.equal(runs, before, "the seat's binding went with its node");
});

// ---- a draw that throws leaves its node consistent; disposal runs every cleanup ---------------------

test("a seat whose re-draw throws after its seated component went leaves nothing of it on the node", () => {
    const juris = client({ state: { v: 1 } });
    const error = new Error("bad");
    juris.registerComponent("Broken", () => { throw error; });
    juris.registerComponent("Inner", () => ({ p: { class: "inner", textContent: "inner" } }));
    const div = juris.render(host(), { div: { children: [() => (juris.getState("v") === 1 ? { Inner: {} } : { span: { children: [{ Broken: {} }] } })] } });
    const p = div.firstChild;
    assert.throws(() => juris.setValue("v", 2), (thrown) => thrown === error);
    assert.equal(div.firstChild, p);
    assert.deepEqual([p.childNodes.length, p.hasAttribute("class")], [0, false]);
});

test("a seat replaced by one whose first draw throws: what the old one drew is taken off, and no seat is left on the node", () => {
    const juris = client({ state: { n: 0 } });
    const error = new Error("bad");
    let fail = false;
    const div = juris.render(host(), { div: { children: () => { juris.getState("n"); return [() => (fail ? { p: { title: () => { throw error; }, children: ["new"] } } : { p: { class: "old", textContent: "old" } })]; } } });
    const p = div.firstChild;
    fail = true;
    assert.throws(() => juris.setValue("n", 1), (thrown) => thrown === error);
    assert.deepEqual([div.firstChild, p.childNodes.length, p.hasAttribute("class")], [p, 0, false]);
    assert.equal(juris.renderer.slots.has(p), false);
});

test("a child patched in place whose re-draw throws after the component that drew it went leaves nothing of it", () => {
    const juris = client({ state: { v: 1 } });
    const error = new Error("bad");
    juris.registerComponent("Inner", () => ({ p: { class: "inner", textContent: "inner" } }));
    const div = juris.render(host(), { div: { children: () => [juris.getState("v") === 1 ? { Inner: {} } : { p: { title: () => { throw error; }, children: ["new"] } }] } });
    const p = div.firstChild;
    assert.throws(() => juris.setValue("v", 2), (thrown) => thrown === error);
    assert.deepEqual([div.firstChild, p.childNodes.length], [p, 0]);
});

test("a keyed row kept whose re-draw throws after the component that drew it went leaves nothing of it", () => {
    const juris = client({ state: { v: 1 } });
    const error = new Error("bad");
    juris.registerComponent("Row", () => ({ li: { class: "row", textContent: "a" } }));
    const ul = juris.render(host(), { ul: { children: () => [juris.getState("v") === 1 ? { Row: { key: "a" } } : { li: { key: "a", title: () => { throw error; }, children: ["new"] } }] } });
    const li = ul.firstChild;
    assert.throws(() => juris.setValue("v", 2), (thrown) => thrown === error);
    assert.deepEqual([ul.firstChild, li.childNodes.length], [li, 0]);
});

test("an element given text in a re-draw that throws first loses the children it disposed for that text", () => {
    const juris = client({ state: { v: 1 } });
    const log = [];
    const error = new Error("bad");
    juris.registerComponent("Inner", (props, api) => { api.onCleanup(() => log.push("inner")); return { span: "inner" }; });
    const div = juris.render(host(), { div: { children: () => [juris.getState("v") === 1 ? { section: { children: [{ Inner: {} }] } } : { section: { title: () => { throw error; }, textContent: "new" } }] } });
    const section = div.firstChild;
    assert.throws(() => juris.setValue("v", 2), (thrown) => thrown === error);
    assert.deepEqual(log, ["inner"]);
    assert.equal(section.childNodes.length, 0, "the component that went is not shown");
});

test("children replaced wholesale all go, whichever one's cleanup throws, and the first error is thrown once they are off", () => {
    const juris = client({ state: { show: true } });
    const log = [];
    const first = new Error("first");
    juris.registerComponent("Bad", (props, api) => { api.onCleanup(() => { log.push("bad"); throw first; }); return { b: "bad" }; });
    juris.registerComponent("Good", (props, api) => { api.onCleanup(() => log.push("good")); return { i: "good" }; });
    const div = juris.render(host(), { div: { children: () => (juris.getState("show") ? [{ Bad: {} }, { Good: {} }] : []) } });
    assert.throws(() => juris.setValue("show", false), (thrown) => thrown === first);
    assert.deepEqual(log, ["bad", "good"]);
    assert.equal(div.childNodes.length, 0);
});

test("keyed rows that go, and stray unkeyed nodes, all go whichever one's cleanup throws, and the first error is thrown once they are off", () => {
    const first = new Error("first");
    const make = (layouts) => {
        const juris = client({ state: { pass: 0 } });
        const log = [];
        juris.registerComponent("Said", (props, api) => { api.onCleanup(() => { log.push(props.k); if (props.k === "x") throw first; }); return props.text ?? { li: props.k }; });
        const ul = juris.render(host(), { ul: { children: () => layouts[juris.getState("pass")] } });
        return { juris, log, ul };
    };
    const strays = make([[{ Said: { k: "x", text: "one" } }, { Said: { k: "y", text: "two" } }], []]);
    assert.throws(() => strays.juris.setValue("pass", 1), (thrown) => thrown === first);
    assert.deepEqual(strays.log, ["x", "y"], "the stray text nodes an unkeyed pass left");
    assert.deepEqual(names(strays.ul), []);
    const rows = make([[{ Said: { key: "x", k: "x" } }, { Said: { key: "y", k: "y" } }], []]);
    assert.throws(() => rows.juris.setValue("pass", 1), (thrown) => thrown === first);
    assert.deepEqual(rows.log, ["x", "y"], "the keyed rows that go");
    assert.deepEqual(names(rows.ul), []);
});

test("a seat whose chained function is disposed goes whole, whatever disposing the lower level throws, and throws that error after", () => {
    const juris = client({ state: { n: 0 } });
    const error = new Error("watcher");
    let armed = false;
    let outerRuns = 0;
    juris.render(host(), { p: { textContent: () => { const pending = juris.getState("$async.pending", 0); if (armed && pending === 0) throw error; return String(pending); } } });
    const div = juris.render(host(), { div: { children: [() => { outerRuns += 1; juris.getState("n"); return () => new Promise(() => { }); }] } });
    armed = true;
    assert.throws(() => juris.disposeTree(div.firstChild), (thrown) => thrown === error, "disposing the pending lower level wakes a watcher that throws");
    const runs = outerRuns;
    juris.setValue("n", 1);
    assert.equal(outerRuns, runs, "the outer level went too");
});
