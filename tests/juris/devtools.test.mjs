// devtools.js, the devtools feature: what it refuses, the registry on window and its event, the
// endpoint and its connections (drained, closed when idle, a full queue), and the protocol's
// requests but the timeline's (devtools.timeline.test.mjs) and the values' encoding
// (devtools.values.test.mjs): hello, the tree and its topic, components, a node's bindings, a
// binding, wakes, preloads, highlight and pick. On the stand-in DOM, in a page of
// support/devtools-page.mjs. Held to REFERENCE.md ("devtools.js").
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, readdir, copyFile, rm } from "node:fs/promises";
import Juris from "juris/juris.js";
import { Devtools, PROTOCOL } from "juris/devtools.js";
import { FakeElement, FakeNode } from "../support/dom.mjs";
import { HTML } from "../fixtures/elements.mjs";
import { devtoolsPage, withDevtoolsPage, inspect, quietInfo, host } from "../support/devtools-page.mjs";
import { withGlobals, quiet } from "../support/remote-services-fakes.mjs";

const VERSION = (await import("juris/package.json", { with: { type: "json" } })).default.version;

// ---- what it refuses -----------------------------------------------------------------------------

test("the feature refuses an instance without devMode, and a server instance", () => {
    assert.throws(() => new Juris({ isServer: false, features: { devtools: Devtools } }), {
        name: "TypeError", message: "Devtools: the devtools feature is for an instance in devMode (new Juris({ devMode: true }))",
    });
    assert.throws(() => new Juris({ isServer: true, devMode: true, features: { devtools: Devtools } }), {
        name: "TypeError", message: "Devtools: never on a server instance, which renders every request: nothing about it is one page's",
    });
    assert.throws(() => new Devtools(undefined), TypeError);
});

// ---- the registry ---------------------------------------------------------------------------------

test("the first instance defines the registry; each registration dispatches juris:devtools; list() names them", () => withDevtoolsPage(devtoolsPage(), async ({ window, registered }) => {
    const first = inspect();
    const second = inspect();
    const registry = window.__JURIS_DEVTOOLS__;
    assert.equal(registry.registry, 1);
    assert.deepEqual(registered, [{ id: first.juris.devIndex }, { id: second.juris.devIndex }]);
    assert.deepEqual(registry.list(), [
        { id: first.juris.devIndex, protocol: PROTOCOL, juris: VERSION, codeId: null, root: null },
        { id: second.juris.devIndex, protocol: PROTOCOL, juris: VERSION, codeId: null, root: null },
    ]);
    assert.equal(registry.get(first.juris.devIndex), first.endpoint);
    assert.equal(registry.get(second.juris.devIndex), second.endpoint);
    assert.equal(registry.get(-1), null);
    assert.equal(registry.get(String(first.juris.devIndex)), null, "an id is a number");
    // It is Juris's, not the page's to replace, and it is not enumerated with the page's globals.
    assert.ok(Object.isFrozen(registry));
    assert.throws(() => { "use strict"; window.__JURIS_DEVTOOLS__ = {}; }, TypeError);
    assert.ok(!Object.keys(window).includes("__JURIS_DEVTOOLS__"));
    // Mounting names the element it mounted into.
    first.juris.registerComponent("App", () => ({ p: "x" }));
    const root = host();
    root.setAttribute("id", "main");
    first.juris.mount(root, { App: {} });
    assert.equal(registry.list()[0].root, "main");
    first.done();
    second.done();
}));

// Another build's copy of the core, as a page that loaded two builds holds it: the same files under
// another address (a directory of their own, so this run's coverage is the package's alone).
async function secondCopy() {
    const from = path.dirname(fileURLToPath(import.meta.resolve("juris/juris.js")));
    const to = await mkdtemp(path.join(os.tmpdir(), "juris-second-copy-"));
    for (const file of (await readdir(from)).filter((name) => name.endsWith(".js"))) await copyFile(path.join(from, file), path.join(to, file));
    const load = (file) => import(pathToFileURL(path.join(to, file)).href);
    return { Juris: (await load("juris.js")).default, Devtools: (await load("devtools.js")).Devtools, remove: () => rm(to, { recursive: true, force: true }) };
}

test("two copies of the core and of devtools.js in one page register in one registry, under indexes neither shares", () => withDevtoolsPage(devtoolsPage(), async ({ window, registered }) => {
    const copy = await secondCopy();
    const { Juris: OtherJuris, Devtools: OtherDevtools } = copy;
    assert.notEqual(OtherJuris, Juris);
    assert.notEqual(OtherDevtools, Devtools);
    // The other copy counts its instances from 1, as this one did: what is taken is skipped. It
    // registers first here, so its copy of devtools.js defines the registry, and this one's joins it.
    window.$juris = { 1: "taken by another copy", 2: "taken by another copy" };
    const theirs = quietInfo(() => new OtherJuris({ isServer: false, devMode: true, features: { devtools: OtherDevtools } }));
    const ours = inspect();
    assert.equal(theirs.devIndex, 3);
    assert.notEqual(ours.juris.devIndex, theirs.devIndex);
    assert.equal(window.$juris[theirs.devIndex], theirs);
    assert.equal(window.$juris[ours.juris.devIndex], ours.juris);
    assert.deepEqual(window.__JURIS_DEVTOOLS__.list().map((entry) => entry.id), [theirs.devIndex, ours.juris.devIndex]);
    assert.equal(window.__JURIS_DEVTOOLS__.get(theirs.devIndex), theirs.devtools.endpoint);
    assert.equal(window.__JURIS_DEVTOOLS__.get(ours.juris.devIndex), ours.endpoint);
    assert.deepEqual(registered.map((detail) => detail.id), [theirs.devIndex, ours.juris.devIndex]);
    ours.done();
    await copy.remove();
}));

test("a registry of another shape is left alone, and the console says the instance could not register", () => withDevtoolsPage(devtoolsPage(), async ({ window, registered }) => {
    const other = { registry: 2, list: () => ["theirs"] };
    window.__JURIS_DEVTOOLS__ = other;
    const said = await quiet("warn", () => {
        const { juris, done } = inspect();
        assert.match(String(juris.devIndex), /^\d+$/);
        done();
    });
    assert.equal(window.__JURIS_DEVTOOLS__, other);
    assert.deepEqual(other.list(), ["theirs"]);
    assert.deepEqual(registered, []);
    assert.equal(said.length, 1);
    assert.match(said[0][0], /^Juris: window\.__JURIS_DEVTOOLS__ is not a registry this version knows \(registry 2\), so window\.\$juris\[\d+\] could not register for devtools$/);
    window.__JURIS_DEVTOOLS__ = null;
    const again = await quiet("warn", () => inspect().done());
    assert.match(again[0][0], /\(registry undefined\)/);
}));

test("with no window nothing is registered, and the endpoint still answers", () => withGlobals({ window: undefined, document: undefined }, () => {
    const { juris, ask, done } = inspect();
    assert.equal(juris.devIndex, undefined);
    assert.equal(ask("hello").id, null);
    assert.equal(ask("hello").dev, null, "no document: no #juris-dev");
    done();
}));

// ---- hello, and what a request answers ----------------------------------------------------------

test("hello: the protocol, the core's version, the code id, the instance, whether it mounted, the dev channel, the topics", () => withDevtoolsPage(devtoolsPage({ scripts: [["state", "{}"], ["juris-dev", '{"render":"r1"}']] }), () => {
    const { juris, ask, done } = inspect();
    assert.deepEqual(ask("hello"), { protocol: 1, juris: VERSION, codeId: null, id: juris.devIndex, mounted: false, dev: { render: "r1" }, topics: ["tree", "timeline"], privateRoots: ["$server"] });
    juris.registerComponent("App", () => ({ p: "x" }));
    juris.mount(host(), { App: {} });
    juris.mount(host(), { App: {} });
    assert.equal(ask("hello").mounted, true);
    done();
}));

test("hello: the private roots, by name only, whose paths every answer counts and never lists; the async root is not one", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, ask, done } = inspect({ privatePaths: ["vault", "keys"], state: { vault: { secret: "s" } } });
    assert.deepEqual(ask("hello").privateRoots, ["$server", "vault", "keys"]);
    assert.ok(!JSON.stringify(ask("hello")).includes('"s"'));
    assert.ok(juris.privatePaths.has("$async"), "private on the server, read like the rest in the browser");
    done();
}));

test("hello: #juris-dev without a render id, or not JSON, is a dev channel with no render; none, null", async () => {
    for (const [text, dev] of [["{}", { render: null }], ['{"render":5}', { render: null }], ["not json", { render: null }], ["null", { render: null }]]) {
        await withDevtoolsPage(devtoolsPage({ scripts: [["juris-dev", text]] }), () => {
            const { ask, done } = inspect();
            assert.deepEqual(ask("hello").dev, dev, text);
            done();
        });
    }
    await withDevtoolsPage(devtoolsPage({ scripts: [["state", "{}"]] }), () => {
        const { ask, done } = inspect();
        assert.equal(ask("hello").dev, null);
        done();
    });
});

test("a request that cannot be answered says why, with a code: unknown-method, no-connection, bad-params, failed", () => withDevtoolsPage(devtoolsPage(), () => {
    const { endpoint, connection, answer, done } = inspect();
    for (const method of ["nothing", "toString", "__proto__", "constructor", 5, undefined]) {
        assert.equal(answer(method).error.code, "unknown-method", String(method));
    }
    assert.equal(answer("nothing").error.message, '"nothing" is not a method of protocol 1');
    assert.deepEqual(endpoint.request("c-unknown", "hello"), { ok: false, error: { code: "no-connection", message: 'no connection "c-unknown": connect() again' } });
    for (const [method, params] of [
        ["subscribe", { topic: "nothing" }], ["subscribe", {}], ["unsubscribe", { topic: "live" }], ["components", { name: 5 }],
        ["wakes", {}], ["passes", { since: "1" }], ["pick", { on: "yes" }], ["node", { node: "div" }], ["node", { node: { $: "node" } }], ["node", {}],
        ["state", { path: 5 }], ["state", { path: "a.__proto__" }], ["state", { depth: 9 }], ["state", { depth: -1 }], ["state", { depth: 1.5 }],
        ["state", { from: -1 }], ["state", { count: 0 }], ["state", { count: 1001 }],
    ]) {
        assert.equal(answer(method, params).error.code, "bad-params", `${method} ${JSON.stringify(params)}`);
    }
    // Params that are not an object are none.
    assert.equal(answer("subscribe", "tree").error.code, "bad-params");
    assert.equal(answer("hello", null).ok, true);
    assert.equal(typeof connection, "string");
    done();
    // Anything else that goes wrong is answered, not thrown at the panel.
    const odd = inspect({ state: { odd: new Proxy({}, { ownKeys() { throw new Error("a trap of the page's own"); } }) } });
    assert.deepEqual(odd.answer("state", { path: "odd" }), { ok: false, error: { code: "failed", message: "a trap of the page's own" } });
    odd.done();
}));

// ---- connections ----------------------------------------------------------------------------------

test("connections: each has its own id and queue; drain answers what happened since, oldest first; disconnect ends it", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, endpoint } = inspect();
    const a = endpoint.connect();
    const b = endpoint.connect();
    assert.match(a, /^c\d+$/);
    assert.notEqual(a, b);
    endpoint.request(a, "subscribe", { topic: "timeline" });
    juris.setValue("x", 1);
    juris.setValue("x", 2);
    const drained = endpoint.drain(a);
    assert.deepEqual(drained.events.map((event) => event.type), ["pass", "pass"]);
    assert.ok(drained.events[0].id < drained.events[1].id);
    assert.equal(drained.dropped, 0);
    assert.equal(drained.more, undefined);
    assert.deepEqual(endpoint.drain(a), { events: [], dropped: 0 });
    assert.deepEqual(endpoint.drain(b), { events: [], dropped: 0 }, "b subscribed to nothing");
    assert.equal(endpoint.disconnect(a), true);
    assert.equal(endpoint.disconnect(a), false);
    assert.deepEqual(endpoint.drain(a), { events: [], dropped: 0, closed: true });
    assert.equal(endpoint.request(a, "hello").error.code, "no-connection");
    assert.equal(juris.stateManager.observers.size, 0, "its timeline went with it");
    endpoint.disconnect(b);
}));

test("a connection not drained for 30 s is closed, and its timeline with it", () => withDevtoolsPage(devtoolsPage(), () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const { juris, endpoint, connection, ask } = inspect();
        ask("subscribe", { topic: "timeline" });
        assert.equal(juris.stateManager.observers.size, 1);
        mock.timers.tick(29_999);
        assert.equal(endpoint.drain(connection).closed, undefined, "still open; and drained, so it starts over");
        mock.timers.tick(29_999);
        assert.equal(endpoint.request(connection, "hello").ok, true, "a request is not a drain");
        mock.timers.tick(1);
        assert.equal(endpoint.request(connection, "hello").error.code, "no-connection");
        assert.equal(juris.stateManager.observers.size, 0);
    } finally {
        mock.timers.reset();
    }
}));

test("a full queue (2,000) pushes the oldest out and counts them in dropped", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, ask, drain, done } = inspect();
    ask("subscribe", { topic: "timeline" });
    for (let i = 0; i < 2100; i += 1) juris.setValue("n", i);
    const first = drain();
    assert.equal(first.dropped, 100);
    assert.equal(first.events.length, 2000);
    assert.equal(first.events[0].writes[0].value, 100, "the oldest went");
    assert.equal(drain().dropped, 0, "counted once");
    done();
}));

test("a drain stops at 1 MiB of JSON, says there is more, and leaves the rest queued", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, ask, drain, done } = inspect();
    ask("subscribe", { topic: "timeline" });
    const big = "x".repeat(900);
    for (let pass = 0; pass < 16; pass += 1) juris.batch(() => { for (let i = 0; i < 50; i += 1) juris.setValue(`big.${i}`, `${big}${pass}`); });
    const first = drain();
    assert.equal(first.more, true);
    assert.ok(first.events.length > 0 && first.events.length < 16);
    assert.ok(JSON.stringify(first.events).length <= 1024 * 1024);
    const rest = drain();
    assert.equal(first.events.length + rest.events.length, 16);
    assert.equal(rest.more, undefined);
    done();
}));

// ---- the tree, components -------------------------------------------------------------------------

function shop(juris) {
    juris.registerComponent("Shelf", (props, api) => {
        const [open] = api.useState("open", true);
        return { ul: { children: () => api.getState("items", []).map((item) => ({ Item: { key: item.id, name: item.name } })), hidden: () => !open(), title: () => api.prop(props.label, "") } };
    });
    juris.registerComponent("Item", (props, api) => ({ li: { textContent: () => api.prop(props.name) } }));
    juris.setValue("items", [{ id: "a", name: "Apple" }, { id: "b", name: "Bread" }]);
}

test("tree: every component, depth first, as TreeNodes; components finds them by name; component answers one", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, ask, refusal, done } = inspect();
    shop(juris);
    const root = host();
    juris.render(root, { Shelf: { title: "Fruit", onPick: () => { }, label: () => "getter", where: juris.ref("items.0.name") } });
    const tree = ask("tree");
    const [shelf] = juris.findComponents("Shelf");
    const items = juris.findComponents("Item");
    assert.deepEqual(tree.map(({ name, parent, key }) => [name, parent, key]), [["Shelf", null, { $: "undefined" }], ["Item", shelf.id, "a"], ["Item", shelf.id, "b"]]);
    assert.deepEqual(tree[0], { id: shelf.id, name: "Shelf", key: { $: "undefined" }, parent: null, root: tree[0].root, adopted: false });
    assert.equal(tree[0].root.tag, "ul");
    assert.deepEqual(ask("components", { name: "Item" }), items.map((item) => item.id));
    assert.deepEqual(ask("components", { name: "Nothing" }), []);

    const component = ask("component", { id: shelf.id });
    assert.deepEqual(component.props, {
        title: "Fruit",
        onPick: { $: "function", name: "onPick", kind: "listener" },
        label: { $: "function", name: "label", kind: "getter" },
        where: { $: "ref", path: "items.0.name" },
    });
    assert.deepEqual(component.local, { path: shelf.local, values: { open: true } });
    assert.deepEqual(component.children, items.map((item) => item.id));
    assert.equal(component.bindings.length, 3, "its ul's hidden, title and children");
    assert.deepEqual(ask("component", { id: items[0].id }).local, null);
    assert.equal(ask("component", { id: items[0].id }).bindings.length, 1);
    for (const id of [-1, "1", undefined]) assert.equal(refusal("component", { id }), "no-such-component", String(id));
    done();
}));

test("the tree topic: sent at the next frame after a draw that created or disposed a component, once for several", () => withDevtoolsPage(devtoolsPage(), (page) => {
    const { juris, ask, events, done } = inspect();
    shop(juris);
    ask("subscribe", { topic: "tree" });
    assert.deepEqual(ask("subscribe", { topic: "tree" }), { topic: "tree" }, "twice is once");
    const root = host();
    juris.render(root, { Shelf: {} });
    juris.setValue("items", [{ id: "a", name: "Apple" }]);
    assert.deepEqual(events(), [], "nothing before the frame");
    page.runFrames();
    const sent = events();
    assert.deepEqual(sent.map((event) => event.type), ["tree"]);
    assert.deepEqual(sent[0].nodes.map((node) => node.name), ["Shelf", "Item"]);
    assert.equal(typeof sent[0].at, "number");
    juris.setValue("other", 1);
    page.runFrames();
    assert.deepEqual(events(), [], "a pass that changed no component sends no tree");
    assert.deepEqual(ask("unsubscribe", { topic: "tree" }), { topic: "tree" });
    assert.deepEqual(ask("unsubscribe", { topic: "tree" }), { topic: "tree" }, "twice is once");
    assert.equal(juris.componentManager.inspectors.size, 0, "the watcher is gone");
    juris.setValue("items", []);
    page.runFrames();
    assert.deepEqual(events(), []);
    done();
}));

test("the tree topic's frame comes from a timer where there is no requestAnimationFrame", async () => {
    const page = devtoolsPage();
    await withGlobals({ document: page.document, window: page.window, Node: FakeNode, requestAnimationFrame: undefined }, async () => {
        const { juris, ask, events, done } = inspect();
        shop(juris);
        ask("subscribe", { topic: "tree" });
        juris.render(host(), { Shelf: {} });
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.deepEqual(events().map((event) => event.type), ["tree"]);
        done();
    });
});

// ---- a node's bindings, a binding, wakes --------------------------------------------------------------

test("node: the components it is the root of, the innermost whose root holds it, its bindings, by handle or by the node itself", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, ask, refusal, done } = inspect();
    shop(juris);
    juris.registerComponent("Frame", () => ({ Shelf: {} }));
    const root = host();
    juris.render(root, { Frame: {} });
    const [frame] = juris.findComponents("Frame");
    const [shelf] = juris.findComponents("Shelf");
    const ul = root.childNodes[0];
    const byNode = ask("node", { node: ul });
    assert.deepEqual(byNode.roots, [shelf.id, frame.id], "innermost first");
    assert.equal(byNode.owner, shelf.id);
    assert.deepEqual(byNode.bindings.map((binding) => binding.key), ["hidden", "title", "children"]);
    const byHandle = ask("node", { node: byNode.node });
    assert.deepEqual(byHandle, byNode);
    const li = ul.childNodes[0];
    const inner = ask("node", { node: li.childNodes[0] ?? li });
    assert.equal(inner.owner, juris.findComponents("Item")[0].id);
    assert.equal(ask("node", { node: host() }).owner, null);
    assert.deepEqual(ask("node", { node: host() }).bindings, []);
    assert.equal(refusal("node", { node: { $: "node", ref: 999_999 } }), "no-such-node");
    done();
}));

test("binding: one live binding, with the passes it ran in among those kept", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, ask, refusal, done } = inspect();
    juris.setValue("n", 1);
    const p = host();
    juris.render(p, { p: { title: () => String(juris.getState("n")) } });
    const [{ id }] = ask("node", { node: p.childNodes[0] }).bindings;
    assert.deepEqual(ask("binding", { id }).passes, [], "drawn outside any pass");
    juris.setValue("n", 2);
    ask("subscribe", { topic: "timeline" });
    juris.setValue("n", 3);
    juris.setValue("n", 4);
    const binding = ask("binding", { id });
    assert.equal(binding.passes.length, 2, "the two recorded, the last of which is its lastPass");
    assert.deepEqual(binding.passes.map((pass) => pass.changed), [["n"], ["n"]]);
    assert.equal(binding.lastPass, binding.passes[1].id);
    for (const missing of [0, "1", undefined]) assert.equal(refusal("binding", { id: missing }), "no-such-binding");
    done();
}));

test("a binding remembers the last 20 passes it ran in while the timeline records, and passes beyond the 200 kept are gone", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, ask, done } = inspect();
    juris.setValue("n", 0);
    const p = host();
    juris.render(p, { p: { title: () => String(juris.getState("n")) } });
    const [{ id }] = ask("node", { node: p.childNodes[0] }).bindings;
    ask("subscribe", { topic: "timeline" });
    for (let i = 1; i <= 25; i += 1) juris.setValue("n", i);
    assert.equal(ask("binding", { id }).passes.length, 20);
    ask("unsubscribe", { topic: "timeline" });
    for (let i = 0; i < 250; i += 1) juris.setValue("other", i);
    const binding = ask("binding", { id });
    assert.deepEqual(binding.passes, [], "none of them is kept any more");
    assert.equal(ask("passes").length, 200);
    assert.equal(ask("node", { node: p.childNodes[0] }).lastPass, null);
    done();
}));

test("wakes: what a write at a path wakes first, the computeds apart, each binding as node and binding describe it", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, ask, done } = inspect();
    juris.setValue("cart", { lines: [{ qty: 1 }, { qty: 2 }] });
    juris.compute("cart.total", () => juris.getState("cart.lines").reduce((sum, line) => sum + line.qty, 0));
    juris.compute("lineCount", () => 0, { watch: ["cart.lines.*.qty"] });
    const root = host();
    juris.render(root, { p: { title: () => String(juris.getState("cart.total")), textContent: () => String(juris.getState("cart.lines.1.qty")) } });
    const wakes = ask("wakes", { path: "cart.lines.1.qty" });
    assert.deepEqual(wakes.computeds.map((binding) => binding.path), ["cart.total", "lineCount"]);
    assert.deepEqual(wakes.computeds[1].reads, ["cart.lines.*.qty"]);
    assert.deepEqual(wakes.bindings.map((binding) => binding.key), ["textContent"]);
    assert.deepEqual(ask("wakes", { path: "cart.total" }).bindings.map((binding) => binding.key), ["title"]);
    assert.deepEqual(ask("wakes", { path: "nowhere" }), { computeds: [], bindings: [] });
    done();
}));

// ---- preloads -------------------------------------------------------------------------------------

test("preloads: the calls the page arrived with, the words of each failure, never an answer; kept after the mount releases them", () => withDevtoolsPage(devtoolsPage(), () => {
    const state = { $ssr: { calls: { 'items:["a"]': { secret: "the answer" }, "banner:[]": { $error: "request failed" } } } };
    const { juris, ask, done } = inspect({ state });
    const preloads = ask("preloads");
    assert.deepEqual(preloads, [
        { key: 'items:["a"]', service: "items", ok: true, message: null },
        { key: "banner:[]", service: "banner", ok: false, message: "request failed" },
    ]);
    assert.ok(!JSON.stringify(preloads).includes("the answer"));
    juris.registerComponent("App", () => ({ p: "x" }));
    juris.mount(host(), { App: {} });
    assert.equal(juris.stateManager.peek("$ssr"), undefined, "released");
    assert.deepEqual(ask("preloads"), preloads);
    done();
    const none = inspect();
    assert.deepEqual(none.ask("preloads"), []);
    none.done();
}));

// ---- highlight and pick --------------------------------------------------------------------------------

test("highlight: an outline over a node or a component's root, in a closed shadow root on the document element; {} takes it away", () => withDevtoolsPage(devtoolsPage(), (page) => {
    const { juris, ask, refusal, endpoint, done } = inspect();
    assert.deepEqual(ask("highlight", {}), {}, "nothing to take away yet");
    assert.equal(page.document.documentElement.childNodes.length, 0);
    shop(juris);
    const root = host();
    juris.render(root, { Shelf: {} });
    const ul = root.childNodes[0];
    ul.rect = { left: 10, top: 20, width: 300, height: 40 };
    assert.deepEqual(ask("highlight", { node: ul }), {});
    const [outlineHost] = page.document.documentElement.childNodes;
    assert.equal(outlineHost.getAttribute("data-juris-devtools"), "outline");
    assert.equal(outlineHost.shadowMode, "closed");
    const box = outlineHost.shadow.childNodes[0];
    assert.deepEqual({ display: box.style.display, left: box.style.left, top: box.style.top, width: box.style.width, height: box.style.height, position: box.style.position, pointerEvents: box.style.pointerEvents },
        { display: "block", left: "10px", top: "20px", width: "300px", height: "40px", position: "fixed", pointerEvents: "none" });
    const [shelf] = juris.findComponents("Shelf");
    ask("highlight", { component: shelf.id });
    assert.equal(box.style.left, "10px");
    // A text node is outlined by its element.
    const text = juris.findComponents("Item")[0].root.childNodes[0];
    text.parentNode.rect = { left: 1, top: 2, width: 3, height: 4 };
    ask("highlight", { node: text });
    assert.equal(box.style.width, "3px");
    // A node with no box of its own (a detached text node) is outlined at nothing.
    ask("highlight", { node: page.document.createTextNode("alone") });
    assert.equal(box.style.width, "0px");
    ask("highlight", {});
    assert.equal(box.style.display, "none");
    assert.equal(page.document.documentElement.childNodes.length, 1, "one host, reused");
    assert.equal(refusal("highlight", { component: 999_999 }), "no-such-component");
    juris.registerComponent("Nothing", () => null);
    juris.render(host(), { Nothing: {} });
    ask("highlight", { node: ul });
    ask("highlight", { component: juris.findComponents("Nothing")[0].id });
    assert.equal(box.style.display, "block", "a component whose root is a text node outlines it by its element, or nothing");
    // The last connection gone takes the outline away.
    ask("highlight", { node: ul });
    const other = endpoint.connect();
    done();
    assert.equal(box.style.display, "block", "another connection is still open");
    endpoint.disconnect(other);
    assert.equal(box.style.display, "none");
}));

test("highlight works where an element has no shadow root: the outline goes in the host itself", () => withDevtoolsPage(devtoolsPage(), (page) => {
    const create = page.document.createElement;
    page.document.createElement = (tag) => Object.assign(create(tag), { attachShadow: undefined });
    const { ask, done } = inspect();
    const div = new FakeElement("div", HTML);
    ask("highlight", { node: div });
    const [outlineHost] = page.document.documentElement.childNodes;
    assert.equal(outlineHost.shadow, undefined);
    assert.equal(outlineHost.childNodes[0].style.display, "block");
    done();
}));

test("pick: the node under the pointer is outlined, a click is kept from the page and sent as picked to the connection that asked, and ends the pick", () => withDevtoolsPage(devtoolsPage(), (page) => {
    const { juris, ask, events, endpoint, done } = inspect();
    shop(juris);
    const root = host();
    juris.render(root, { Shelf: {} });
    const li = root.childNodes[0].childNodes[1];
    li.rect = { left: 5, top: 6, width: 7, height: 8 };
    const other = endpoint.connect();
    endpoint.request(other, "pick", { on: true });
    assert.deepEqual(ask("pick", { on: true }), { on: true }, "the last to ask is the one told");
    assert.deepEqual(ask("pick", { on: true }), { on: true });
    assert.equal(page.document.listeners.length, 6, "once, whoever asks again");
    page.dispatch("pointermove", li);
    const box = page.document.documentElement.childNodes[0].shadow.childNodes[0];
    assert.equal(box.style.left, "5px");
    page.dispatch("pointermove", page.window);
    assert.equal(box.style.display, "none", "not a node: nothing outlined");
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
        const event = page.dispatch(type, li);
        assert.ok(event.defaultPrevented && event.stopped, `${type} is kept from the page`);
    }
    const click = page.dispatch("click", li);
    assert.ok(click.defaultPrevented && click.stopped);
    const [picked] = events("picked");
    assert.deepEqual({ ...picked, at: 0 }, { type: "picked", at: 0, node: picked.node, roots: [juris.findComponents("Item")[1].id], owner: juris.findComponents("Item")[1].id });
    assert.equal(picked.node.tag, "li");
    assert.deepEqual(endpoint.drain(other).events, [], "only the connection that asked last is told");
    assert.equal(page.document.listeners.length, 0, "the pick ended");
    assert.equal(box.style.display, "none");
    // A click on what is not a node ends it and sends nothing.
    ask("pick", { on: true });
    page.dispatch("click", page.window);
    assert.deepEqual(events("picked"), []);
    assert.equal(page.document.listeners.length, 0);
    // pick { on: false } ends it; so does the connection that asked going.
    ask("pick", { on: true });
    assert.deepEqual(ask("pick", { on: false }), { on: false });
    assert.deepEqual(ask("pick", { on: false }), { on: false });
    assert.equal(page.document.listeners.length, 0);
    ask("pick", { on: true });
    endpoint.request(other, "hello");
    done();
    assert.equal(page.document.listeners.length, 0);
    endpoint.request(other, "pick", { on: true });
    endpoint.disconnect(other);
    assert.equal(page.document.listeners.length, 0);
}));

// ---- the node a handle names --------------------------------------------------------------------------

test("node(handle): the node a handle names, for the console's inspect() and Reveal; null when it is gone or is no handle", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, ask, endpoint, done } = inspect();
    const root = host();
    juris.render(root, { p: { title: () => "x", textContent: "seen" } });
    const p = root.childNodes[0];
    const { node: handle } = ask("node", { node: p });
    assert.equal(handle.id, null, "an element with no id");
    assert.equal(endpoint.node(handle), p);
    assert.equal(endpoint.node({ ...handle }), p, "a copy of the handle, as JSON brings it back");
    assert.equal(endpoint.node({ $: "node", ref: 10_000_000 }), null, "never handed out");
    for (const notHandle of [null, undefined, 5, "p", { ref: handle.ref }, { $: "node", ref: "1" }]) assert.equal(endpoint.node(notHandle), null, JSON.stringify(notHandle));
    done();
}));

// ---- the console's inspect() ----------------------------------------------------------------------

test("definition(name): the registered definition, for the console's inspect(), or null", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, endpoint, done } = inspect();
    const Home = () => ({ p: "x" });
    juris.registerComponent("Home", Home);
    assert.equal(endpoint.definition("Home"), Home);
    assert.equal(endpoint.definition("Nothing"), null);
    assert.equal(endpoint.definition(5), null);
    assert.equal(endpoint.protocol, PROTOCOL);
    assert.ok(Object.isFrozen(endpoint));
    done();
}));
