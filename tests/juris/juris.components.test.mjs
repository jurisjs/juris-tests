// juris.js, components (REFERENCE.md, "The component api" Lifecycle and Drawing, "Local state",
// "juris.js"): a component's life (onCleanup, onMount, onError and the boundaries they make), local
// state (useState) on the server and in the browser, the drawing methods the instance hands to the
// DOM renderer (render, mount, enhance, unenhance, disposeTree, componentInstances), and devMode's
// inspection (componentTree, findComponents, onTreeChange) and its warning about unread getter props.
// Browser work is drawn into the stand-in DOM of tests/support/dom.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import { serialize } from "../support/dom.mjs";
import { tick, capture, withDom, container } from "../support/juris-harness.mjs";
import { withSSR } from "../support/ssr-renderer.mjs";

const server = (options = {}) => new Juris(withSSR({ isServer: true, ...options }));
const browser = (options = {}) => new Juris({ isServer: false, ...options });

// ---- the setup context ----------------------------------------------------------------------------

test("the lifecycle methods are valid during a definition only", () => {
    const { api } = server();
    assert.throws(() => api.onCleanup(() => { }), { message: "Juris.onCleanup: must be called during component setup" });
    assert.throws(() => api.onMount(() => { }), { message: "Juris.onMount: must be called during component setup" });
    assert.throws(() => api.onError(() => { }), { message: "Juris.onError: must be called during component setup" });
    assert.throws(() => api.useState("open", false), { message: "Juris.useState: must be called during component setup" });
});

test("onMount and onError take a function", () => {
    const juris = server();
    juris.registerComponent("BadMount", (props, api) => { api.onMount("later"); return { p: "x" }; });
    juris.registerComponent("BadError", (props, api) => { api.onError(null); return { p: "x" }; });
    assert.throws(() => juris.renderToString({ BadMount: {} }), { message: "Juris.onMount: handler must be a function" });
    assert.throws(() => juris.renderToString({ BadError: {} }), { message: "Juris.onError: handler must be a function" });
});

test("useState takes a non-empty string key", () => {
    const juris = server();
    juris.registerComponent("C", (props, api) => { api.useState(props.key ?? "", 0); return { p: "x" }; });
    assert.throws(() => juris.renderToString({ C: {} }), { message: "Juris.useState: key must be a non-empty string" });
});

test("a definition is handed its props and the api, and the setup context ends with it", () => {
    const juris = server();
    const handed = [];
    juris.registerComponent("Card", (props, api) => { handed.push([props, api === juris.api]); return { p: props.title }; });
    assert.equal(juris.renderToString({ Card: { title: "Hi" } }), "<p>Hi</p>");
    assert.deepEqual(handed, [[{ title: "Hi" }, true]]);
    assert.deepEqual(juris.componentStack, []);
});

test("the setup context ends even when the definition throws", () => {
    const juris = server();
    juris.registerComponent("Bad", () => { throw new Error("setup"); });
    assert.throws(() => juris.renderToString({ Bad: {} }), { message: "setup" });
    assert.deepEqual(juris.componentStack, []);
    assert.throws(() => juris.api.onCleanup(() => { }), /must be called during component setup/);
});

// ---- on a server: cleanups, and no mounts ------------------------------------------------------------

test("on a server, cleanups run when the render ends, innermost first, and onMount never runs", () => {
    const juris = server();
    const log = [];
    juris.registerComponent("Inner", (props, api) => {
        api.onCleanup(() => log.push("inner cleanup"));
        api.onMount(() => log.push("inner mount"));
        return { span: "in" };
    });
    juris.registerComponent("Outer", (props, api) => {
        api.onCleanup(() => log.push("outer cleanup"));
        return { div: { children: [{ Inner: {} }] } };
    });
    assert.equal(juris.renderToString({ Outer: {} }), "<div><span>in</span></div>");
    assert.deepEqual(log, ["inner cleanup", "outer cleanup"]);
});

// ---- error boundaries on a server ----------------------------------------------------------------------

test("a boundary is told a setup failure inside it, and its layout is drawn in its place", () => {
    const juris = server();
    const told = [];
    juris.registerComponent("Broken", () => { throw new Error("no data"); });
    juris.registerComponent("Panel", (props, api) => {
        api.onError((error, info) => { told.push([error.message, info]); return { p: "Sorry" }; });
        return { section: { children: [{ Broken: {} }] } };
    });
    assert.equal(juris.renderToString({ div: { children: [{ Panel: {} }] } }), "<div><p>Sorry</p></div>");
    assert.deepEqual(told, [["no data", { phase: "setup", component: "Broken", boundary: "Panel" }]]);
});

test("a boundary that answers undefined swallows the error: the failing part draws nothing", () => {
    const juris = server();
    juris.registerComponent("Broken", () => { throw new Error("x"); });
    juris.registerComponent("Panel", (props, api) => {
        api.onError(() => undefined);
        return { section: { children: [{ Broken: {} }, { p: "rest" }] } };
    });
    assert.equal(juris.renderToString({ Panel: {} }), "<section><p>rest</p></section>");
});

test("a boundary that answers false passes the error to the next one out", () => {
    const juris = server();
    const asked = [];
    juris.registerComponent("Broken", () => { throw new Error("x"); });
    juris.registerComponent("Middle", () => ({ div: { children: [{ Broken: {} }] } }));
    juris.registerComponent("Inner", (props, api) => {
        api.onError(() => { asked.push("Inner"); return false; });
        return { div: { children: [{ Middle: {} }] } };
    });
    juris.registerComponent("Outer", (props, api) => {
        api.onError(() => { asked.push("Outer"); return { p: "outer fallback" }; });
        return { main: { children: [{ Inner: {} }] } };
    });
    assert.equal(juris.renderToString({ Outer: {} }), "<p>outer fallback</p>");
    assert.deepEqual(asked, ["Inner", "Outer"]);
});

test("an error no boundary takes is thrown out of the render", () => {
    const juris = server();
    juris.registerComponent("Broken", () => { throw new Error("unhandled"); });
    juris.registerComponent("Panel", (props, api) => { api.onError(() => false); return { div: { children: [{ Broken: {} }] } }; });
    assert.throws(() => juris.renderToString({ Panel: {} }), { message: "unhandled" });
});

test("a binding failure is offered with the phase binding", () => {
    const juris = server();
    const told = [];
    juris.registerComponent("Panel", (props, api) => {
        api.onError((error, info) => { told.push(info.phase); return { p: "fallback" }; });
        return { div: { textContent: () => { throw new Error("x"); } } };
    });
    assert.equal(juris.renderToString({ Panel: {} }), "<p>fallback</p>");
    assert.deepEqual(told, ["binding"]);
});

// ---- the browser: render, mount, lifecycle --------------------------------------------------------------

test("render appends a layout's element to its target and answers it", async () => {
    await withDom(() => {
        const juris = browser();
        const target = container();
        const element = juris.api.render(target, { p: "hello" });
        assert.equal(element.parentNode, target);
        assert.equal(serialize(target), "<div><p>hello</p></div>");
        juris.render(target, { p: "again" });
        assert.equal(serialize(target), "<div><p>hello</p><p>again</p></div>");
    });
});

test("mount replaces the target's content and drops the transfer, unless told not to", async () => {
    await withDom(() => {
        const juris = browser();
        const target = container();
        juris.render(target, { p: "server markup" });
        juris.clearState({ $ssr: { calls: { "a:[]": 1 } } });
        juris.mount(target, { p: "kept" }, { release: false });
        assert.equal(serialize(target), "<div><p>kept</p></div>");
        assert.deepEqual(juris.stateManager.peek("$ssr"), { calls: { "a:[]": 1 } });
        juris.api.mount(target, { p: "booted" });
        assert.equal(serialize(target), "<div><p>booted</p></div>");
        assert.equal(juris.stateManager.peek("$ssr"), undefined);
    });
});

test("mount draws in the namespace it is given", async () => {
    await withDom(() => {
        const juris = browser();
        const target = container();
        const circle = juris.mount(target, { circle: { r: 2 } }, { namespace: "http://www.w3.org/2000/svg" });
        assert.equal(circle.namespaceURI, "http://www.w3.org/2000/svg");
    });
});

test("onMount runs with the root once it is in its parent; its returned function and onCleanup run on disposal", async () => {
    await withDom(() => {
        const juris = browser();
        const log = [];
        juris.registerComponent("Widget", (props, api) => {
            api.onMount((root) => {
                log.push(["mount", root.localName, root.parentNode !== null]);
                return () => log.push("mount's cleanup");
            });
            api.onCleanup(() => log.push("cleanup"));
            return { section: "x" };
        });
        const target = container();
        const root = juris.render(target, { Widget: {} });
        assert.deepEqual(log, [["mount", "section", true]]);
        assert.deepEqual(juris.componentInstances.get(root).map((instance) => instance.name), ["Widget"]);
        juris.api.disposeTree(root);
        assert.deepEqual(log.slice(1).sort(), ["cleanup", "mount's cleanup"]);
    });
});

test("enhance gives an existing element a layout, and unenhance takes it back", async () => {
    await withDom(() => {
        const juris = browser({ state: { count: 1 } });
        const element = container();
        const cleaned = [];
        juris.api.enhance(element, (api) => {
            api.onCleanup(() => cleaned.push(api.element === element));
            return { textContent: () => `count ${api.getState("count")}` };
        });
        assert.equal(element.textContent, "count 1");
        juris.setValue("count", 2);
        assert.equal(element.textContent, "count 2");
        juris.api.unenhance(element);
        assert.deepEqual(cleaned, [true]);
        juris.setValue("count", 3);
        assert.equal(element.textContent, "count 2", "no longer bound");
    });
});

// ---- the browser: error boundaries --------------------------------------------------------------------------

test("a boundary that has finished mounting swaps its root for the fallback when a binding fails later", async () => {
    await withDom(() => {
        const juris = browser({ state: { bad: false } });
        juris.registerComponent("Panel", (props, api) => {
            api.onError(() => ({ p: "fallback" }));
            return { div: { textContent: () => { if (api.getState("bad")) throw new Error("x"); return "ok"; } } };
        });
        const target = container();
        juris.render(target, { Panel: {} });
        assert.equal(serialize(target), "<div><div>ok</div></div>");
        juris.setValue("bad", true);
        assert.equal(serialize(target), "<div><p>fallback</p></div>");
    });
});

test("a boundary's fallback replaces its root when a binding's promise rejects", async () => {
    await withDom(async () => {
        const juris = browser({ pendingDelay: 0 });
        const told = [];
        let reject;
        juris.registerComponent("Panel", (props, api) => {
            api.onError((error, info) => { told.push([error.message, info.phase]); return { p: "could not load" }; });
            return { div: { textContent: () => new Promise((_, r) => { reject = r; }) } };
        });
        const target = container();
        juris.render(target, { Panel: {} });
        reject(new Error("down"));
        await tick();
        assert.equal(serialize(target), "<div><p>could not load</p></div>");
        assert.deepEqual(told, [["down", "async"]]);
    });
});

test("a boundary still mounting draws its fallback when a part drawn by one of its bindings fails", async () => {
    await withDom(() => {
        const juris = browser();
        juris.registerComponent("Broken", () => { throw new Error("x"); });
        juris.registerComponent("Panel", (props, api) => {
            api.onError(() => ({ p: "fallback" }));
            return { div: { children: () => [{ Broken: {} }] } };
        });
        const target = container();
        juris.render(target, { Panel: {} });
        assert.equal(serialize(target), "<div><p>fallback</p></div>");
    });
});

test("a binding whose first run fails into a boundary still mounting is dropped with the draw it was in", async () => {
    await withDom(() => {
        const juris = browser({ state: { n: 0 } });
        let runs = 0;
        juris.registerComponent("Panel", (props, api) => {
            api.onError(() => ({ p: "fallback" }));
            return { div: { textContent: () => { runs += 1; api.getState("n"); throw new Error("x"); } } };
        });
        const target = container();
        juris.render(target, { Panel: {} });
        assert.equal(serialize(target), "<div><p>fallback</p></div>");
        assert.equal(juris.stateManager.subscribers.has("n"), false, "the failed binding holds no subscription");
        juris.setValue("n", 1);
        assert.equal(runs, 1, "the write woke the failed binding");
        assert.equal(serialize(target), "<div><p>fallback</p></div>");
    });
});

test("a binding whose first run throws an error no boundary takes is dropped as the error leaves the render", async () => {
    await withDom(() => {
        const juris = browser({ state: { n: 0 } });
        let runs = 0;
        const target = container();
        assert.throws(() => juris.render(target, { div: { textContent: () => { runs += 1; juris.getState("n"); throw new Error("plain"); } } }), { message: "plain" });
        assert.equal(juris.stateManager.subscribers.has("n"), false, "the failed binding holds no subscription");
        juris.setValue("n", 1);
        assert.equal(runs, 1, "the write woke the failed binding");
    });
});

test("an adopted boundary drops a binding whose first run failed into it, as a rendered one does", async () => {
    await withDom(() => {
        const juris = browser({ state: { n: 0 } });
        let runs = 0;
        juris.registerComponent("Panel", (props, api) => {
            api.onError(() => ({ div: { textContent: "fallback" } }));
            return { div: { textContent: () => { runs += 1; api.getState("n"); throw new Error("x"); } } };
        });
        const element = container();
        juris.api.enhance(element, { Panel: {} });
        assert.equal(serialize(element), "<div>fallback</div>");
        assert.equal(juris.stateManager.subscribers.has("n"), false, "the failed binding holds no subscription");
        juris.setValue("n", 1);
        assert.equal(runs, 1, "the write woke the failed binding");
        assert.equal(serialize(element), "<div>fallback</div>");
    });
});

// ---- local state on a server --------------------------------------------------------------------------------

test("useState slots are numbered per component in render order, and nothing is written until set", async () => {
    const juris = server();
    const paths = [];
    juris.registerComponent("Row", (props, api) => {
        const [open, setOpen] = api.useState("open", false);
        const [count] = api.useState("count", 0);
        paths.push(open.path, count.path);
        if (props.toggle) setOpen(true);
        return { li: () => `${open()}:${count()}` };
    });
    const { html, json } = await juris.renderRequest({ layout: { ul: { children: [{ Row: {} }, { Row: { toggle: true } }] } } });
    assert.deepEqual(paths, ["$local.Row.0.open", "$local.Row.0.count", "$local.Row.1.open", "$local.Row.1.count"]);
    assert.equal(html, "<ul><li>false:0</li><li>true:0</li></ul>");
    assert.deepEqual(JSON.parse(json).$local, { Row: { 1: { open: true } } }, "only the written value travels");
});

test("set takes a value or an updater, which is handed the current value or the initial", async () => {
    const juris = server();
    juris.registerComponent("Counter", (props, api) => {
        const [count, setCount] = api.useState("count", 10);
        setCount((n) => n + 1);
        setCount((n) => n * 2);
        return { p: () => String(count()) };
    });
    const { html } = await juris.renderRequest({ layout: { Counter: {} } });
    assert.equal(html, "<p>22</p>");
});

test("the server keeps its slots for the page, and clearState restarts the numbering", async () => {
    const juris = server();
    const paths = [];
    juris.registerComponent("Row", (props, api) => {
        const [get, set] = api.useState("seen", false);
        paths.push(get.path);
        set(true);
        return { li: "x" };
    });
    const first = await juris.renderRequest({ layout: { Row: {} } });
    const second = await juris.renderRequest({ layout: { Row: {} } });
    assert.deepEqual(paths, ["$local.Row.0.seen", "$local.Row.0.seen"]);
    assert.deepEqual(JSON.parse(first.json).$local, { Row: { 0: { seen: true } } });
    assert.deepEqual(JSON.parse(second.json).$local, { Row: { 0: { seen: true } } });
});

test("localPath renames the root local state lives under", async () => {
    const juris = server({ localPath: "$mine" });
    juris.registerComponent("Row", (props, api) => {
        const [get, set] = api.useState("open", false);
        set(true);
        return { li: get.path };
    });
    assert.equal((await juris.renderRequest({ layout: { Row: {} } })).html, "<li>$mine.Row.0.open</li>");
});

test("the browser adopts the server's local values for the same layout", async () => {
    const page = server();
    const define = (juris) => juris.registerComponent("Toggle", (props, api) => {
        const [on, setOn] = api.useState("on", false);
        if (api.isServer) setOn(true);
        return { button: () => (on() ? "on" : "off") };
    });
    define(page);
    const { html, json } = await page.renderRequest({ layout: { Toggle: {} } });
    assert.equal(html, "<button>on</button>");
    await withDom(() => {
        const juris = browser();
        define(juris);
        juris.clearState(JSON.parse(json));
        const target = container();
        juris.mount(target, { Toggle: {} });
        assert.equal(serialize(target), "<div><button>on</button></div>");
    });
});

// ---- local state in the browser ---------------------------------------------------------------------------------

test("a disposed instance's local state is deleted", async () => {
    await withDom(async () => {
        const juris = browser();
        let set;
        juris.registerComponent("Counter", (props, api) => {
            const [count, setCount] = api.useState("count", 0);
            set = setCount;
            return { button: () => String(count()) };
        });
        const target = container();
        const root = juris.render(target, { Counter: {} });
        set(5);
        assert.equal(juris.stateManager.peek("$local.Counter.0.count"), 5);
        juris.disposeTree(root);
        await tick();
        assert.equal(juris.stateManager.peek("$local.Counter.0"), undefined);
    });
});

test("a disposed instance that never wrote its local state leaves nothing to delete", async () => {
    await withDom(async () => {
        const changes = [];
        const juris = browser({ onChange: (path) => changes.push(path) });
        juris.registerComponent("Quiet", (props, api) => { api.useState("x", 1); return { i: "q" }; });
        const root = juris.render(container(), { Quiet: {} });
        changes.length = 0;
        juris.disposeTree(root);
        await tick();
        assert.deepEqual(changes, []);
    });
});

test("a component re-invoked into the same root with the same key keeps its local state", async () => {
    await withDom(async () => {
        const juris = browser({ state: { label: "a" } });
        let set;
        juris.registerComponent("Counter", (props, api) => {
            const [count, setCount] = api.useState("count", 0);
            set = setCount;
            return { button: () => `${props.label}:${count()}` };
        });
        juris.registerComponent("Page", (props, api) => () => ({ Counter: { key: "k", label: api.getState("label") } }));
        const target = container();
        juris.render(target, { Page: {} });
        set(5);
        juris.setValue("label", "b");
        await tick();
        assert.equal(serialize(target), "<div><button>b:5</button></div>");
        assert.deepEqual(juris.toRaw(juris.stateManager.peek("$local.Counter")), { 0: { count: 5 } });
    });
});

test("one component's local writes never wake another component's bindings", async () => {
    await withDom(() => {
        const juris = browser();
        const setters = [];
        const runs = [0, 0];
        juris.registerComponent("Counter", (props, api) => {
            const [count, setCount] = api.useState("count", 0);
            setters.push(setCount);
            return { button: () => { runs[props.n] += 1; return String(count()); } };
        });
        const target = container();
        juris.render(target, { div: { children: [{ Counter: { n: 0 } }, { Counter: { n: 1 } }] } });
        assert.deepEqual(runs, [1, 1]);
        setters[0](7);
        assert.deepEqual(runs, [2, 1]);
        assert.equal(serialize(target), "<div><div><button>7</button><button>0</button></div></div>");
    });
});

test("Await hides its children rather than unmounting them, so they are set up once while the group toggles", async () => {
    await withDom(async () => {
        const juris = browser({ pendingDelay: 0 });
        let setups = 0;
        juris.registerComponent("Rows", () => { setups += 1; return { ul: "rows" }; });
        const target = container();
        juris.render(target, { Await: { group: "panel", fallback: { p: "Loading" }, children: [{ Rows: {} }] } });
        assert.equal(serialize(target), "<div><div><div><ul>rows</ul></div></div></div>");
        let resolve;
        const loading = juris.api.group("panel").track(new Promise((r) => { resolve = r; }));
        assert.equal(serialize(target), '<div><div><p>Loading</p><div hidden=""><ul>rows</ul></div></div></div>');
        resolve();
        await loading;
        assert.equal(serialize(target), "<div><div><div><ul>rows</ul></div></div></div>");
        assert.equal(setups, 1);
    });
});

test("a client-only component opens its own numbering, so a component elsewhere keeps the server's slot", async () => {
    await withDom(() => {
        const juris = browser();
        juris.registerComponent("Row", (props, api) => { const [get] = api.useState("open", false); return { li: get.path }; });
        juris.registerComponent("Map", (props, api) => {
            const [zoom] = api.useState("zoom", 1);
            return { ul: { children: [{ Row: {} }, { li: zoom.path }] } };
        }, { ssr: false });
        const target = container();
        juris.render(target, { div: { children: [{ Map: {} }, { Row: {} }, { Map: {} }] } });
        const texts = serialize(target).match(/<li>[^<]*<\/li>/g);
        assert.deepEqual(texts, [
            "<li>$local.$client.Map.0.Row.0.open</li>",
            "<li>$local.$client.Map.0.Map.0.zoom</li>",
            "<li>$local.Row.0.open</li>",
            "<li>$local.$client.Map.1.Row.0.open</li>",
            "<li>$local.$client.Map.1.Map.0.zoom</li>",
        ]);
    });
});

test("clearState restarts the client-only numbering too", async () => {
    await withDom(() => {
        const juris = browser();
        juris.registerComponent("Map", (props, api) => { const [zoom] = api.useState("zoom", 1); return { p: zoom.path }; }, { ssr: false });
        juris.render(container(), { Map: {} });
        juris.clearState({});
        const target = container();
        juris.render(target, { Map: {} });
        assert.equal(serialize(target), "<div><p>$local.$client.Map.0.Map.0.zoom</p></div>");
    });
});

// ---- devMode inspection ---------------------------------------------------------------------------------------

test("devMode's componentTree shows the live instances with their props and local values", async () => {
    await withDom(() => {
        const juris = browser({ devMode: true });
        juris.registerComponent("Row", (props, api) => { api.useState("open", false); return { li: props.label }; });
        juris.registerComponent("List", () => ({ ul: { children: [{ Row: { key: "a", label: "A" } }, { Row: { key: "b", label: "B" } }] } }));
        const target = container();
        const root = juris.render(target, { List: {} });
        const [list] = juris.componentTree();
        assert.equal(list.name, "List");
        assert.equal(list.root, root);
        assert.deepEqual(list.children.map((row) => [row.name, row.key, row.props.label]), [["Row", "a", "A"], ["Row", "b", "B"]]);
        assert.deepEqual(list.children[0].local, { path: "$local.Row.0", values: { open: false } }, "an initial never written still shows");
        assert.deepEqual(juris.findComponents("Row").map((instance) => instance.props.key), ["a", "b"]);
        assert.deepEqual(juris.findComponents("List").length, 1);
    });
});

test("devMode's onTreeChange is told after every render pass that created or disposed an instance", async () => {
    await withDom(() => {
        const juris = browser({ devMode: true, state: { show: true } });
        juris.registerComponent("Card", () => ({ p: "card" }));
        const trees = [];
        const off = juris.onTreeChange((tree) => trees.push(tree.map((node) => node.name)));
        juris.render(container(), { div: { children: () => (juris.getState("show") ? [{ Card: {} }] : []) } });
        juris.setValue("show", false);
        off();
        juris.setValue("show", true);
        assert.deepEqual(trees, [["Card"], []]);
    });
});

test("without devMode the inspection methods refuse", () => {
    const juris = server();
    assert.throws(() => juris.componentTree(), /available in devMode only/);
    assert.throws(() => juris.findComponents("Card"), /available in devMode only/);
    assert.throws(() => juris.onTreeChange(() => { }), /available in devMode only/);
});

test("a server render is never in the devMode tree", () => {
    const juris = server({ devMode: true });
    juris.registerComponent("Card", () => ({ p: "card" }));
    juris.renderToString({ Card: {} });
    assert.deepEqual(juris.componentTree(), []);
});

test("devMode warns about a getter prop the component never called", async () => {
    await withDom(async () => {
        const juris = browser({ devMode: true, state: { n: 1 } });
        const handed = [];
        juris.registerComponent("Show", (props) => {
            handed.push(props);
            return { p: () => String(props.read()) };
        });
        const label = () => "unused";
        const read = () => juris.getState("n");
        const onPick = () => { };
        const said = await capture("warn", async () => {
            juris.render(container(), { Show: { label, read, onPick, plain: 1 } });
            await tick();
        });
        assert.deepEqual(said.map((args) => args[0]), ['Juris: component "Show" received getter prop "label" but never called it; read it with props.label() or api.prop(props.label) inside a binding']);
        assert.notEqual(handed[0].read, read, "the definition is handed a wrapped getter");
        assert.equal(handed[0].read(), 1, "which answers what the getter does");
        assert.equal(handed[0].onPick, onPick, "a callback is handed as it is");
        assert.equal(juris.findComponents("Show")[0].props.read, read, "the instance keeps the original props");
    });
});

test("devMode says nothing when every getter prop was read", async () => {
    await withDom(async () => {
        const juris = browser({ devMode: true, state: { t: "x" } });
        juris.registerComponent("Show", (props) => ({ p: () => props.text() }));
        const said = await capture("warn", async () => {
            juris.render(container(), { Show: { text: () => juris.getState("t"), count: 1 } });
            await tick();
        });
        assert.deepEqual(said, []);
    });
});
