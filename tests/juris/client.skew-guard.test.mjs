// client.js, the skew guard (hydrate's skewGuard: { storageKey, reload }): when this build names the
// page other than the server's route table did, the page is reloaded once, before anything is drawn,
// and sessionStorage remembers that it was, so it never reloads twice; storage that will not keep
// the mark means no reload at all. Without the guard nothing is stored. In a stand-in browser
// (tests/support/client-browser.mjs). Held to REFERENCE.md ("client.js": the skew guard).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hydrate } from "juris/client.js";
import { serialize } from "../support/dom.mjs";
import { withPage, fakePage, fakeStorage } from "../support/client-browser.mjs";
import { quiet } from "../support/remote-services-fakes.mjs";

const KEY = "shop.skew";
const SERVER_MARKUP = '<div id="app">the server\'s markup</div>';
const DRAWN = '<div id="app"><p>this build</p></div>';

// This build calls /a "a-new"; the server's table called it "a-old".
const loaded = [];
const routes = () => [{ path: "/", name: "home" }, { path: "/a", name: "a-new", load: async () => { loaded.push("a"); } }];
const skewed = { $route: { path: "/a", name: "a-old" } };
const register = (juris) => juris.registerComponent("App", () => ({ p: "this build" }));

// Boots `state` at `address`, with the guard unless told, the router keeping no trail of its own (so
// what is stored is the guard's alone), and every console warning and error collected.
async function boot({ state = skewed, address = "/a", storage = fakeStorage(), skewGuard, extra = {}, beforeMount } = {}) {
    const page = fakePage({ state });
    const reloads = [];
    const guard = skewGuard === undefined ? { storageKey: KEY, reload: () => reloads.push("reload") } : skewGuard;
    loaded.length = 0;
    let result;
    let warned;
    const errors = await quiet("error", async () => {
        warned = await quiet("warn", async () => {
            await withPage({ page, address, storage, extra }, async ({ window: win }) => {
                result = await hydrate({ routes: routes(), router: { history: false }, register, skewGuard: guard, beforeMount, prefetch: false });
                reloads.push(...win.reloads.map(() => "location.reload"));
            });
        });
    });
    return { result, page, storage, reloads, warned: warned.map((args) => args.join(" ")), errors: errors.map((args) => args.join(" ")), markup: serialize(page.root) };
}

test("a page this build names otherwise is reloaded once, its path kept under storageKey, and hydrate answers null before anything is drawn", async () => {
    let before = 0;
    const out = await boot({ beforeMount: () => { before += 1; } });
    assert.equal(out.result, null);
    assert.deepEqual(out.reloads, ["reload"]);
    assert.equal(out.storage.items.get(KEY), "/a");
    assert.equal(out.markup, SERVER_MARKUP, "nothing drawn");
    assert.deepEqual(loaded, [], "the route's code is not even loaded");
    assert.equal(before, 0);
    assert.deepEqual(out.warned, ['Juris: the server rendered this page as route "a-old", which this build calls "a-new": the code is not the server\'s. Reloading once.']);
    assert.deepEqual(out.errors, []);
});

test("the guard's reload is location.reload() unless given", async () => {
    const out = await boot({ skewGuard: { storageKey: KEY } });
    assert.equal(out.result, null);
    assert.deepEqual(out.reloads, ["location.reload"]);
});

test("a boot that finds its own path marked draws the page, tells the console, and clears the mark", async () => {
    const storage = fakeStorage();
    storage.items.set(KEY, "/a");
    const out = await boot({ storage });
    assert.ok(out.result, "the instance");
    assert.deepEqual(out.reloads, [], "never a second reload");
    assert.equal(out.markup, DRAWN);
    assert.deepEqual(loaded, ["a"]);
    assert.deepEqual(out.errors, ['Juris: still out of step with the server after a reload (route "a-old" there, "a-new" here). Clearing this site\'s data in the browser should help.']);
    assert.equal(out.storage.items.has(KEY), false);
});

test("a mark left for another path does not stop a reload of this one", async () => {
    const storage = fakeStorage();
    storage.items.set(KEY, "/elsewhere");
    const out = await boot({ storage });
    assert.equal(out.result, null);
    assert.equal(out.storage.items.get(KEY), "/a");
});

const nowhere = 'Juris: the server rendered this page as route "a-old", which this build calls "a-new", and there is nowhere to remember a reload, so the page is drawn as this build has it.';

test("storage that refuses the mark means no reload: the page is drawn as this build has it, and the console is told", async () => {
    for (const storage of [fakeStorage({ blocked: true }), fakeStorage({ forgetful: true }), fakeStorage({ unreadable: true })]) {
        const out = await boot({ storage });
        assert.ok(out.result);
        assert.deepEqual(out.reloads, []);
        assert.equal(out.markup, DRAWN);
        assert.deepEqual(out.errors, [nowhere]);
        assert.deepEqual(out.warned, []);
    }
});

test("no sessionStorage at all means no reload either", async () => {
    const out = await boot({ extra: { sessionStorage: undefined } });
    assert.ok(out.result);
    assert.deepEqual(out.reloads, []);
    assert.deepEqual(out.errors, [nowhere]);
});

test("a page this build names as the server did is drawn, and a mark left by an earlier boot is cleared", async () => {
    const storage = fakeStorage();
    storage.items.set(KEY, "/");
    const out = await boot({ state: { $route: { path: "/", name: "home" } }, address: "/", storage });
    assert.ok(out.result);
    assert.deepEqual(out.reloads, []);
    assert.deepEqual(out.errors, []);
    assert.deepEqual(out.warned, []);
    assert.equal(out.storage.items.has(KEY), false);
    assert.deepEqual(out.storage.writes, [["remove", KEY]], "the guard's own key, and nothing else");
});

test("a page the server's state does not name is drawn as this build has it", async () => {
    const out = await boot({ state: { $route: { path: "/a" } } });
    assert.ok(out.result);
    assert.deepEqual(out.reloads, []);
    assert.deepEqual(out.errors, []);
    assert.equal(out.markup, DRAWN);
});

test("a page this build has no route for is said to be called nothing, whichever way the guard goes", async () => {
    const gone = { state: { $route: { path: "/gone", name: "gone" } }, address: "/gone" };
    const reloaded = await boot(gone);
    assert.equal(reloaded.result, null);
    assert.deepEqual(reloaded.warned, ['Juris: the server rendered this page as route "gone", which this build calls "nothing": the code is not the server\'s. Reloading once.']);
    const unkept = await boot({ ...gone, storage: fakeStorage({ blocked: true }) });
    assert.deepEqual(unkept.errors, ['Juris: the server rendered this page as route "gone", which this build calls "nothing", and there is nowhere to remember a reload, so the page is drawn as this build has it.']);
    const marked = fakeStorage();
    marked.items.set(KEY, "/gone");
    const again = await boot({ ...gone, storage: marked });
    assert.deepEqual(again.errors, ['Juris: still out of step with the server after a reload (route "gone" there, "nothing" here). Clearing this site\'s data in the browser should help.']);
});

test("storage that will not clear the mark does not stop the boot", async () => {
    const out = await boot({ state: { $route: { path: "/", name: "home" } }, address: "/", storage: fakeStorage({ unclearable: true }) });
    assert.ok(out.result);
    assert.equal(out.markup, DRAWN);
});

test("without the guard a page the server named otherwise is drawn as this build has it, and nothing is stored", async () => {
    const out = await boot({ skewGuard: false });
    assert.ok(out.result);
    assert.deepEqual(out.reloads, []);
    assert.equal(out.markup, DRAWN);
    assert.deepEqual(out.storage.writes, []);
    assert.deepEqual(out.errors, []);
    assert.deepEqual(out.warned, []);
});
