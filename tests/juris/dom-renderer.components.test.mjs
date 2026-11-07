// The DOM renderer (dom-renderer.js), components: drawing one, its root function (and the chain a
// function value binds), onMount and cleanups, devMode's tree and getter-prop warnings, the props a
// retained component is compared by (refs by path), instances that share a root, a component seated
// in a seat that swaps its own root, and error boundaries (setup, a binding's first run, and later).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";

import { installDom, Element, FakeNode, HTML, SVG, settle, deferred } from "../support/dom-renderer-dom.mjs";

let dom;
beforeEach(() => { dom = installDom(); });
afterEach(() => dom.restore());

const client = (options = {}) => new Juris({ isServer: false, ...options });
const host = () => dom.document.body.appendChild(new Element("div", HTML));
const TEXT = FakeNode.TEXT_NODE;
const names = (parent) => parent.childNodes.map((n) => (n.nodeType === TEXT ? `#${n.nodeValue}` : n.localName));

// ---- drawing a component -------------------------------------------------------------------------

test("a component draws the layout its definition returns, given its props and the api", () => {
    const juris = client();
    let given = null;
    juris.registerComponent("Greeting", (props, api) => {
        given = { props, api };
        return { p: { className: "greeting", textContent: `Hello, ${props.name}` } };
    });
    const p = juris.render(host(), { Greeting: { name: "Ada" } });
    assert.equal(p.localName, "p");
    assert.equal(p.textContent, "Hello, Ada");
    assert.deepEqual(given.props, { name: "Ada" });
    assert.equal(given.api, juris.api);
});

test("a component's string content is its textContent prop, and null no props", () => {
    const juris = client();
    const seen = [];
    juris.registerComponent("Echo", (props) => { seen.push(props); return { span: {} }; });
    juris.render(host(), { div: { children: [{ Echo: "words" }, { Echo: null }] } });
    assert.deepEqual(seen, [{ textContent: "words" }, {}]);
});

test("a component inside <svg> draws its root in SVG", () => {
    const juris = client();
    juris.registerComponent("Dot", () => ({ circle: { r: 1 } }));
    const svg = juris.render(host(), { svg: { children: [{ Dot: {} }] } });
    assert.equal(svg.firstChild.namespaceURI, SVG);
    assert.equal(svg.firstChild.getAttribute("r"), "1");
});

test("a component that returns a list throws, naming the rule", () => {
    const juris = client();
    juris.registerComponent("Many", () => [{ li: "a" }, { li: "b" }]);
    assert.throws(() => juris.render(host(), { Many: {} }), { message: /a component cannot return an array/ });
});

// A list where one layout goes is refused in words naming what gave it: a component (above), a function
// in one child's place (a seat, or a function a root function returns), or nothing in particular (a list
// inside a list of children, a list given to render). The server's words are the same (ssr-renderer).
const SEAT_LIST = "Juris: a layout is one { tag: content } object; a function in one child's place returned a list"
    + ": make the function the children itself (children: () => [...]), or wrap the items in an element";
const LIST_GIVEN = "Juris: a layout is one { tag: content } object, and a list was given where one goes"
    + ": wrap the items in an element";

test("a function in one child's place that returns a list throws, naming the function, never a component", () => {
    const juris = client({ state: { many: false } });
    const milk = { li: "Milk" };
    const eggs = { li: "Eggs" };
    assert.throws(() => juris.render(host(), { ul: { children: [() => [milk, eggs]] } }), { message: SEAT_LIST });
    juris.render(host(), {
        ul: {
            children: [() => (juris.getState("many") ? [milk, eggs] : milk)],
        },
    });
    assert.throws(() => juris.setValue("many", true), { message: SEAT_LIST }, "a later run too");
    juris.registerComponent("Chained", () => () => () => [milk, eggs]);
    assert.throws(() => juris.render(host(), { Chained: {} }), { message: SEAT_LIST }, "one a root function returns");
    juris.registerComponent("Rooted", () => () => [milk, eggs]);
    assert.throws(() => juris.render(host(), { Rooted: {} }), { message: /a component cannot return an array/ });
});

test("a list inside a list of children, or given to render, throws in words naming no component", () => {
    const juris = client();
    assert.throws(() => juris.render(host(), { ul: { children: [[{ li: "Milk" }]] } }), { message: LIST_GIVEN });
    assert.throws(() => juris.render(host(), [{ p: "Milk" }]), { message: LIST_GIVEN });
});

test("a root function is drawn again when what it read changes, given the node there (null before the first draw)", () => {
    const juris = client({ state: { tag: "div" } });
    const given = [];
    juris.registerComponent("Shape", () => (root) => {
        given.push(root);
        return { [juris.getState("tag")]: "shape" };
    });
    const target = host();
    const first = juris.render(target, { Shape: {} });
    assert.equal(first.localName, "div");
    juris.setValue("tag", "span");
    assert.deepEqual(names(target), ["span"]);
    assert.deepEqual(given, [null, first]);
});

test("a root function whose value is a function binds it one level down, and lets it go when the first gives something else", () => {
    const juris = client({ state: { deep: true, x: 1 } });
    let innerRuns = 0;
    juris.registerComponent("Chain", () => () => (juris.getState("deep") ? () => { innerRuns += 1; return { b: String(juris.getState("x")) }; } : { i: "shallow" }));
    const target = host();
    juris.render(target, { Chain: {} });
    juris.setValue("x", 2);
    assert.equal(target.firstChild.textContent, "2");
    juris.setValue("deep", false);
    assert.deepEqual(names(target), ["i"]);
    juris.setValue("x", 3);
    assert.equal(innerRuns, 2);
    assert.deepEqual(names(target), ["i"]);
});

test("a root function still waiting on its first value draws an empty text node, then its layout", async () => {
    const juris = client();
    const value = deferred();
    juris.registerComponent("Lazy", () => () => value.promise);
    const target = host();
    const node = juris.render(target, { Lazy: {} });
    assert.equal(node.nodeType, TEXT);
    assert.equal(node.nodeValue, "");
    value.resolve({ p: "loaded" });
    await settle();
    assert.deepEqual(names(target), ["p"]);
    assert.equal(target.firstChild.textContent, "loaded");
});

test("a root function waiting on a slow promise marks the element its root sits in", async () => {
    const juris = client({ pendingDelay: 0 });
    const value = deferred();
    juris.registerComponent("Lazy", () => () => value.promise);
    const target = host();
    juris.render(target, { Lazy: {} });
    await settle();
    assert.equal(target.hasAttribute("data-pending"), true);
    value.resolve({ p: "loaded" });
    await settle();
    assert.equal(target.hasAttribute("data-pending"), false);
    assert.deepEqual(names(target), ["p"]);
});

// A definition answers its layout at once: what an `async` one resolves to never reaches the draw. It
// used to reach the tag check as a layout, and be reported as a tag named "undefined".
const ASYNC_DEFINITION = 'Juris: dropped component "Lazy": its definition returned a promise (it is async),'
    + " so nothing is drawn. A definition returns its layout at once;"
    + " to wait for one, keep the definition plain and return a function that returns the promise";

test("an async definition draws nothing, and devMode says that is what happened, never a tag", async (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = client({ devMode: true });
    juris.registerComponent("Lazy", async () => ({ p: "loaded" }));
    const target = host();
    const node = juris.render(target, { Lazy: {} });
    await settle();
    assert.equal(node.nodeType, TEXT);
    assert.equal(node.nodeValue, "");
    assert.deepEqual(names(target), ["#"], "and it stays nothing: what it resolved to is not drawn");
    assert.deepEqual(warn.mock.calls.map((call) => call.arguments[0]), [ASYNC_DEFINITION]);
});

test("an async definition goes through refused, naming the component", () => {
    const juris = client({ devMode: true });
    const kept = [];
    juris.refused = (rule, reason, detail) => kept.push({ rule, ...detail });
    juris.registerComponent("Lazy", async () => ({ p: "loaded" }));
    juris.render(host(), { Lazy: {} });
    assert.equal(kept.length, 1);
    assert.equal(kept[0].rule, "async-definition");
    assert.equal(kept[0].name, "Lazy");
    assert.equal(kept[0].component.name, "Lazy");
    assert.equal(typeof kept[0].value.then, "function");
});

test("a keyed async definition draws nothing too, and no element named undefined", async (t) => {
    t.mock.method(console, "warn", () => { });
    const juris = client();
    juris.registerComponent("Lazy", async () => ({ p: "loaded" }));
    const ul = juris.render(host(), { ul: { children: () => [{ Lazy: { key: 1 } }] } });
    await settle();
    assert.equal(ul.childNodes.length, 1);
    assert.equal(ul.childNodes[0].nodeType, TEXT);
});

test("outside devMode an async definition draws nothing and says nothing", async (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = client();
    juris.registerComponent("Lazy", async () => ({ p: "loaded" }));
    const node = juris.render(host(), { Lazy: {} });
    await settle();
    assert.equal(node.nodeType, TEXT);
    assert.equal(warn.mock.callCount(), 0);
});

test("the way to wait is a plain definition returning a function: it draws what the promise gives", async (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = client({ devMode: true, state: { id: 1 } });
    juris.registerComponent("Lazy", () => () => Promise.resolve({ p: `loaded ${juris.getState("id")}` }));
    const target = host();
    juris.render(target, { Lazy: {} });
    await settle();
    assert.deepEqual(names(target), ["p"]);
    assert.equal(warn.mock.callCount(), 0);
});

// ---- onMount and cleanups ------------------------------------------------------------------------

test("onMount runs once the outermost draw has finished, given the root in its parent; a function it returns is a cleanup", () => {
    const juris = client();
    const log = [];
    juris.registerComponent("M", (props, api) => {
        api.onMount((root) => {
            log.push(["mount", root.localName, root.isConnected]);
            return () => log.push("unmount");
        });
        api.onMount(() => { log.push("second"); });
        api.onCleanup(() => log.push("cleanup"));
        return { div: "m" };
    });
    const target = host();
    const section = juris.render(target, { section: { children: [{ M: {} }] } });
    assert.deepEqual(log, [["mount", "div", true], "second"]);
    juris.disposeTree(section);
    assert.deepEqual(log, [["mount", "div", true], "second", "cleanup", "unmount"]);
});

test("onMount does not run for a component disposed before the draw that made it finished", () => {
    const juris = client({ state: { show: true } });
    const log = [];
    juris.registerComponent("A", (props, api) => {
        api.onMount(() => log.push("A mounted"));
        api.onCleanup(() => log.push("A cleaned"));
        return { i: "a" };
    });
    juris.registerComponent("B", (props, api) => {
        api.setValue("show", false); // takes A's seat down while the draw is still going
        return { b: "b" };
    });
    const div = juris.render(host(), { div: { children: [() => (juris.getState("show") ? { A: {} } : null), { B: {} }] } });
    assert.deepEqual(log, ["A cleaned"]);
    assert.deepEqual(names(div), ["#", "b"]);
});

test("a component drawn by an onMount handler has its own onMount run in the same pass", () => {
    const juris = client({ state: { late: false } });
    const log = [];
    juris.registerComponent("Late", (props, api) => {
        api.onMount(() => log.push("late"));
        return { i: "late" };
    });
    juris.registerComponent("Trigger", (props, api) => {
        api.onMount(() => {
            log.push("trigger");
            juris.setValue("late", true);
        });
        return { div: { children: [() => (juris.getState("late") ? { Late: {} } : null)] } };
    });
    const div = juris.render(host(), { Trigger: {} });
    assert.deepEqual(log, ["trigger", "late"]);
    assert.deepEqual(names(div), ["i"]);
});

test("a component's cleanups run when its node is disposed, and its bindings stop", () => {
    const juris = client({ state: { t: "a" } });
    const log = [];
    juris.registerComponent("C", (props, api) => {
        api.onCleanup(() => log.push("cleaned"));
        return () => ({ p: juris.getState("t") });
    });
    const p = juris.render(host(), { C: {} });
    juris.disposeTree(p);
    juris.setValue("t", "b");
    assert.deepEqual(log, ["cleaned"]);
    assert.equal(p.textContent, "a");
});

// ---- devMode -------------------------------------------------------------------------------------

test("devMode: onTreeChange hears each draw that created or disposed a component", (t) => {
    t.mock.method(console, "warn", () => { });
    const juris = client({ devMode: true, state: { show: true } });
    juris.registerComponent("Leaf", () => ({ i: "leaf" }));
    const trees = [];
    juris.onTreeChange((tree) => trees.push(tree.map((node) => node.name)));
    juris.render(host(), { div: { children: [() => (juris.getState("show") ? { Leaf: {} } : null)] } });
    assert.deepEqual(trees, [["Leaf"]]);
    juris.setValue("show", false);
    assert.deepEqual(trees, [["Leaf"], []]);
});

test("devMode: a getter prop the component never calls is named on the console, a callback is not", async (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = client({ devMode: true });
    juris.registerComponent("Label", () => ({ span: "static" }));
    juris.render(host(), { Label: { text: () => "x", onPick: () => { } } });
    await settle();
    const lines = warn.mock.calls.map((call) => String(call.arguments[0]));
    assert.ok(lines.includes('Juris: component "Label" received getter prop "text" but never called it; read it with props.text() or api.prop(props.text) inside a binding'), lines.join("\n"));
    assert.ok(!lines.some((line) => line.includes('"onPick"')));
});

test("devMode: a retained component given the same getter is not invoked again, its getter still read", (t) => {
    t.mock.method(console, "warn", () => { });
    const juris = client({ devMode: true, state: { tick: 0, v: "one" } });
    let invoked = 0;
    const getter = () => juris.getState("v");
    juris.registerComponent("Show", (props, api) => {
        invoked += 1;
        return { span: { textContent: () => api.prop(props.value) } };
    });
    const ul = juris.render(host(), { ul: { children: () => { juris.getState("tick"); return [{ Show: { key: "a", value: getter } }]; } } });
    juris.setValue("tick", 1);
    assert.equal(invoked, 1);
    juris.setValue("v", "two");
    assert.equal(ul.firstChild.textContent, "two");
});

// ---- props a retained component is compared by -------------------------------------------------

test("a retained component given a ref to the same path is not invoked again; another path invokes it", () => {
    const juris = client({ state: { tick: 0, path: "x", x: 1, y: 2 } });
    let invoked = 0;
    juris.registerComponent("Show", (props, api) => {
        invoked += 1;
        return { span: { textContent: () => String(api.prop(props.value)) } };
    });
    const ul = juris.render(host(), { ul: { children: () => { juris.getState("tick"); return [{ Show: { key: "a", value: juris.api.ref(juris.getState("path")) } }]; } } });
    juris.setValue("tick", 1);
    assert.equal(invoked, 1, "a fresh ref to the same path is the same prop");
    juris.setValue("path", "y");
    assert.equal(invoked, 2);
    assert.equal(ul.firstChild.textContent, "2");
});

test("a retained component given a prop more, or a fresh callback, is invoked again", () => {
    const juris = client({ state: { extra: false, tick: 0 } });
    let invoked = 0;
    juris.registerComponent("Item", () => { invoked += 1; return { li: "item" }; });
    juris.render(host(), { ul: { children: () => { juris.getState("tick"); return [{ Item: { key: "a", ...(juris.getState("extra") ? { more: 1 } : {}) } }]; } } });
    juris.setValue("extra", true);
    assert.equal(invoked, 2);
    juris.setValue("tick", 1);
    assert.equal(invoked, 2);
});

test("a keyed element passes from one component to another of its key, the first one disposed", () => {
    const juris = client({ state: { which: "First" } });
    const log = [];
    juris.registerComponent("First", (props, api) => { api.onCleanup(() => log.push("first cleaned")); return { li: "first" }; });
    juris.registerComponent("Second", () => ({ li: { className: "second", textContent: "second" } }));
    const ul = juris.render(host(), { ul: { children: () => [{ [juris.getState("which")]: { key: "k" } }] } });
    const li = ul.firstChild;
    juris.setValue("which", "Second");
    assert.equal(ul.firstChild, li, "the element is kept");
    assert.equal(li.textContent, "second");
    assert.deepEqual(log, ["first cleaned"]);
});

// ---- instances sharing a root -------------------------------------------------------------------

test("an outer component whose root is an inner one's follows the inner one's new root, and re-invokes it there", () => {
    const juris = client({ state: { tag: "div", label: "a" } });
    let innerInvoked = 0;
    juris.registerComponent("Inner", (props) => {
        innerInvoked += 1;
        return () => ({ [juris.getState("tag")]: { textContent: props.label } });
    });
    juris.registerComponent("Outer", () => () => ({ Inner: { label: juris.getState("label") } }));
    const target = host();
    juris.render(target, { Outer: {} });
    assert.deepEqual(names(target), ["div"]);
    juris.setValue("tag", "span"); // the inner one swaps the root they share
    assert.deepEqual(names(target), ["span"]);
    const span = target.firstChild;
    juris.setValue("label", "b"); // the outer one redraws into the node that is there now
    assert.deepEqual(names(target), ["span"]);
    assert.equal(target.firstChild, span);
    assert.equal(span.textContent, "b");
    assert.equal(innerInvoked, 2);
    juris.setValue("tag", "em");
    assert.deepEqual(names(target), ["em"], "only the new inner instance runs");
    assert.equal(target.firstChild.textContent, "b");
});

test("a component in a seat that swaps its own root keeps the seat on the node that is there", () => {
    const juris = client({ state: { show: true, tag: "div" } });
    const log = [];
    juris.registerComponent("Swap", (props, api) => {
        api.onCleanup(() => log.push("swap cleaned"));
        return () => ({ [juris.getState("tag")]: "swap" });
    });
    const div = juris.render(host(), { div: { children: ["a", () => (juris.getState("show") ? { Swap: {} } : { p: "gone" }), "b"] } });
    assert.deepEqual(names(div), ["#a", "div", "#b"]);
    juris.setValue("tag", "span");
    assert.deepEqual(names(div), ["#a", "span", "#b"]);
    juris.setValue("show", false);
    assert.deepEqual(names(div), ["#a", "p", "#b"], "the seat replaced the node actually there");
    assert.deepEqual(log, ["swap cleaned"]);
    juris.setValue("tag", "em");
    assert.deepEqual(names(div), ["#a", "p", "#b"]);
});

// ---- error boundaries ----------------------------------------------------------------------------

test("a component that is its own boundary draws its fallback in its place when its setup throws", () => {
    const juris = client();
    const seen = [];
    juris.registerComponent("Safe", (props, api) => {
        api.onError((error, info) => {
            seen.push([error.message, info.phase, info.component, info.boundary]);
            return { p: { className: "fallback", textContent: "fallback" } };
        });
        throw new Error("setup failed");
    });
    const div = juris.render(host(), { div: { children: [{ Safe: {} }, { span: "after" }] } });
    assert.deepEqual(names(div), ["p", "span"]);
    assert.equal(div.firstChild.textContent, "fallback");
    assert.deepEqual(seen, [["setup failed", "setup", "Safe", "Safe"]]);
});

test("a component whose setup failed into its fallback goes with the fallback's node, its cleanups run once", () => {
    const juris = client();
    const log = [];
    juris.registerComponent("Safe", (props, api) => {
        api.onCleanup(() => log.push("cleanup"));
        api.onError(() => ({ p: "fallback" }));
        throw new Error("setup failed");
    });
    juris.registerComponent("Quiet", (props, api) => {
        api.onCleanup(() => log.push("quiet cleanup"));
        api.onError(() => undefined);
        throw new Error("swallowed");
    });
    const div = juris.render(host(), { div: { children: [{ Safe: {} }, { Quiet: {} }] } });
    assert.deepEqual(names(div), ["p", "#"]);
    juris.disposeTree(div);
    juris.disposeTree(div);
    assert.deepEqual(log, ["cleanup", "quiet cleanup"]);
});

test("a boundary that answers nothing swallows the error: the component draws nothing, and devMode says who handled it", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = client({ devMode: true });
    juris.registerComponent("Quiet", (props, api) => {
        api.onError(() => undefined);
        throw new Error("swallowed");
    });
    const div = juris.render(host(), { div: { children: [{ Quiet: {} }, { span: "after" }] } });
    assert.deepEqual(names(div), ["#", "span"]);
    assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]) === 'Juris: error in "Quiet" handled by "Quiet"'));
});

test("an error no boundary handles is thrown out of the draw", () => {
    const juris = client();
    juris.registerComponent("Broken", () => { throw new TypeError("no boundary"); });
    assert.throws(() => juris.render(host(), { div: { children: [{ Broken: {} }] } }), { name: "TypeError", message: "no boundary" });
});

test("a boundary further out draws its fallback in its own place when a component inside it throws in setup", () => {
    const juris = client();
    const asked = [];
    juris.registerComponent("Outer", (props, api) => {
        api.onError((error) => { asked.push(["Outer", error.message]); return { section: { className: "outer-fallback" } }; });
        return { div: { className: "outer", children: [{ Middle: {} }] } };
    });
    juris.registerComponent("Middle", (props, api) => {
        api.onError(() => { asked.push(["Middle"]); return false; }); // not mine
        return { div: { className: "middle", children: [{ Inner: {} }] } };
    });
    juris.registerComponent("Inner", () => { throw new Error("deep"); });
    const target = host();
    const root = juris.render(target, { Outer: {} });
    assert.deepEqual(names(target), ["section"]);
    assert.equal(root.getAttribute("class"), "outer-fallback");
    assert.deepEqual(asked, [["Middle"], ["Outer", "deep"]]);
});

test("a boundary further out that swallows an inner component's setup error leaves that component empty and draws the rest", () => {
    const juris = client();
    juris.registerComponent("Outer", (props, api) => {
        api.onError(() => undefined);
        return { div: { children: [{ Inner: {} }, { p: "rest" }] } };
    });
    juris.registerComponent("Inner", () => { throw new Error("inner"); });
    const div = juris.render(host(), { Outer: {} });
    assert.deepEqual(names(div), ["#", "p"]);
});

test("a boundary still drawing shows its fallback when a binding inside it throws on its first run", () => {
    const juris = client({ state: { x: 1 } });
    juris.registerComponent("Panel", (props, api) => {
        api.onError((error, info) => ({ p: `failed in ${info.phase}: ${error.message}` }));
        return { div: { children: [{ span: { textContent: () => { juris.getState("x"); throw new Error("bad binding"); } } }] } };
    });
    const target = host();
    juris.render(target, { Panel: {} });
    assert.deepEqual(names(target), ["p"]);
    assert.equal(target.firstChild.textContent, "failed in binding: bad binding");
});

test("a boundary that has finished drawing swaps its root for the fallback when a binding inside it throws later", () => {
    const juris = client({ state: { bad: false } });
    juris.registerComponent("Panel", (props, api) => {
        api.onError((error) => ({ p: { className: "fallback", textContent: error.message } }));
        return { div: { className: "panel", children: [{ span: { textContent: () => { if (juris.getState("bad")) throw new Error("later"); return "fine"; } } }] } };
    });
    const target = host();
    const div = juris.render(target, { div: { children: [{ Panel: {} }] } });
    assert.equal(div.firstChild.getAttribute("class"), "panel");
    juris.setValue("bad", true);
    assert.deepEqual(names(div), ["p"]);
    assert.equal(div.firstChild.textContent, "later");
});

test("a keyed boundary's fallback keeps the boundary's key, so a keyed list keeps it as it moves", () => {
    const juris = client({ state: { bad: false, order: ["a", "b"] } });
    juris.registerComponent("Panel", (props, api) => {
        api.onError(() => ({ p: "fallback" }));
        return () => {
            if (juris.getState("bad")) throw new Error("root failed");
            return { div: "panel" };
        };
    });
    const ul = juris.render(host(), {
        ul: { children: () => juris.getState("order").map((key) => (key === "a" ? { Panel: { key } } : { li: { key, textContent: key } })) },
    });
    juris.setValue("bad", true);
    assert.deepEqual(names(ul), ["p", "li"]);
    const fallback = ul.firstChild;
    juris.setValue("order", ["b", "a"]);
    assert.deepEqual(names(ul), ["li", "p"]);
    assert.equal(ul.childNodes[1], fallback, "the same node, moved by its key");
});

test("a boundary inside <svg> draws its fallback in SVG", () => {
    const juris = client({ state: { bad: false } });
    juris.registerComponent("Icon", (props, api) => {
        api.onError(() => ({ rect: { className: "broken" } }));
        return () => {
            if (juris.getState("bad")) throw new Error("no icon");
            return { circle: {} };
        };
    });
    const svg = juris.render(host(), { svg: { children: [{ Icon: {} }] } });
    juris.setValue("bad", true);
    assert.equal(svg.firstChild.localName, "rect");
    assert.equal(svg.firstChild.namespaceURI, SVG);
});

test("a component a boundary further out replaces in its first draw is disposed, with the components it had drawn", () => {
    const juris = client({ devMode: true });
    const log = [];
    const failing = { p: { textContent: () => { juris.getState("x"); throw new Error("bad"); } } };
    juris.registerComponent("Outer", (props, api) => { api.onError(() => ({ p: "fallback" })); return { section: { children: [props.inner] } }; });
    juris.registerComponent("Inner", (props, api) => { api.onCleanup(() => log.push("inner")); return { div: { children: [{ Done: {} }, failing] } }; });
    juris.registerComponent("Done", (props, api) => { api.onCleanup(() => log.push("done")); return { span: "drawn" }; });
    juris.registerComponent("Broken", (props, api) => { api.onCleanup(() => log.push("broken")); throw new Error("setup"); });
    assert.equal(juris.render(host(), { Outer: { inner: { Inner: {} } } }).textContent, "fallback");
    assert.deepEqual(log, ["done", "inner"], "innermost first");
    assert.equal(juris.render(host(), { Outer: { inner: { Broken: {} } } }).textContent, "fallback");
    assert.deepEqual(log, ["done", "inner", "broken"], "a setup error handed to a boundary further out too");
    assert.deepEqual(juris.componentTree().map((node) => [node.name, node.children.map((child) => child.name)]), [["Outer", []], ["Outer", []]]);
});

test("an error no boundary takes, escaping a first draw, disposes what that draw made, innermost first, and reaches the caller unchanged", () => {
    const juris = client({ devMode: true, state: { on: true } });
    const log = [];
    let runs = 0;
    const error = new Error("bad");
    const failing = { p: { textContent: () => { juris.getState("x"); throw error; } } };
    juris.registerComponent("Outer", (props, api) => { api.onCleanup(() => log.push("outer")); return { section: { children: [props.inner] } }; });
    juris.registerComponent("Inner", (props, api) => {
        api.onCleanup(() => log.push("inner"));
        return { div: { children: [{ Done: {} }, { b: { textContent: () => { runs += 1; return juris.getState("y"); } } }, failing] } };
    });
    juris.registerComponent("Done", (props, api) => { api.onCleanup(() => log.push("done")); return { span: "drawn" }; });
    juris.registerComponent("Broken", (props, api) => { api.onCleanup(() => log.push("broken")); throw error; });
    assert.throws(() => juris.render(host(), { Outer: { inner: { Inner: {} } } }), (thrown) => thrown === error);
    assert.deepEqual(log, ["done", "inner", "outer"]);
    juris.setValue("y", 1);
    assert.equal(runs, 1, "a binding the draw made before the error went with it");
    assert.throws(() => juris.render(host(), { Outer: { inner: { Broken: {} } } }), (thrown) => thrown === error);
    assert.deepEqual(log, ["done", "inner", "outer", "broken", "outer"], "a setup error too");
    assert.deepEqual(juris.componentTree(), []);
});

test("an error no boundary takes, escaping a component's draw into a node that was already there, disposes what it drew in that node", () => {
    const juris = client({ devMode: true, state: { on: true } });
    const log = [];
    const error = new Error("bad");
    juris.registerComponent("Done", (props, api) => { api.onCleanup(() => log.push("done")); return { span: "drawn" }; });
    juris.registerComponent("Inner", (props, api) => {
        api.onCleanup(() => log.push("inner"));
        return { div: { children: [{ Done: {} }, { p: { textContent: () => { juris.getState("x"); throw error; } } }] } };
    });
    const div = juris.render(host(), { div: { children: [() => (juris.getState("on") ? { div: "plain" } : { Inner: {} })] } });
    assert.throws(() => juris.setValue("on", false), (thrown) => thrown === error);
    assert.equal(div.firstChild.localName, "div", "the node it took over stays");
    assert.deepEqual(log, ["done", "inner"]);
    assert.deepEqual(juris.componentTree(), []);
});

test("a re-draw that throws leaves the instance and the seat on its node, so a later removal of the node disposes them", () => {
    const juris = client({ state: { v: 1, show: true, seen: 0 } });
    const log = [];
    let seatRuns = 0;
    const error = new Error("bad");
    juris.registerComponent("Broken", () => { throw error; });
    juris.registerComponent("Box", (props, api) => {
        api.onCleanup(() => log.push("box"));
        return () => (juris.getState("v") === 1 ? { div: "one" } : { div: { children: [{ Broken: {} }] } });
    });
    juris.render(host(), { div: { children: () => (juris.getState("show") ? [() => { seatRuns += 1; juris.getState("seen"); return { Box: {} }; }] : []) } });
    assert.throws(() => juris.setValue("v", 2), (thrown) => thrown === error);
    juris.setValue("show", false);
    assert.deepEqual(log, ["box"], "the removal disposed the instance");
    const runs = seatRuns;
    juris.setValue("seen", 1);
    assert.equal(seatRuns, runs, "and the seat holding it");
});

test("a re-draw that throws after the components sharing its root were disposed leaves nothing of theirs on the node it keeps", () => {
    const juris = client({ state: { v: 1 } });
    const log = [];
    const error = new Error("bad");
    juris.registerComponent("Broken", () => { throw error; });
    juris.registerComponent("Inner", (props, api) => { api.onCleanup(() => log.push("inner")); return { p: { class: "inner", textContent: "inner" } }; });
    juris.registerComponent("Box", (props, api) => {
        api.onCleanup(() => log.push("box"));
        return () => [null, { Inner: {} }, { span: { children: [{ Broken: {} }] } }, { Broken: {} }][juris.getState("v")];
    });
    const target = host();
    juris.render(target, { Box: {} });
    const p = target.firstChild;
    for (const v of [2, 3]) {
        juris.setValue("v", 1);
        assert.equal(target.firstChild.textContent, "inner", "the instance, still there, draws again");
        assert.throws(() => juris.setValue("v", v), (thrown) => thrown === error);
        assert.equal(target.firstChild, p, "the node is kept");
        assert.deepEqual([p.childNodes.length, p.hasAttribute("class")], [0, false], "and shows nothing of the component that went");
    }
    assert.deepEqual(log, ["inner", "inner"], "the components sharing the root went; the one re-drawing stays");
});

test("a component that drew text, gone with a re-draw that throws, leaves the text node that is kept empty", () => {
    const juris = client({ state: { v: 1 } });
    const error = new Error("bad");
    juris.registerComponent("Broken", () => { throw error; });
    juris.registerComponent("Said", () => "said");
    juris.registerComponent("Box", () => () => (juris.getState("v") === 1 ? { Said: {} } : { span: { children: [{ Broken: {} }] } }));
    const target = host();
    juris.render(target, { Box: {} });
    const text = target.firstChild;
    assert.equal(text.nodeValue, "said");
    assert.throws(() => juris.setValue("v", 2), (thrown) => thrown === error);
    assert.equal(target.firstChild, text);
    assert.equal(text.nodeValue, "");
});

test("disposal runs every cleanup of an instance, then every other instance on the node, then what the node holds, and throws the first error after", () => {
    const juris = client({ state: { show: true, t: "x" } });
    const log = [];
    const first = new Error("first");
    let runs = 0;
    juris.registerComponent("Inner", (props, api) => {
        api.onCleanup(() => { log.push("inner-1"); throw first; });
        api.onCleanup(() => { log.push("inner-2"); throw new Error("second"); });
        return { div: { children: [{ p: { textContent: () => { runs += 1; return juris.getState("t"); } } }] } };
    });
    juris.registerComponent("Outer", (props, api) => { api.onCleanup(() => log.push("outer")); return { Inner: {} }; });
    juris.render(host(), { div: { children: () => (juris.getState("show") ? [{ Outer: {} }] : []) } });
    assert.throws(() => juris.setValue("show", false), (thrown) => thrown === first);
    assert.deepEqual(log, ["inner-1", "inner-2", "outer"], "innermost first, each to the end");
    juris.setValue("t", "y");
    assert.equal(runs, 1, "a binding the node held went too");
});

test("every onMount handler due runs whichever throws, and the first error is thrown once all have", () => {
    const juris = client();
    const log = [];
    const first = new Error("first");
    juris.registerComponent("A", (props, api) => { api.onMount(() => { log.push("a"); throw first; }); api.onMount(() => log.push("a-2")); return { i: "a" }; });
    juris.registerComponent("B", (props, api) => { api.onMount(() => { log.push("b"); return () => log.push("b cleanup"); }); return { b: "b" }; });
    assert.throws(() => juris.render(host(), { div: { children: [{ A: {} }, { B: {} }] } }), (thrown) => thrown === first);
    assert.deepEqual(log, ["a", "a-2", "b"]);
});

test("devMode's tree watchers are told after a pass whose onMount handler throws", () => {
    const juris = client({ devMode: true });
    const error = new Error("bad");
    const told = [];
    juris.onTreeChange((tree) => told.push(tree.map((node) => node.name)));
    juris.registerComponent("Mounting", (props, api) => { api.onMount(() => { throw error; }); return { p: "x" }; });
    assert.throws(() => juris.render(host(), { Mounting: {} }), (thrown) => thrown === error);
    assert.deepEqual(told, [["Mounting"]]);
});

test("an abandoned draw whose disposal throws still hands the caller the draw's own error", () => {
    const juris = client();
    const draw = new Error("draw");
    const log = [];
    juris.registerComponent("Inner", (props, api) => {
        api.onCleanup(() => { log.push("cleanup"); throw new Error("cleanup"); });
        return { div: { children: [{ p: { textContent: () => { juris.getState("x"); throw draw; } } }] } };
    });
    assert.throws(() => juris.render(host(), { Inner: {} }), (thrown) => thrown === draw);
    assert.deepEqual(log, ["cleanup"]);
});

test("a re-draw whose components sharing the root throw as they go leaves the instance on its node and the node empty", () => {
    const juris = client({ state: { v: 1 } });
    const error = new Error("cleanup");
    juris.registerComponent("Inner", (props, api) => { api.onCleanup(() => { throw error; }); return { p: { class: "inner", textContent: "inner" } }; });
    juris.registerComponent("Box", () => () => (juris.getState("v") === 1 ? { Inner: {} } : { p: "two" }));
    const target = host();
    juris.render(target, { Box: {} });
    const p = target.firstChild;
    assert.throws(() => juris.setValue("v", 2), (thrown) => thrown === error);
    assert.deepEqual([target.firstChild, p.childNodes.length, p.hasAttribute("class")], [p, 0, false]);
    assert.deepEqual(juris.componentInstances.get(p).map((instance) => instance.name), ["Box"]);
    juris.setValue("v", 3);
    assert.equal(target.firstChild.textContent, "two", "and it draws again");
});

test("a node swapped for another whose disposal throws is swapped all the same: the new one is in place and live, and the cleanup's error reaches the caller", () => {
    const juris = client({ state: { v: 1, t: "a" } });
    const error = new Error("cleanup");
    juris.registerComponent("Deep", (props, api) => { api.onCleanup(() => { throw error; }); return { b: "deep" }; });
    juris.registerComponent("Box", () => () => (juris.getState("v") === 1 ? { p: { children: [{ Deep: {} }] } } : { span: { textContent: () => juris.getState("t") } }));
    const seated = juris.render(host(), { div: { children: [() => (juris.getState("v") === 1 ? { p: { children: [{ Deep: {} }] } } : { span: { textContent: () => juris.getState("t") } })] } });
    const rooted = host();
    juris.render(rooted, { Box: {} });
    assert.throws(() => juris.setValue("v", 2), (thrown) => thrown === error);
    for (const parent of [seated, rooted]) assert.deepEqual(parent.childNodes.map((n) => n.localName), ["span"]);
    assert.equal(juris.renderer.slots.has(seated.firstChild), true, "the seat is on the node now in place");
    assert.deepEqual(juris.componentInstances.get(rooted.firstChild).map((instance) => instance.name), ["Box"], "and so is the instance");
    juris.setValue("t", "b");
    assert.deepEqual([seated.textContent, rooted.textContent], ["b", "b"], "each live");
});

test("a draw's own error reaches the caller even when an onMount handler due in the same pass throws", () => {
    const juris = client({ state: { on: false } });
    const draw = new Error("draw");
    const log = [];
    juris.registerComponent("Mounted", (props, api) => { api.onMount(() => { log.push("mounted"); throw new Error("mount"); }); return { i: "m" }; });
    juris.registerComponent("Broken", () => { throw draw; });
    juris.render(host(), { div: { children: () => (juris.getState("on") ? [{ Mounted: {} }, { Broken: {} }] : []) } });
    assert.throws(() => juris.setValue("on", true), (thrown) => thrown === draw);
    assert.deepEqual(log, ["mounted"], "the handler still ran");
});

test("as an operation ends, a late disposal's error, a mount handler's and a tree watcher's each run to the end, and the first is thrown", () => {
    const juris = client({ devMode: true, state: { v: 1 } });
    const late = new Error("cleanup");
    const told = [];
    let armed = false;
    juris.onTreeChange(() => { if (!armed) return; told.push("watcher"); throw new Error("watcher"); });
    juris.registerComponent("Deep", (props, api) => { api.onCleanup(() => { throw late; }); return { b: "deep" }; });
    juris.registerComponent("Mounted", (props, api) => { api.onMount(() => { told.push("mounted"); throw new Error("mount"); }); return { i: "m" }; });
    const div = juris.render(host(), { div: { children: [() => (juris.getState("v") === 1 ? { p: { children: [{ Deep: {} }] } } : { span: { children: [{ Mounted: {} }] } })] } });
    armed = true;
    assert.throws(() => juris.setValue("v", 2), (thrown) => thrown === late);
    assert.deepEqual(told, ["mounted", "watcher"]);
    assert.equal(div.firstChild.localName, "span");
});
