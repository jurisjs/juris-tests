// client.js, what hydrate leaves for the browser's idle time: every other route's code (prefetch),
// one record at a time, a failure ending it quietly; and the service worker, registered once idle,
// its messages handed to onMessage. The idle wait is requestIdleCallback only when that is a
// function, a timer otherwise, so an element with id="requestIdleCallback" cannot stand in for it.
// In a stand-in browser (tests/support/client-browser.mjs); the timer is node:test's mock.
// Held to REFERENCE.md ("client.js": steps 10 and 11, "The page contract").
import { test } from "node:test";
import assert from "node:assert/strict";
import { hydrate } from "juris/client.js";
import { withPage, fakePage, fakeServiceWorker } from "../support/client-browser.mjs";
import { flush, deferred, quiet } from "../support/remote-services-fakes.mjs";

const home = { $route: { path: "/", name: "home" } };
const register = (juris) => juris.registerComponent("App", () => ({ p: "x" }));

// A table whose every route records when its code starts loading; each load answers the gate the
// test holds for it (or at once when it has none).
function table(started, gates = {}) {
    const load = (name) => () => { started.push(name); return gates[name]?.promise; };
    return [
        { path: "/", name: "home", load: load("home") },
        { path: "/b", name: "b", load: load("b") },
        { path: "/shop", name: "shop", load: load("shop"), children: [{ path: "item", name: "item", load: load("item") }] },
    ];
}

// Every unhandled rejection while `fn` runs, and a few turns after.
async function unhandled(fn) {
    const seen = [];
    const record = (reason) => seen.push(reason);
    process.on("unhandledRejection", record);
    try {
        await fn();
        await flush();
    } finally {
        process.off("unhandledRejection", record);
    }
    return seen;
}

// ---- prefetch ----------------------------------------------------------------------------------

test("once the browser is idle every other route's code is loaded, one record at a time, in the table's order", async () => {
    const started = [];
    const gates = { b: deferred(), shop: deferred(), item: deferred() };
    await withPage({ page: fakePage({ state: home }) }, async ({ idle }) => {
        await hydrate({ routes: table(started, gates), register });
        assert.deepEqual(started, ["home"], "only the route's own code before idle");
        assert.equal(idle.callbacks.length, 1);
        idle.run();
        await flush();
        assert.deepEqual(started, ["home", "b"], "the page's own is loaded already");
        gates.b.resolve();
        await flush();
        assert.deepEqual(started, ["home", "b", "shop"], "the next only once the one before is done");
        gates.shop.resolve();
        await flush();
        assert.deepEqual(started, ["home", "b", "shop", "item"]);
        gates.item.resolve();
        await flush();
    });
});

test("a prefetch that fails ends the prefetch, quietly", async () => {
    const started = [];
    const gates = { b: deferred() };
    await withPage({ page: fakePage({ state: home }) }, async ({ idle }) => {
        await hydrate({ routes: table(started, gates), register });
        const errors = await quiet("error", async () => {
            const seen = await unhandled(async () => {
                idle.run();
                await flush();
                gates.b.reject(new Error("chunk gone"));
            });
            assert.deepEqual(seen, [], "not an error");
        });
        assert.deepEqual(errors, []);
        assert.deepEqual(started, ["home", "b"], "and loads nothing after it");
    });
});

test("prefetch: false loads only the route's own code, and asks for no idle time", async () => {
    const started = [];
    await withPage({ page: fakePage({ state: home }) }, async ({ idle }) => {
        await hydrate({ routes: table(started), register, prefetch: false });
        assert.equal(idle.callbacks.length, 0);
        await flush();
        assert.deepEqual(started, ["home"]);
    });
});

test("where requestIdleCallback is an element of that id, not a function, the idle steps wait on a timer instead", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const started = [];
    const element = { tagName: "DIV", id: "requestIdleCallback" };
    await withPage({ page: fakePage({ state: home }), idle: false, extra: { requestIdleCallback: element } }, async () => {
        await hydrate({ routes: table(started), register });
        t.mock.timers.tick(1199);
        await flush();
        assert.deepEqual(started, ["home"]);
        t.mock.timers.tick(1);
        await flush();
        assert.deepEqual(started, ["home", "b", "shop", "item"]);
    });
});

test("where there is no requestIdleCallback at all, the idle steps wait on a timer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const worker = fakeServiceWorker();
    await withPage({ page: fakePage({ state: home }), idle: false, worker }, async () => {
        await hydrate({ routes: [{ path: "/", name: "home" }], register, serviceWorker: "/sw.js" });
        t.mock.timers.tick(1199);
        await flush();
        assert.deepEqual(worker.registered, []);
        t.mock.timers.tick(1);
        await flush();
        assert.deepEqual(worker.registered, ["/sw.js"]);
    });
});

// ---- the service worker ------------------------------------------------------------------------

test("a service worker given as a script URL is registered once the browser is idle", async () => {
    const worker = fakeServiceWorker();
    await withPage({ page: fakePage({ state: home }), worker }, async ({ idle }) => {
        await hydrate({ routes: [{ path: "/" }], register, serviceWorker: "/sw.js", prefetch: false });
        await flush();
        assert.deepEqual(worker.registered, [], "not during the boot");
        assert.equal(idle.callbacks.length, 1);
        idle.run();
        await flush();
        assert.deepEqual(worker.registered, ["/sw.js"]);
        assert.equal(worker.listeners.length, 0, "with no onMessage, nothing listens");
    });
});

test("a service worker's messages are handed to onMessage(data, juris, event) from the boot on", async () => {
    const worker = fakeServiceWorker();
    const heard = [];
    await withPage({ page: fakePage({ state: home }), worker }, async ({ idle }) => {
        const juris = await hydrate({
            routes: [{ path: "/" }], register, prefetch: false,
            serviceWorker: { url: "/worker.js", onMessage: (data, instance, event) => heard.push([data, instance, event]) },
        });
        const event = worker.emit({ type: "update-ready" });
        assert.deepEqual(heard, [[{ type: "update-ready" }, juris, event]], "heard before the worker is even registered");
        idle.run();
        await flush();
        assert.deepEqual(worker.registered, ["/worker.js"]);
    });
});

test("a service worker whose registration fails, or throws, does no harm", async () => {
    for (const register_ of [async () => { throw new Error("SecurityError"); }, () => { throw new Error("thrown at once"); }]) {
        const worker = fakeServiceWorker(register_);
        await withPage({ page: fakePage({ state: home }), worker }, async ({ idle }) => {
            const juris = await hydrate({ routes: [{ path: "/" }], register, serviceWorker: "/sw.js", prefetch: false });
            const seen = await unhandled(async () => { idle.run(); });
            assert.deepEqual(seen, []);
            assert.deepEqual(worker.registered, ["/sw.js"]);
            assert.ok(juris);
        });
    }
});

test("a browser with no service workers, or no navigator, boots with nothing registered", async () => {
    for (const parts of [{ worker: false }, { worker: false, extra: { navigator: undefined } }]) {
        await withPage({ page: fakePage({ state: home }), ...parts }, async ({ idle }) => {
            const juris = await hydrate({ routes: [{ path: "/" }], register, serviceWorker: { url: "/sw.js", onMessage: () => { } }, prefetch: false });
            assert.ok(juris);
            assert.equal(idle.callbacks.length, 0, "no idle wait for a worker that cannot be");
        });
    }
});

test("without serviceWorker nothing is registered", async () => {
    const worker = fakeServiceWorker();
    await withPage({ page: fakePage({ state: home }), worker }, async ({ idle }) => {
        await hydrate({ routes: [{ path: "/" }], register });
        idle.run();
        await flush();
        assert.deepEqual(worker.registered, []);
        assert.equal(worker.listeners.length, 0);
    });
});
