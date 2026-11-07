// component-manager.js (REFERENCE.md, "component-manager.js" and "Components and layouts"): the
// registry of definitions and their options, and, in devMode, the tree of live client instances the
// renderer reports (track / untrack), read through componentTree, find and onTreeChange.
//
// The instances here are plain records shaped as the DOM renderer makes them ({ name, props, parent,
// root, … }), so each rule is held without a DOM; the Juris-level tests drive the same tree through
// a real render.
import { test } from "node:test";
import assert from "node:assert/strict";
import ComponentManager from "juris/component-manager.js";
import Juris from "juris/juris.js";

const definition = () => ({ p: "x" });
const instance = (name, extra = {}) => ({ name, props: {}, parent: null, ...extra });

// ---- registry ----------------------------------------------------------------------------------

test("a registered definition is found by its name", () => {
    const manager = new ComponentManager();
    manager.registerComponent("Card", definition);
    assert.equal(manager.has("Card"), true);
    assert.equal(manager.get("Card"), definition);
    assert.equal(manager.has("Other"), false);
    assert.equal(manager.get("Other"), undefined);
});

test("names() lists the registered names in the order they were registered", () => {
    const manager = new ComponentManager();
    manager.registerComponent("B", definition);
    manager.registerComponent("A", definition);
    assert.deepEqual(manager.names(), ["B", "A"]);
    assert.deepEqual(new ComponentManager().names(), []);
});

test("a name must be a non-empty string", () => {
    const manager = new ComponentManager();
    for (const name of ["", undefined, null, 7, {}]) {
        assert.throws(() => manager.registerComponent(name, definition), { message: "ComponentManager.registerComponent: name must be a non-empty string" });
    }
    assert.deepEqual(manager.names(), []);
});

test("a definition must be a function", () => {
    const manager = new ComponentManager();
    for (const wrong of [undefined, null, { p: "x" }, "Card"]) {
        assert.throws(() => manager.registerComponent("Card", wrong), { message: 'ComponentManager.registerComponent: definition for "Card" must be a function' });
    }
    assert.equal(manager.has("Card"), false);
});

test("a name is registered once: a second definition is refused and the first is kept", () => {
    const manager = new ComponentManager();
    const other = () => ({ p: "other" });
    manager.registerComponent("Card", definition);
    assert.throws(() => manager.registerComponent("Card", other), { message: 'ComponentManager.registerComponent: "Card" is already registered' });
    assert.equal(manager.get("Card"), definition);
});

test("a component's options default to ssr: true and are frozen", () => {
    const manager = new ComponentManager();
    manager.registerComponent("Card", definition);
    const options = manager.getOptions("Card");
    assert.deepEqual(options, { ssr: true });
    assert.ok(Object.isFrozen(options));
});

test("ssr: false and any other option given are kept", () => {
    const manager = new ComponentManager();
    manager.registerComponent("Map", definition, { ssr: false, label: "map" });
    assert.deepEqual(manager.getOptions("Map"), { ssr: false, label: "map" });
    assert.equal(manager.getOptions("Unknown"), undefined);
});

test("the options object given is copied, so a later change to it changes nothing", () => {
    const manager = new ComponentManager();
    const given = { ssr: false };
    manager.registerComponent("Map", definition, given);
    given.ssr = true;
    assert.equal(manager.getOptions("Map").ssr, false);
});

// ---- devMode off ---------------------------------------------------------------------------------

test("without devMode no tree exists: track and untrack leave an instance as it was", () => {
    const manager = new ComponentManager();
    assert.equal(manager.devMode, false);
    assert.equal(manager.roots, null);
    assert.equal(manager.inspectors, null);
    const card = instance("Card");
    manager.track(card);
    assert.deepEqual(card, instance("Card"));
    manager.untrack(card);
    assert.deepEqual(card, instance("Card"));
    assert.equal(manager.dirty, false);
});

test("without devMode the inspection methods refuse, naming the Juris method", () => {
    const manager = new ComponentManager();
    assert.throws(() => manager.componentTree(), { message: "Juris.componentTree: available in devMode only" });
    assert.throws(() => manager.find("Card"), { message: "Juris.findComponents: available in devMode only" });
    assert.throws(() => manager.onTreeChange(() => { }), { message: "Juris.onTreeChange: available in devMode only" });
});

test("without devMode flush does nothing", () => {
    const manager = new ComponentManager();
    assert.doesNotThrow(() => manager.flush());
});

test("devMode is read as a boolean", () => {
    assert.equal(new ComponentManager({ devMode: 1 }).devMode, true);
    assert.equal(new ComponentManager({ devMode: 0 }).devMode, false);
});

// ---- devMode: the live tree ------------------------------------------------------------------------

test("a tracked instance gets the next id, and one without a parent is a root", () => {
    const manager = new ComponentManager({ devMode: true });
    const a = instance("A");
    const b = instance("B");
    manager.track(a);
    manager.track(b);
    assert.equal(a.id, 0);
    assert.equal(b.id, 1);
    assert.deepEqual([...manager.roots], [a, b]);
    assert.equal(manager.dirty, true);
});

test("a tracked instance whose parent is tracked becomes that parent's child", () => {
    const manager = new ComponentManager({ devMode: true });
    const page = instance("Page");
    manager.track(page);
    const row = instance("Row", { parent: page });
    manager.track(row);
    assert.deepEqual([...page.children], [row]);
    assert.deepEqual([...manager.roots], [page]);
});

test("an instance whose parent is not tracked is a root", () => {
    const manager = new ComponentManager({ devMode: true });
    const row = instance("Row", { parent: { name: "Untracked" } });
    manager.track(row);
    assert.deepEqual([...manager.roots], [row]);
});

test("a server instance is never tracked", () => {
    const manager = new ComponentManager({ devMode: true });
    const ssr = instance("Page", { ssr: true });
    manager.track(ssr);
    assert.equal(ssr.id, undefined);
    assert.equal(ssr.children, undefined);
    assert.equal(manager.roots.size, 0);
    assert.equal(manager.dirty, false);
});

test("untrack takes an instance out of its parent and out of the roots", () => {
    const manager = new ComponentManager({ devMode: true });
    const page = instance("Page");
    manager.track(page);
    const row = instance("Row", { parent: page });
    manager.track(row);
    manager.dirty = false;
    manager.untrack(row);
    assert.equal(page.children.size, 0);
    assert.equal(row.children, undefined);
    assert.equal(manager.dirty, true);
    manager.untrack(page);
    assert.equal(manager.roots.size, 0);
});

test("a child still alive when its parent is untracked is re-rooted, not lost", () => {
    const manager = new ComponentManager({ devMode: true });
    const page = instance("Page");
    manager.track(page);
    const row = instance("Row", { parent: page });
    manager.track(row);
    manager.untrack(page);
    assert.equal(row.parent, null);
    assert.deepEqual([...manager.roots], [row]);
    assert.deepEqual(manager.componentTree().map((node) => node.name), ["Row"]);
});

test("untracking an instance that was never tracked, or twice, changes nothing", () => {
    const manager = new ComponentManager({ devMode: true });
    const stray = instance("Stray");
    manager.untrack(stray);
    assert.equal(manager.dirty, false);
    const page = instance("Page");
    manager.track(page);
    manager.untrack(page);
    manager.dirty = false;
    manager.untrack(page);
    assert.equal(manager.dirty, false);
    assert.equal(manager.roots.size, 0);
});

// ---- componentTree ---------------------------------------------------------------------------------

test("componentTree is a plain snapshot of the live tree, roots first", () => {
    const manager = new ComponentManager({ devMode: true });
    const root = { nodeType: 1 };
    const page = instance("Page", { props: { key: "home", title: "Hi" }, root });
    manager.track(page);
    const row = instance("Row", { parent: page, props: {} });
    manager.track(row);
    const tree = manager.componentTree();
    assert.deepEqual(tree, [
        {
            id: 0,
            name: "Page",
            key: "home",
            props: { key: "home", title: "Hi" },
            local: null,
            root,
            adopted: false,
            disposed: false,
            children: [{ id: 1, name: "Row", key: undefined, props: {}, local: null, root: null, adopted: false, disposed: false, children: [] }],
        },
    ]);
    assert.equal(tree[0].root, root, "the root is the node itself");
});

test("a snapshot says whether the instance was adopted or disposed, as booleans", () => {
    const manager = new ComponentManager({ devMode: true });
    const adopted = instance("enhance", { adopted: 1 });
    const disposed = instance("Gone", { disposed: "yes" });
    manager.track(adopted);
    manager.track(disposed);
    const [a, d] = manager.componentTree();
    assert.equal(a.adopted, true);
    assert.equal(a.disposed, false);
    assert.equal(d.disposed, true);
});

test("a snapshot of an instance with no props has no key", () => {
    const manager = new ComponentManager({ devMode: true });
    const bare = { name: "Bare", parent: null };
    manager.track(bare);
    const [snap] = manager.componentTree();
    assert.equal(snap.key, undefined);
    assert.equal(snap.props, undefined);
});

test("without an instance to read from, local values are the useState initials", () => {
    const manager = new ComponentManager({ devMode: true });
    const counter = instance("Counter", { local: "$local.Counter.0", localDefaults: { count: 0 } });
    manager.track(counter);
    assert.deepEqual(manager.componentTree()[0].local, { path: "$local.Counter.0", values: { count: 0 } });
});

test("with an instance, local values are what the state holds over the initials, read raw", () => {
    const juris = new Juris({ isServer: true, devMode: true });
    const manager = new ComponentManager({ devMode: true, juris });
    juris.setValue("$local.Counter.0.count", 3);
    const props = { items: [1, 2] };
    const counter = instance("Counter", { local: "$local.Counter.0", localDefaults: { count: 0, open: false }, props });
    manager.track(counter);
    const [snap] = manager.componentTree();
    assert.deepEqual(snap.local, { path: "$local.Counter.0", values: { count: 3, open: false } });
    assert.deepEqual(snap.props, { items: [1, 2] });
});

test("a snapshot's props are raw values, not the state's tracking proxies", () => {
    const juris = new Juris({ isServer: true, devMode: true });
    const manager = new ComponentManager({ devMode: true, juris });
    juris.setValue("list", [{ id: 1 }]);
    const tracked = juris.getState("list");
    const row = instance("Row", { props: tracked });
    manager.track(row);
    assert.equal(manager.componentTree()[0].props, juris.toRaw(tracked));
});

// ---- find ------------------------------------------------------------------------------------------

test("find answers the live instances of one name, depth first", () => {
    const manager = new ComponentManager({ devMode: true });
    const a = instance("Row");
    manager.track(a);
    const a1 = instance("Row", { parent: a });
    manager.track(a1);
    const other = instance("Cell", { parent: a });
    manager.track(other);
    const b = instance("Row");
    manager.track(b);
    assert.deepEqual(manager.find("Row"), [a, a1, b]);
    assert.deepEqual(manager.find("Cell"), [other]);
    assert.deepEqual(manager.find("None"), []);
});

// ---- onTreeChange and flush --------------------------------------------------------------------------

test("flush calls every inspector with the tree after a change, once", () => {
    const manager = new ComponentManager({ devMode: true });
    const seen = [];
    manager.onTreeChange((tree) => seen.push(tree.map((node) => node.name)));
    manager.track(instance("Page"));
    manager.flush();
    manager.flush();
    assert.deepEqual(seen, [["Page"]]);
    assert.equal(manager.dirty, false);
});

test("flush with nothing changed calls nobody", () => {
    const manager = new ComponentManager({ devMode: true });
    let calls = 0;
    manager.onTreeChange(() => { calls += 1; });
    manager.flush();
    assert.equal(calls, 0);
});

test("a change with no inspector is still marked clean by flush", () => {
    const manager = new ComponentManager({ devMode: true });
    manager.track(instance("Page"));
    manager.flush();
    assert.equal(manager.dirty, false);
    let calls = 0;
    manager.onTreeChange(() => { calls += 1; });
    manager.flush();
    assert.equal(calls, 0, "the earlier change was already flushed");
});

test("every inspector is handed the same snapshot", () => {
    const manager = new ComponentManager({ devMode: true });
    const trees = [];
    manager.onTreeChange((tree) => trees.push(tree));
    manager.onTreeChange((tree) => trees.push(tree));
    manager.track(instance("Page"));
    manager.flush();
    assert.equal(trees.length, 2);
    assert.equal(trees[0], trees[1]);
});

test("onTreeChange returns an unsubscribe", () => {
    const manager = new ComponentManager({ devMode: true });
    let calls = 0;
    const off = manager.onTreeChange(() => { calls += 1; });
    manager.track(instance("A"));
    manager.flush();
    off();
    manager.track(instance("B"));
    manager.flush();
    assert.equal(calls, 1);
});

test("an untrack is a change too", () => {
    const manager = new ComponentManager({ devMode: true });
    const page = instance("Page");
    manager.track(page);
    manager.flush();
    const seen = [];
    manager.onTreeChange((tree) => seen.push(tree.length));
    manager.untrack(page);
    manager.flush();
    assert.deepEqual(seen, [0]);
});

test("flush tells every watcher, whichever throws, and throws the first error once all have been told", () => {
    const manager = new ComponentManager({ devMode: true });
    const first = new Error("first");
    const told = [];
    manager.onTreeChange(() => { told.push("a"); throw first; });
    manager.onTreeChange(() => { told.push("b"); throw new Error("second"); });
    manager.onTreeChange(() => told.push("c"));
    manager.track(instance("X"));
    assert.throws(() => manager.flush(), (thrown) => thrown === first);
    assert.deepEqual(told, ["a", "b", "c"]);
});
