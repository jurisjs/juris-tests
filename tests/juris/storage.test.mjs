// storage.js (REFERENCE.md, "storage.js" and "What the framework stores in a browser"): the
// declaration of what the framework keeps in a browser (STORAGE), and trailKey, the router's key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STORAGE, trailKey } from "juris/storage.js";
import { createRouter } from "juris/router.js";
import Juris from "juris/juris.js";
import { withGlobals } from "../support/juris-harness.mjs";

test("the trail key under the router's default root is juris:$route:length", () => {
    assert.equal(trailKey(), "juris:$route:length");
    assert.equal(trailKey({}), "juris:$route:length");
});

test("the trail key names the router's state root", () => {
    assert.equal(trailKey({ routePath: "nav" }), "juris:nav:length");
});

test("the trail key carries the base when the app is mounted under one", () => {
    assert.equal(trailKey({ base: "/app" }), "juris:/app:$route:length");
    assert.equal(trailKey({ routePath: "nav", base: "/shop" }), "juris:/shop:nav:length");
});

test("an empty base adds nothing to the trail key", () => {
    assert.equal(trailKey({ base: "" }), "juris:$route:length");
});

test("two apps under two bases in one tab keep two trails", () => {
    assert.notEqual(trailKey({ base: "/a" }), trailKey({ base: "/b" }));
});

test("STORAGE declares the one key the framework writes: the router's trail length, in sessionStorage", () => {
    assert.equal(STORAGE.length, 1);
    const [entry] = STORAGE;
    assert.deepEqual(Object.keys(entry).sort(), ["category", "key", "kind", "life", "purpose"]);
    assert.equal(entry.key, trailKey());
    assert.equal(entry.kind, "sessionStorage");
    assert.equal(entry.category, "necessary");
});

test("each STORAGE entry words its purpose and life for a visitor", () => {
    for (const entry of STORAGE) {
        assert.equal(typeof entry.purpose, "string");
        assert.ok(entry.purpose.length > 0);
        assert.equal(typeof entry.life, "string");
        assert.ok(entry.life.length > 0);
    }
});

test("STORAGE and its entries are frozen, so an app spreads them rather than editing them", () => {
    assert.ok(Object.isFrozen(STORAGE));
    for (const entry of STORAGE) assert.ok(Object.isFrozen(entry));
    assert.throws(() => { STORAGE.push({}); }, TypeError);
    assert.throws(() => { STORAGE[0].key = "other"; }, TypeError);
});

// A browser's window (a location and a history that follow each other) and a sessionStorage that
// records what is written to it, enough for the router to boot in a browser instance.
function fakeBrowser(address) {
    const location = {};
    const go = (url) => {
        const next = new URL(url, `http://site${location.pathname ?? "/"}`);
        Object.assign(location, { pathname: next.pathname, search: next.search, hash: next.hash });
    };
    go(address);
    const history = {
        state: null,
        replaceState(entry, _title, url) { this.state = entry; if (url !== undefined) go(url); },
        pushState(entry, _title, url) { this.state = entry; go(url); },
        back() { },
        forward() { },
    };
    const written = new Map();
    const sessionStorage = { getItem: (key) => written.get(key) ?? null, setItem: (key, value) => written.set(key, String(value)) };
    const window = { location, history, addEventListener() { }, removeEventListener() { }, scrollTo() { } };
    return { window, sessionStorage, written };
}

test("the router writes its trail under the declared key, in the declared storage", async () => {
    for (const [options, key] of [[{}, STORAGE[0].key], [{ base: "/app" }, trailKey({ base: "/app" })], [{ routePath: "nav" }, trailKey({ routePath: "nav" })]]) {
        const { window, sessionStorage, written } = fakeBrowser(options.base ? "/app/" : "/");
        await withGlobals({ window, sessionStorage }, () => {
            new Juris({ isServer: false }).use(createRouter({ routes: [{ path: "/" }], ...options }));
        });
        assert.deepEqual([...written.keys()], [key], JSON.stringify(options));
    }
});

test("an app's list spreads the framework's entries in unchanged", () => {
    const mine = [...STORAGE, { key: "app:skew", kind: "localStorage", category: "necessary", purpose: "x", life: "y" }];
    assert.equal(mine[0], STORAGE[0]);
    assert.equal(mine.length, 2);
});
