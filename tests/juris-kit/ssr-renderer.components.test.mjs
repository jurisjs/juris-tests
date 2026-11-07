// server/ssr-renderer.js, everything around the markup: components (props, keys, a definition that
// answers a function, client-only ones), the cleanups that end every render, error boundaries in each
// phase (setup, binding, async) and the fallbacks they draw, unknown components and the namespaces
// that decide them, re-entrancy, and the trace (`renderTrace`). The renderer is given to the instance
// as a feature (`features: { ssr: SSRRenderer }`), as the kit's server gives its own. Held to
// REFERENCE.md's "server/ssr-renderer.js", "Components and layouts", "The component api" and the
// renderer's own comments.
import { test } from "node:test";
import assert from "node:assert/strict";

import Juris from "juris/juris.js";
import { settledError } from "juris/state-manager.js";
import SSRRenderer from "juris-kit/server/ssr-renderer.js";

const server = (options = {}) => new Juris({ isServer: true, ...options, features: { ssr: SSRRenderer, ...options.features } });

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

// ---- components -----------------------------------------------------------------------------

test("a component is drawn from its props, its content's text being textContent", () => {
    const juris = server();
    const seen = [];
    juris.registerComponent("Card", (props, api) => {
        seen.push([props, api === juris.api]);
        return { div: { className: "card", children: props.textContent ?? props.title } };
    });
    assert.equal(juris.renderToString({ Card: { title: "A & B" } }), '<div class="card">A &amp; B</div>');
    assert.equal(juris.renderToString({ Card: "text" }), '<div class="card">text</div>');
    assert.equal(juris.renderToString({ Card: null }), '<div class="card"></div>');
    assert.deepEqual(seen, [[{ title: "A & B" }, true], [{ textContent: "text" }, true], [{}, true]]);
});

test("a component's key is copied onto its root, unless the root has its own", () => {
    const juris = server();
    juris.registerComponent("Row", (props) => ({ li: props.label }));
    juris.registerComponent("OwnKey", () => ({ li: { key: "mine" } }));
    juris.registerComponent("Text", () => "plain");
    assert.equal(juris.renderToString({ ul: { children: [{ Row: { key: 1, label: "a" } }, { Row: { key: 2, label: "b" } }] } }), '<ul><li data-key="1">a</li><li data-key="2">b</li></ul>');
    assert.equal(juris.renderToString({ OwnKey: { key: "theirs" } }), '<li data-key="mine"></li>');
    assert.equal(juris.renderToString({ Text: { key: 3 } }), "plain");
});

test("a definition that answers a function has it run once, as a binding", () => {
    const juris = server({ state: { n: 2 } });
    juris.registerComponent("Live", (props, api) => () => ({ span: { textContent: api.getState("n") * 10 } }));
    assert.equal(juris.renderToString({ Live: {} }, null, { trace: true }), "<span>20</span>");
    assert.equal(juris.renderTrace().reactive, 1);
    assert.deepEqual(juris.renderTrace().paths, ["n"]);
});

test("a component nested in a component's layout is drawn in its place", () => {
    const juris = server();
    juris.registerComponent("Inner", (props) => ({ b: props.v }));
    juris.registerComponent("Outer", () => ({ p: { children: [{ Inner: { v: 1 } }, " ", { Inner: { v: 2 } }] } }));
    assert.equal(juris.renderToString({ Outer: {} }), "<p><b>1</b> <b>2</b></p>");
});

// An async definition answers a promise, which the server cannot wait for: nothing is written, and
// devMode says so in the DOM renderer's words (dom-renderer.components), never as a tag.
test("an async definition writes nothing, and devMode says that is what happened, never a tag", () => {
    const juris = server({ devMode: true });
    juris.registerComponent("Lazy", async () => ({ p: "loaded" }));
    const { result, warned } = said(() => juris.renderToString({ Lazy: {} }));
    assert.equal(result, "");
    assert.equal(warned.length, 1);
    assert.match(warned[0], /^Juris: dropped component "Lazy": its definition returned a promise/);
    assert.doesNotMatch(warned[0], /tag name/);
});

test("a keyed async definition writes nothing too, and no element named undefined", () => {
    const juris = server();
    juris.registerComponent("Lazy", async () => ({ p: "loaded" }));
    assert.equal(juris.renderToString({ Lazy: { key: 1 } }), "");
});

// A list where one layout goes is refused in words naming what gave it, the DOM renderer's words
// (dom-renderer.components): a component, a function in one child's place, or nothing in particular.
const COMPONENT_LIST = "Juris: a layout is one { tag: content } object; a component cannot return an array"
    + ": wrap the children in an element";
const SEAT_LIST = "Juris: a layout is one { tag: content } object; a function in one child's place returned a list"
    + ": make the function the children itself (children: () => [...]), or wrap the items in an element";
const LIST_GIVEN = "Juris: a layout is one { tag: content } object, and a list was given where one goes"
    + ": wrap the items in an element";

test("a list where one layout goes throws in words naming what gave it", () => {
    const juris = server();
    const milk = { li: "Milk" };
    const eggs = { li: "Eggs" };
    juris.registerComponent("Many", () => [milk, eggs]);
    juris.registerComponent("Keyed", () => [milk]);
    juris.registerComponent("Rooted", () => () => [milk, eggs]);
    juris.registerComponent("Chained", () => () => () => [milk, eggs]);
    assert.throws(() => juris.renderToString({ Many: {} }), { message: COMPONENT_LIST });
    assert.throws(() => juris.renderToString({ Keyed: { key: 1 } }), { message: COMPONENT_LIST }, "a keyed one too");
    assert.throws(() => juris.renderToString({ Rooted: {} }), { message: COMPONENT_LIST }, "a root function's value");
    assert.throws(() => juris.renderToString({ Chained: {} }), { message: SEAT_LIST }, "a function it returns");
    assert.throws(() => juris.renderToString({ ul: { children: [() => [milk, eggs]] } }), { message: SEAT_LIST });
    assert.throws(() => juris.renderToString({ ul: { children: [[milk]] } }), { message: LIST_GIVEN });
    assert.throws(() => juris.renderToString([milk]), { message: LIST_GIVEN });
});

test("a client-only component writes a placeholder, its definition never run", () => {
    const juris = server();
    let ran = false;
    juris.registerComponent("Map", () => { ran = true; return { div: "map" }; }, { ssr: false });
    assert.equal(juris.renderToString({ div: { children: { Map: { lat: 1 } } } }), "<div><!--juris:client Map--></div>");
    assert.equal(ran, false);
});

// ---- cleanups -------------------------------------------------------------------------------

test("cleanups registered during setup run when the render ends, innermost first", () => {
    const juris = server();
    const order = [];
    juris.registerComponent("Leaf", (props, api) => {
        api.onCleanup(() => order.push(`leaf ${props.n}`));
        return { i: props.n };
    });
    juris.registerComponent("Branch", (props, api) => {
        api.onCleanup(() => order.push("branch 1"));
        api.onCleanup(() => order.push("branch 2"));
        return { div: { children: [{ Leaf: { n: 1 } }, { Leaf: { n: 2 } }] } };
    });
    assert.equal(juris.renderToString({ Branch: {} }), "<div><i>1</i><i>2</i></div>");
    assert.deepEqual(order, ["leaf 2", "leaf 1", "branch 1", "branch 2"]);
});

test("a computed registered during setup does not outlive the render", () => {
    const juris = server({ state: { a: 1 } });
    juris.registerComponent("Total", (props, api) => {
        api.compute("total", (inner) => inner.getState("a") * 2);
        return { span: { textContent: () => api.getState("total") } };
    });
    assert.equal(juris.renderToString({ Total: {} }), "<span>2</span>");
    juris.setValue("a", 5);
    assert.equal(juris.getState("total"), 2);
    // Disposed, so the same path can be computed again by the next render.
    assert.equal(juris.renderToString({ Total: {} }), "<span>10</span>");
});

test("cleanups run, and the instance renders again, when a render throws", () => {
    const juris = server();
    const order = [];
    juris.registerComponent("Clean", (props, api) => {
        api.onCleanup(() => order.push("clean"));
        return { div: { children: { Boom: {} } } };
    });
    juris.registerComponent("Boom", () => { throw new TypeError("setup failed"); });
    assert.throws(() => juris.renderToString({ Clean: {} }), { name: "TypeError", message: "setup failed" });
    assert.deepEqual(order, ["clean"]);
    assert.equal(juris.ssrRenderer.instances, null);
    assert.equal(juris.ssrRenderer.owner, null);
    assert.equal(juris.renderToString({ p: "ok" }), "<p>ok</p>");
});

// ---- re-entrancy ----------------------------------------------------------------------------

test("a render inside a render is refused; the outer render ends cleanly", () => {
    const juris = server();
    const order = [];
    juris.registerComponent("Nested", (props, api) => {
        api.onCleanup(() => order.push("cleaned"));
        return { div: { children: () => api.renderToString({ p: "inner" }) } };
    });
    assert.throws(() => juris.renderToString({ Nested: {} }), { name: "Error", message: "Juris.renderToString: a render is already in progress on this instance" });
    assert.deepEqual(order, ["cleaned"]);
    assert.equal(juris.renderToString({ p: "after" }), "<p>after</p>");
});

// ---- error boundaries: setup ------------------------------------------------------------------

test("an unhandled setup error is thrown out of the render as it was", () => {
    const juris = server();
    const failure = new RangeError("no");
    juris.registerComponent("Bad", () => { throw failure; });
    assert.throws(() => juris.renderToString({ div: { children: { Bad: {} } } }), (error) => error === failure);
});

test("a component that is its own boundary draws the layout its handler answers for its setup error", () => {
    const juris = server();
    const heard = [];
    juris.registerComponent("Self", (props, api) => {
        api.onError((error, info) => {
            heard.push([error.message, info]);
            return { p: { className: "fallback", children: error.message } };
        });
        throw new Error("broken");
    });
    assert.equal(juris.renderToString({ Self: { key: "k" } }), '<p class="fallback" data-key="k">broken</p>');
    assert.deepEqual(heard, [["broken", { phase: "setup", component: "Self", boundary: "Self" }]]);
});

test("a component whose own handler swallows its setup error draws nothing", () => {
    const juris = server();
    juris.registerComponent("Quiet", (props, api) => {
        api.onError(() => undefined);
        throw new Error("x");
    });
    assert.equal(juris.renderToString({ div: { children: [{ Quiet: {} }, "rest"] } }), "<div>rest</div>");
});

test("a child's setup error reaches the parent boundary, whose fallback replaces the parent's root", () => {
    const juris = server();
    const heard = [];
    juris.registerComponent("Child", () => { throw new Error("child broke"); });
    juris.registerComponent("Parent", (props, api) => {
        api.onError((error, info) => {
            heard.push(info);
            return { aside: `fallback: ${error.message}` };
        });
        return { section: { children: [{ h1: "title" }, { Child: {} }] } };
    });
    assert.equal(juris.renderToString({ main: { children: { Parent: { key: 9 } } } }), '<main><aside data-key="9">fallback: child broke</aside></main>');
    assert.deepEqual(heard, [{ phase: "setup", component: "Child", boundary: "Parent" }]);
});

test("a parent boundary that swallows a child's setup error leaves the child out and the rest drawn", () => {
    const juris = server();
    juris.registerComponent("Child", () => { throw new Error("child broke"); });
    juris.registerComponent("Parent", (props, api) => {
        api.onError(() => undefined);
        return { section: { children: [{ h1: "title" }, { Child: {} }, { p: "after" }] } };
    });
    assert.equal(juris.renderToString({ Parent: {} }), "<section><h1>title</h1><p>after</p></section>");
});

test("a handler that answers false passes the error to the next boundary up", () => {
    const juris = server();
    const asked = [];
    juris.registerComponent("Child", () => { throw new Error("deep"); });
    juris.registerComponent("Middle", (props, api) => {
        api.onError(() => { asked.push("middle"); return false; });
        return { div: { children: { Child: {} } } };
    });
    juris.registerComponent("Top", (props, api) => {
        api.onError(() => { asked.push("top"); return { p: "top caught it" }; });
        return { div: { children: { Middle: {} } } };
    });
    assert.equal(juris.renderToString({ Top: {} }), "<p>top caught it</p>");
    assert.deepEqual(asked, ["middle", "top"]);
});

test("with every handler answering false the setup error is thrown", () => {
    const juris = server();
    juris.registerComponent("Child", () => { throw new Error("nobody"); });
    juris.registerComponent("Shrug", (props, api) => {
        api.onError(() => false);
        return { div: { children: { Child: {} } } };
    });
    assert.throws(() => juris.renderToString({ Shrug: {} }), { message: "nobody" });
});

// ---- error boundaries: bindings ---------------------------------------------------------------

test("a binding that throws offers its error to the boundary, whose fallback replaces its root", () => {
    const juris = server();
    const heard = [];
    juris.registerComponent("Widget", (props, api) => {
        api.onError((error, info) => {
            heard.push(info);
            return { em: "widget failed" };
        });
        return { div: { title: () => { throw new Error("bad title"); }, children: "never" } };
    });
    assert.equal(juris.renderToString({ section: { children: [{ Widget: {} }, { p: "after" }] } }), "<section><em>widget failed</em><p>after</p></section>");
    assert.deepEqual(heard, [{ phase: "binding", component: "Widget", boundary: "Widget" }]);
});

test("a binding error swallowed by its boundary leaves that value out and draws the rest", () => {
    const juris = server();
    juris.registerComponent("Lenient", (props, api) => {
        api.onError(() => undefined);
        return { div: { title: () => { throw new Error("x"); }, children: [() => { throw new Error("y"); }, "kept"] } };
    });
    assert.equal(juris.renderToString({ Lenient: {} }), "<div>kept</div>");
});

test("a binding error with no boundary is thrown out of the render", () => {
    const juris = server();
    assert.throws(() => juris.renderToString({ p: { children: () => { throw new SyntaxError("unbound"); } } }), { name: "SyntaxError", message: "unbound" });
});

test("a fallback travels past components that are not its boundary, to the one that is", () => {
    const juris = server();
    juris.registerComponent("Inner", () => ({ span: { textContent: () => { throw new Error("inner binding"); } } }));
    juris.registerComponent("Plain", () => ({ div: { children: { Inner: {} } } }));
    juris.registerComponent("Boundary", (props, api) => {
        api.onError((error) => ({ p: `caught ${error.message}` }));
        return { article: { children: { Plain: {} } } };
    });
    assert.equal(juris.renderToString({ Boundary: {} }), "<p>caught inner binding</p>");
});

test("an inner boundary's fallback is drawn in its place, and the outer one keeps its root", () => {
    const juris = server();
    juris.registerComponent("Inner", (props, api) => {
        api.onError(() => ({ i: "inner fallback" }));
        return { span: { title: () => { throw new Error("x"); } } };
    });
    juris.registerComponent("Outer", (props, api) => {
        api.onError(() => ({ p: "outer fallback" }));
        return { div: { children: [{ Inner: {} }, "outer"] } };
    });
    assert.equal(juris.renderToString({ Outer: {} }), "<div><i>inner fallback</i>outer</div>");
});

test("a child's setup error that the parent answers with a fallback travels through the components between", () => {
    const juris = server();
    juris.registerComponent("Thrower", () => { throw new Error("setup"); });
    juris.registerComponent("Between", () => ({ div: { children: { Thrower: {} } } }));
    juris.registerComponent("Top", (props, api) => {
        api.onError(() => ({ p: "top fallback" }));
        return { section: { children: { Between: {} } } };
    });
    assert.equal(juris.renderToString({ Top: {} }), "<p>top fallback</p>");
});

// ---- error boundaries: async (a preloaded rejection) ----------------------------------------------

test("a settled error offered to a boundary draws its fallback, phase async", () => {
    const juris = server();
    const heard = [];
    const failure = new Error("preload failed");
    juris.registerComponent("Data", (props, api) => {
        api.onError((error, info) => {
            heard.push([error, info]);
            return { p: "could not load" };
        });
        return { ul: { children: () => settledError(failure) } };
    });
    assert.equal(juris.renderToString({ Data: {} }), "<p>could not load</p>");
    assert.deepEqual(heard, [[failure, { phase: "async", component: "Data", boundary: "Data" }]]);
});

test("a settled error a boundary swallows renders empty, and is not said on the console", () => {
    const juris = server({ devMode: true });
    juris.registerComponent("Data", (props, api) => {
        api.onError(() => undefined);
        return { ul: { children: settledError(new Error("x")), title: "t" } };
    });
    const { result, errored } = said(() => juris.renderToString({ Data: {} }));
    assert.equal(result, '<ul title="t"></ul>');
    assert.deepEqual(errored, []);
});

// ---- unknown components ------------------------------------------------------------------------

test("a capitalised tag with no component is drawn as an element and listed in the trace", () => {
    const juris = server();
    assert.equal(juris.renderToString({ div: { children: [{ Missing: { a: 1 } }, { Missing: {} }, { Other: {} }] } }, null, { trace: true }), '<div><Missing a="1"></Missing><Missing></Missing><Other></Other></div>');
    assert.deepEqual(juris.renderTrace().unknown, ["Missing", "Other"]);
});

test("unknownComponents 'throw' refuses to draw one", () => {
    const juris = server({ unknownComponents: "throw" });
    assert.throws(() => juris.renderToString({ div: { children: { Missing: {} } } }), { message: 'Juris: "Missing" is not a registered component (unknownComponents: "throw")' });
});

test("unknownComponents 'warn' says so once per name, and what is drawn for a refused one", () => {
    const juris = server({ unknownComponents: "warn" });
    const { result, warned } = said(() => juris.renderToString({ div: { children: [{ Missing: {} }, { Missing: {} }, { Script: "x" }] } }));
    assert.equal(result, "<div><Missing></Missing><Missing></Missing></div>");
    assert.deepEqual(warned, [
        'Juris: "Missing" is not a registered component; rendering it as an HTML element',
        'Juris: "Script" is not a registered component, nor a tag a layout may draw; nothing is drawn for it',
    ]);
});

test("inside <svg> or <math> a capitalised tag is an element, never unknown", () => {
    const juris = server({ unknownComponents: "throw" });
    assert.equal(juris.renderToString({ svg: { children: { Foo: {} } } }, null, { trace: true }), "<svg><Foo></Foo></svg>");
    assert.deepEqual(juris.renderTrace().unknown, []);
    assert.equal(juris.renderToString({ math: { children: { "annotation-xml": { children: { Bar: {} } } } } }), "<math><annotation-xml><Bar></Bar></annotation-xml></math>");
    assert.equal(juris.renderToString({ Baz: {} }, "http://www.w3.org/2000/svg"), "<Baz></Baz>");
});

test("HTML inside SVG's foreignObject and MathML's token elements is HTML again, where a capitalised tag is unknown", () => {
    const juris = server({ unknownComponents: "throw" });
    assert.throws(() => juris.renderToString({ svg: { children: { foreignObject: { children: { Foo: {} } } } } }), { message: /"Foo" is not a registered component/ });
    assert.throws(() => juris.renderToString({ math: { children: { mi: { children: { Bar: {} } } } } }), { message: /"Bar" is not a registered component/ });
});

// ---- the trace -----------------------------------------------------------------------------------

test("a traced render records the reactive functions run and the paths read, getState and peek alike", () => {
    const juris = server({ state: { user: { name: "Ada" }, theme: "dark", count: 3 } });
    juris.registerComponent("Hello", (props, api) => {
        const theme = api.peek("theme");
        return { p: { className: theme, children: () => `Hi ${api.getState("user.name")}`, title: () => String(api.getState("count")) } };
    });
    const traced = juris.renderToString({ Hello: {} }, null, { trace: true });
    const trace = juris.renderTrace();
    assert.equal(traced, '<p class="dark" title="3">Hi Ada</p>');
    assert.equal(trace.reactive, 2);
    assert.deepEqual(trace.paths.sort(), ["count", "theme", "user.name"]);
    assert.deepEqual(trace.roots.sort(), ["count", "theme", "user"]);
    assert.equal(trace.static, false);
    assert.deepEqual(trace.flags, []);
});

test("tracing changes nothing about the markup", () => {
    const juris = server({ state: { a: "x" } });
    const layout = { div: { children: [() => juris.api.getState("a"), { span: { title: () => "t" } }] } };
    assert.equal(juris.renderToString(layout), juris.renderToString(layout, null, { trace: true }));
});

test("a render with no reactive function and no call is static", () => {
    const juris = server();
    juris.renderToString({ div: { children: [{ p: "a" }, "b"] } }, null, { trace: true });
    assert.deepEqual(juris.renderTrace(), { reactive: 0, paths: [], roots: [], calls: [], services: [], live: [], flags: [], unknown: [], static: true });
});

test("a promise left unresolved flags the traced render", async () => {
    const juris = server();
    const pending = new Promise((resolve) => setImmediate(resolve, "late"));
    juris.renderToString({ p: { children: () => pending } }, null, { trace: true });
    assert.deepEqual(juris.renderTrace().flags, ["unresolved"]);
    await pending;
});

test("markRender's flags reach the trace, and nothing outside a traced render", () => {
    const juris = server();
    juris.registerComponent("Clock", (props, api) => {
        api.markRender("clock");
        api.markRender(42);
        return { time: "now" };
    });
    juris.renderToString({ Clock: {} }, null, { trace: true });
    assert.deepEqual(juris.renderTrace().flags, ["clock", "42"]);
    juris.renderToString({ Clock: {} });
    assert.equal(juris.renderTrace(), null);
});

test("an untraced render leaves no trace, and the last traced one is replaced by it", () => {
    const juris = server();
    juris.renderToString({ p: () => "x" }, null, { trace: true });
    assert.equal(juris.renderTrace().reactive, 1);
    juris.renderToString({ p: "y" });
    assert.equal(juris.ssrRenderer.lastTrace, null);
    assert.equal(juris.renderTrace(), null);
    juris.renderToString({ p: "z" }, null, {});
    assert.equal(juris.renderTrace(), null);
});

test("the reads being recorded are put back as they were when the render ends, a throw included", () => {
    const juris = server({ state: { a: 1 } });
    const outer = new Set();
    juris.stateManager.activeReads = outer;
    juris.renderToString({ p: () => juris.api.getState("a") }, null, { trace: true });
    assert.equal(juris.stateManager.activeReads, outer);
    assert.deepEqual([...outer], []);
    assert.throws(() => juris.renderToString({ p: () => { throw new Error("x"); } }, null, { trace: true }), { message: "x" });
    assert.equal(juris.stateManager.activeReads, outer);
    juris.stateManager.activeReads = null;
    juris.renderToString({ p: () => juris.api.getState("a") });
    assert.equal(juris.stateManager.activeReads, null);
});

test("a traced render that throws still leaves its trace", () => {
    const juris = server({ state: { a: 1 } });
    assert.throws(() => juris.renderToString({ div: { title: () => juris.api.getState("a"), children: () => { throw new Error("late"); } } }, null, { trace: true }));
    assert.deepEqual(juris.renderTrace().paths, ["a"]);
    assert.equal(juris.renderTrace().reactive, 2);
});

// ---- an async definition, on a server that stays up ------------------------------------------------

test("an async definition that rejects ends nothing: the error is told, and the process goes on", async () => {
    const juris = server();
    const said = [];
    const original = console.error;
    console.error = (...args) => said.push(args);
    juris.registerComponent("Bad", async () => {
        throw new Error("the database is down");
    });

    try {
        assert.equal(juris.renderToString({ div: { children: [{ Bad: {} }] } }), "<div></div>");
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(said.length, 1);
        assert.match(String(said[0][0]), /component "Bad": its async definition rejected/);
        assert.equal(said[0][1].message, "the database is down");
    } finally {
        console.error = original;
    }
});

test("an async definition that resolves says nothing more", async () => {
    const juris = server();
    const said = [];
    const original = console.error;
    console.error = (...args) => said.push(args);
    juris.registerComponent("Lazy", async () => ({ p: "loaded" }));

    try {
        juris.renderToString({ Lazy: {} });
        await new Promise((resolve) => setImmediate(resolve));

        assert.deepEqual(said, []);
    } finally {
        console.error = original;
    }
});

test("an async definition flags the traced render: the page has a hole a cache must not store", () => {
    const juris = server();
    juris.registerComponent("Lazy", async () => ({ p: "loaded" }));

    juris.renderToString({ Lazy: {} }, null, { trace: true });

    assert.deepEqual(juris.renderTrace().flags, ["unresolved"]);
});
