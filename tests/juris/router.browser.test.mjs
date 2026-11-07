// router.js in a browser, through a fake window whose location and history follow each other: the
// boot (reading the address, adopting a transferred route), the Back/Forward trail and where its
// length is kept, the URL following the state (push, replace, scroll), popstate writing back, a
// route's code loaded before its page with the full-load fallback, hash mode, and uninstall.
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import { createRouter } from "juris/router.js";
import { withGlobals, fakeWindow, fakeStorage, pushes, replaces, deferred, settle, capturingErrors, plain } from "../support/router-window.mjs";

const peek = (juris, path) => juris.stateManager.peek(path);
const routes = [
    { path: "/", name: "home" },
    { path: "/a", name: "a" },
    { path: "/b", name: "b" },
    { path: "/c", name: "c" },
    { path: "/lots", name: "lots" },
    { path: "/lots/:id", name: "lot" },
];

// A browser instance in `win`, with a router installed. The trail is kept in `storage` unless
// `history` says otherwise.
function boot(win, config = {}, state) {
    const storage = config.storage ?? fakeStorage();
    const { storage: _s, ...rest } = config;
    const juris = new Juris({ isServer: false, ...(state ? { state } : {}) });
    const router = createRouter({ routes, history: { storage }, ...rest });
    juris.use(router);
    return { juris, router, api: juris.api, storage };
}

// Runs `fn(win)` with `win` as the global window, put back after.
const inWindow = (win, fn) => withGlobals({ window: win }, () => fn(win));

// ---- the boot -------------------------------------------------------------------------------------

test("boot: the route is read from the address, and a fresh entry is marked as the first of the trail", () =>
    inWindow(fakeWindow("/lots/L1?x=1&x=2#top"), (win) => {
        const { juris, storage } = boot(win);
        assert.deepEqual(plain(juris.toRaw(peek(juris, "$route"))), {
            path: "/lots/L1",
            query: { x: ["1", "2"] },
            hash: "top",
            name: "lot",
            params: { id: "L1" },
            meta: {},
            matched: [5],
            history: { index: 0, length: 1 },
        });
        assert.deepEqual(win.history.state, { juris: true, idx: 0 });
        assert.deepEqual(win.calls, [["replace", undefined, { juris: true, idx: 0 }]], "the mark only: no address written, nothing pushed");
        assert.deepEqual(storage.writes, [["juris:$route:length", "1"]]);
    }));

test("boot: marking a fresh entry keeps what others put on history.state", () =>
    inWindow(fakeWindow("/a", { state: { app: 1, juris: "theirs?", fullLoad: "/x" } }), (win) => {
        boot(win);
        assert.deepEqual(win.history.state, { app: 1, juris: true, idx: 0 }, "the router's own fields are its, the rest stays");
    }));

test("boot: a history.state that is not an object is replaced by the mark", () =>
    inWindow(fakeWindow("/a", { state: "a string" }), (win) => {
        boot(win);
        assert.deepEqual(win.history.state, { juris: true, idx: 0 });
    }));

test("boot: an address in another spelling is settled by replacing the entry, keeping all it carried", () =>
    inWindow(fakeWindow("/lots/?x=1", { state: { juris: true, idx: 2, fullLoad: "/lots?x=1", app: "kept" } }), (win) => {
        const { juris } = boot(win, { storage: fakeStorage({ "juris:$route:length": "3" }) });
        assert.equal(peek(juris, "$route.path"), "/lots");
        assert.deepEqual(pushes(win), [], "settling is not a step in the trail");
        assert.deepEqual(replaces(win), [["/lots?x=1", { juris: true, idx: 2, fullLoad: "/lots?x=1", app: "kept" }]]);
        assert.equal(win.address(), "/lots?x=1");
        assert.deepEqual(peek(juris, "$route.history"), { index: 2, length: 3 });
    }));

test("boot: a transferred route on this address's path keeps the address bar's query and hash", () =>
    inWindow(fakeWindow("/a?utm=1#section"), (win) => {
        const { juris } = boot(win, {}, { $route: { path: "/a", query: {}, hash: "" } });
        assert.equal(peek(juris, "$route.hash"), "section");
        assert.equal(peek(juris, "$route.query.utm"), "1");
        assert.equal(win.address(), "/a?utm=1#section");
        for (const [, url] of win.calls) assert.ok(url === undefined || url.endsWith("#section"), `no write drops the fragment: ${url}`);
    }));

test("boot: a transferred route on another path is adopted, and the address follows it by a replace", () =>
    inWindow(fakeWindow("/old?x=1#h"), (win) => {
        const { juris } = boot(win, {}, { $route: { path: "/b", query: { y: "2" }, hash: "" } });
        assert.equal(peek(juris, "$route.path"), "/b");
        assert.equal(peek(juris, "$route.name"), "b");
        assert.equal(win.address(), "/b?y=2");
        assert.deepEqual(pushes(win), []);
        assert.equal(replaces(win).at(-1)[0], "/b?y=2");
    }));

test("boot: a server instance in a page with a window touches no location", () =>
    inWindow(fakeWindow("/a"), (win) => {
        const juris = new Juris({ isServer: true });
        const router = createRouter({ routes });
        juris.use(router);
        juris.setValue("$route.path", "/b");
        assert.deepEqual(win.calls, []);
        assert.equal(peek(juris, "$route.history"), undefined);
        assert.equal(win.listenerCount("popstate"), 0);
    }));

test("boot: a window without a location or a history is no browser to the router", async () => {
    for (const win of [{ history: {} }, { location: {} }]) {
        await inWindow(win, () => {
            const juris = new Juris({ isServer: false });
            juris.use(createRouter({ routes }));
            juris.setValue("$route.path", "/a");
            assert.equal(peek(juris, "$route.name"), "a");
            assert.equal(peek(juris, "$route.history"), undefined);
        });
    }
});

// ---- the trail and where its length is kept ---------------------------------------------------------

test("trail: a marked entry is believed, and so is the length the tab kept", () =>
    inWindow(fakeWindow("/a", { state: { juris: true, idx: 2 } }), (win) => {
        const { juris, api } = boot(win, { storage: fakeStorage({ "juris:$route:length": "5" }) });
        assert.deepEqual(peek(juris, "$route.history"), { index: 2, length: 5 });
        assert.equal(api.canBack(), true);
        assert.equal(api.canForward(), true);
        assert.deepEqual(win.calls, [], "a marked entry at its own address is left as it is");
    }));

test("trail: a fresh entry does not believe a kept length, since what lay ahead of it is gone", () =>
    inWindow(fakeWindow("/a"), (win) => {
        const { juris, api, storage } = boot(win, { storage: fakeStorage({ "juris:$route:length": "5" }) });
        assert.deepEqual(peek(juris, "$route.history"), { index: 0, length: 1 });
        assert.equal(api.canBack(), false);
        assert.equal(api.canForward(), false);
        assert.equal(storage.items.get("juris:$route:length"), "1");
    }));

test("trail: the length is never less than the entry's own place, nor read from garbage", async () => {
    for (const kept of ["1", "garbage", null]) {
        await inWindow(fakeWindow("/a", { state: { juris: true, idx: 3 } }), (win) => {
            const { juris } = boot(win, { storage: fakeStorage(kept === null ? {} : { "juris:$route:length": kept }) });
            assert.deepEqual(peek(juris, "$route.history"), { index: 3, length: 4 }, String(kept));
        });
    }
});

test("trail: kept under juris:<routePath>:length, with the base in it, or the key it is given", async () => {
    await inWindow(fakeWindow("/app/a"), (win) => {
        const { storage, juris } = boot(win, { base: "/app", routePath: "nav" });
        assert.deepEqual(storage.writes, [["juris:/app:nav:length", "1"]]);
        assert.equal(peek(juris, "nav.path"), "/a");
    });
    await inWindow(fakeWindow("/a"), (win) => {
        const storage = fakeStorage();
        boot(win, { history: { storage, key: "mine" } });
        assert.deepEqual(storage.writes, [["mine", "1"]]);
    });
});

test("trail: by default the length is kept in sessionStorage", () => {
    const session = fakeStorage({ "juris:$route:length": "4" });
    return withGlobals({ window: fakeWindow("/a", { state: { juris: true, idx: 1 } }), sessionStorage: session }, () => {
        const juris = new Juris({ isServer: false });
        juris.use(createRouter({ routes }));
        assert.deepEqual(peek(juris, "$route.history"), { index: 1, length: 4 });
        assert.deepEqual(session.writes, [["juris:$route:length", "4"]]);
    });
});

test("trail: a storage that throws is no failure; the trail is kept in the page", () =>
    inWindow(fakeWindow("/a", { state: { juris: true, idx: 1 } }), async (win) => {
        const { juris, router, api } = boot(win, { storage: fakeStorage({}, { fail: true }) });
        assert.deepEqual(peek(juris, "$route.history"), { index: 1, length: 2 });
        await router.navigate("/b");
        assert.deepEqual(peek(juris, "$route.history"), { index: 2, length: 3 });
        assert.equal(api.canBack(), true);
    }));

test("trail: history: false stores nothing, and keeps the trail in the page's memory", () => {
    const session = fakeStorage({ "juris:$route:length": "9" });
    return withGlobals({ window: fakeWindow("/a", { state: { juris: true, idx: 2 } }), sessionStorage: session }, async () => {
        const juris = new Juris({ isServer: false });
        const router = createRouter({ routes, history: false });
        juris.use(router);
        assert.deepEqual(peek(juris, "$route.history"), { index: 2, length: 3 }, "the kept 9 is not read");
        await router.navigate("/b");
        assert.deepEqual(peek(juris, "$route.history"), { index: 3, length: 4 });
        assert.deepEqual(session.writes, []);
    });
});

// ---- the URL follows the state -------------------------------------------------------------------------

test("navigate: a new page pushes one entry, one step on, carrying nothing of the last one's", () =>
    inWindow(fakeWindow("/a", { state: { app: 1 } }), async (win) => {
        const { juris, router, api, storage } = boot(win);
        await router.navigate("/b?q=1#h");
        assert.deepEqual(pushes(win), [["/b?q=1#h", { juris: true, idx: 1 }]]);
        assert.deepEqual(peek(juris, "$route.history"), { index: 1, length: 2 });
        assert.equal(storage.items.get("juris:$route:length"), "2");
        assert.equal(api.canBack(), true);
        assert.equal(api.canForward(), false);
    }));

test("navigate: { replace } replaces the entry, keeping what others put on it, and takes no step", () =>
    inWindow(fakeWindow("/a", { state: { app: 1 } }), async (win) => {
        const { juris, router } = boot(win);
        await router.navigate("/b");
        win.history.replaceState({ ...win.history.state, other: "x" }, "");
        await router.navigate("/c", { replace: true });
        assert.deepEqual(replaces(win).at(-1), ["/c", { other: "x", juris: true, idx: 1 }]);
        assert.equal(pushes(win).length, 1);
        assert.deepEqual(peek(juris, "$route.history"), { index: 1, length: 2 });
        await router.navigate("/a");
        assert.equal(pushes(win).length, 2, "the next navigation pushes again");
    }));

test("navigate: to where the tab already is, nothing is pushed", () =>
    inWindow(fakeWindow("/a?x=1"), async (win) => {
        const { router } = boot(win);
        const before = win.calls.length;
        await router.navigate("/a?x=1");
        await router.navigate({ query: { x: "1" } });
        assert.equal(win.calls.length, before);
    }));

test("raw writes: writing $route.path is navigation, and writing $route.query updates the URL", () =>
    inWindow(fakeWindow("/a"), (win) => {
        const { juris } = boot(win);
        juris.setValue("$route.path", "/b");
        assert.deepEqual(pushes(win).at(-1), ["/b", { juris: true, idx: 1 }]);
        juris.setValue("$route.query", { page: "2" });
        assert.equal(win.address(), "/b?page=2");
        juris.setValue("$route.hash", "end");
        assert.equal(win.address(), "/b?page=2#end");
        juris.setValue("$route.query.sort", "name");
        assert.equal(win.address(), "/b?page=2&sort=name#end", "a new key too");
        assert.deepEqual(peek(juris, "$route.history"), { index: 4, length: 5 });
    }));

test(
    "raw writes: changing one query key the route already has updates the URL",
    () =>
        inWindow(fakeWindow("/a?page=1"), (win) => {
            const { juris } = boot(win);
            juris.setValue("$route.query.page", "2");
            assert.equal(win.address(), "/a?page=2");
        }),
);

test(
    "raw writes: after a replace that changed nothing, the next write of $route.path is a new page",
    () =>
        inWindow(fakeWindow("/a"), async (win) => {
            const { router, juris } = boot(win);
            await router.navigate("/a", { replace: true });
            juris.setValue("$route.path", "/b");
            assert.deepEqual(pushes(win), [["/b", { juris: true, idx: 1 }]]);
        }),
);

test("scroll: a new page scrolls to the top, unless scroll is false; a window without scrollTo is no failure", async () => {
    await inWindow(fakeWindow("/a"), async (win) => {
        const { router } = boot(win);
        await router.navigate("/b");
        assert.deepEqual(win.calls.at(-1), ["scrollTo", 0, 0]);
        await router.navigate("/c", { replace: true });
        assert.deepEqual(win.calls.at(-1), ["scrollTo", 0, 0], "a replace is a new page too");
    });
    await inWindow(fakeWindow("/a"), async (win) => {
        const { router } = boot(win, { scroll: false });
        await router.navigate("/b");
        assert.equal(win.calls.some(([how]) => how === "scrollTo"), false);
    });
    await inWindow(fakeWindow("/a", { scrollTo: false }), async (win) => {
        const { router } = boot(win);
        assert.equal((await router.navigate("/b")).path, "/b");
        assert.deepEqual(pushes(win).map(([url]) => url), ["/b"]);
    });
});

// ---- Back and Forward --------------------------------------------------------------------------------

test("back and forward go only where the trail goes", () =>
    inWindow(fakeWindow("/a"), async (win) => {
        const { router, api } = boot(win);
        const asked = () => win.calls.filter(([how]) => how === "back" || how === "forward").map(([how]) => how);
        api.back();
        api.forward();
        assert.deepEqual(asked(), [], "at the first entry, with nothing ahead");
        await router.navigate("/b");
        api.forward();
        api.back();
        assert.deepEqual(asked(), ["back"]);
        win.traverse(-1);
        api.back();
        api.forward();
        assert.deepEqual(asked(), ["back", "forward"]);
    }));

test("canBack and canForward follow the trail, tracked", () =>
    inWindow(fakeWindow("/a"), async (win) => {
        const { juris, router, api } = boot(win);
        const seen = [];
        juris.bindState(() => `${api.canBack()}/${api.canForward()}`, (value) => seen.push(value));
        await router.navigate("/b");
        win.traverse(-1);
        win.traverse(+1);
        assert.deepEqual(seen, ["false/false", "true/false", "false/true", "true/false"]);
    }));

test("popstate: Back writes the route from the address, the trail follows the entry, and the URL is left alone", () =>
    inWindow(fakeWindow("/a"), async (win) => {
        const { juris, router } = boot(win);
        await router.navigate("/b?q=1");
        const before = win.calls.length;
        win.traverse(-1);
        assert.equal(peek(juris, "$route.path"), "/a");
        assert.equal(peek(juris, "$route.name"), "a");
        assert.deepEqual(plain(peek(juris, "$route.query")), {});
        assert.deepEqual(peek(juris, "$route.history"), { index: 0, length: 2 });
        assert.equal(win.calls.length, before, "nothing pushed, replaced or scrolled");
        win.traverse(+1);
        assert.equal(peek(juris, "$route.path"), "/b");
        assert.deepEqual(plain(peek(juris, "$route.query")), { q: "1" });
        assert.deepEqual(peek(juris, "$route.history"), { index: 1, length: 2 });
        await router.navigate("/c");
        assert.deepEqual(pushes(win).at(-1), ["/c", { juris: true, idx: 2 }], "and navigation goes on from there");
    }));

test("popstate: Back and Forward do not ask the guard, nor run beforeEnter", () =>
    inWindow(fakeWindow("/a"), async (win) => {
        let guards = 0;
        let enters = 0;
        const juris = new Juris({ isServer: false });
        const router = createRouter({ routes: [{ path: "/a", beforeEnter: () => void (enters += 1) }, { path: "/b" }], guard: () => void (guards += 1), history: false });
        juris.use(router);
        await router.navigate("/b");
        assert.equal(guards, 1);
        win.traverse(-1);
        assert.equal(peek(juris, "$route.path"), "/a");
        assert.equal(guards, 1);
        assert.equal(enters, 0);
    }));

test("popstate: an entry the router did not make (an in-page #anchor) counts as one step on", () =>
    inWindow(fakeWindow("/a"), (win) => {
        const { juris } = boot(win);
        win.anchor("faq");
        assert.equal(peek(juris, "$route.hash"), "faq");
        assert.deepEqual(win.history.state, { juris: true, idx: 1 });
        assert.deepEqual(peek(juris, "$route.history"), { index: 1, length: 2 });
        win.traverse(-1);
        assert.equal(peek(juris, "$route.hash"), "");
        assert.deepEqual(peek(juris, "$route.history"), { index: 0, length: 2 });
    }));

test("popstate: the trail follows the tab at once, the page once its code is here", () =>
    inWindow(fakeWindow("/slow"), async (win) => {
        const gate = deferred();
        let loads = 0;
        const juris = new Juris({ isServer: false });
        const router = createRouter({ routes: [{ path: "/slow", load: () => (loads += 1, gate.promise) }, { path: "/a" }], history: false });
        juris.use(router);
        await router.navigate("/a");
        win.traverse(-1);
        assert.deepEqual(peek(juris, "$route.history"), { index: 0, length: 2 });
        assert.equal(peek(juris, "$route.path"), "/a", "the page being left stays up");
        gate.resolve();
        await settle();
        assert.equal(peek(juris, "$route.path"), "/slow");
        assert.equal(loads, 1);
        assert.equal(win.address(), "/slow");
        assert.equal(pushes(win).length, 1, "the page following is no new entry");
    }));

test("popstate: a navigation made while Back is loading supersedes it, even if that load then fails", () =>
    inWindow(fakeWindow("/slow"), async (win) => {
        const gate = deferred();
        let fullLoads = 0;
        const juris = new Juris({ isServer: false });
        const router = createRouter({ routes: [{ path: "/slow", load: () => gate.promise }, { path: "/a" }, { path: "/c" }], history: false, fullLoad: () => void (fullLoads += 1) });
        juris.use(router);
        await router.navigate("/a");
        win.traverse(-1);
        await router.navigate("/c");
        gate.reject(new Error("too late"));
        await settle();
        assert.equal(peek(juris, "$route.path"), "/c");
        assert.equal(fullLoads, 0);
    }));

test("popstate: a later Back supersedes one still loading", () =>
    inWindow(fakeWindow("/slow"), async (win) => {
        const gate = deferred();
        const juris = new Juris({ isServer: false });
        const router = createRouter({ routes: [{ path: "/slow", load: () => gate.promise }, { path: "/a" }], history: false });
        juris.use(router);
        await router.navigate("/a");
        win.traverse(-1);
        win.traverse(+1);
        gate.resolve();
        await settle();
        assert.equal(peek(juris, "$route.path"), "/a");
    }));

test("navigate: a Back made while a navigation is loading supersedes it", () =>
    inWindow(fakeWindow("/a"), async (win) => {
        const gate = deferred();
        const juris = new Juris({ isServer: false });
        const router = createRouter({ routes: [{ path: "/a" }, { path: "/b" }, { path: "/slow", load: () => gate.promise }], history: false });
        juris.use(router);
        await router.navigate("/b");
        const going = router.navigate("/slow");
        win.traverse(-1);
        gate.resolve();
        assert.equal(await going, false);
        assert.equal(peek(juris, "$route.path"), "/a");
        assert.deepEqual(pushes(win).map(([url]) => url), ["/b"]);
    }));

// ---- a route whose code does not load --------------------------------------------------------------------

function failing(win, config = {}) {
    const fullLoads = [];
    const juris = new Juris({ isServer: false });
    const router = createRouter({
        routes: [{ path: "/a" }, { path: "/b", load: async () => { throw new Error("chunk missing"); } }, { path: "/c" }],
        history: false,
        fullLoad: (url) => void fullLoads.push(url),
        ...config,
    });
    juris.use(router);
    return { juris, router, fullLoads };
}

test("full load: a navigation whose code fails pushes the address, marked, and loads it in full", () =>
    inWindow(fakeWindow("/a"), async (win) => {
        const { juris, router, fullLoads } = failing(win);
        assert.equal(await router.navigate("/b?x=1"), false);
        assert.deepEqual(pushes(win), [["/b?x=1", { juris: true, idx: 1, fullLoad: "/b?x=1" }]]);
        assert.deepEqual(fullLoads, ["/b?x=1"]);
        assert.deepEqual(peek(juris, "$route.history"), { index: 1, length: 2 });
        assert.equal(peek(juris, "$route.path"), "/a", "the route itself never moved");
    }));

test("full load: with { replace }, the entry is replaced, marked, keeping what others put on it", () =>
    inWindow(fakeWindow("/a", { state: { app: 1 } }), async (win) => {
        const { router, fullLoads } = failing(win);
        assert.equal(await router.navigate("/b", { replace: true }), false);
        assert.deepEqual(replaces(win).at(-1), ["/b", { app: 1, juris: true, idx: 0, fullLoad: "/b" }]);
        assert.deepEqual(pushes(win), []);
        assert.deepEqual(fullLoads, ["/b"]);
    }));

test("full load: Back to a page whose code fails marks the entry it reached", () =>
    inWindow(fakeWindow("/b"), async (win) => {
        const { router, juris, fullLoads } = failing(win);
        await router.navigate("/a");
        win.traverse(-1);
        await settle();
        assert.deepEqual(win.calls.at(-1), ["replace", undefined, { juris: true, idx: 0, fullLoad: "/b" }]);
        assert.deepEqual(fullLoads, ["/b"]);
        assert.equal(peek(juris, "$route.path"), "/a");
    }));

test("full load: an entry already marked for the address is not loaded in full again", () =>
    inWindow(fakeWindow("/b", { state: { juris: true, idx: 0, fullLoad: "/b" } }), async (win) => {
        const { router, fullLoads } = failing(win);
        await router.navigate("/a");
        let result;
        const said = await capturingErrors(async () => {
            win.traverse(-1);
            await settle();
            result = await router.navigate("/b", { replace: true }).catch((error) => error);
        });
        assert.deepEqual(fullLoads, [], "no loop");
        assert.equal(result, false);
        assert.equal(said.length, 2);
        for (const args of said) {
            assert.equal(args[0], 'Router: the code for "/b" did not load, and a full load of it has been tried already');
            assert.equal(args[1].message, "chunk missing");
        }
    }));

test("full load: by default the page is reloaded", () =>
    inWindow(fakeWindow("/a"), async (win) => {
        const juris = new Juris({ isServer: false });
        const router = createRouter({ routes: [{ path: "/a" }, { path: "/b", load: () => Promise.reject(new Error("gone")) }], history: false });
        juris.use(router);
        assert.equal(await router.navigate("/b"), false);
        assert.deepEqual(win.calls.at(-1), ["reload"]);
        assert.equal(win.address(), "/b");
    }));

test("full load: a register that throws loads the page in full too", () =>
    inWindow(fakeWindow("/a"), async (win) => {
        const fullLoads = [];
        const juris = new Juris({ isServer: false });
        const router = createRouter({
            routes: [{ path: "/a" }, { path: "/b", load: async () => ({}), register: () => { throw new Error("half registered"); } }],
            history: false,
            fullLoad: (url) => void fullLoads.push(url),
        });
        juris.use(router);
        assert.equal(await router.navigate("/b"), false);
        assert.deepEqual(fullLoads, ["/b"]);
    }));

test("full load: the address in full includes the base", () =>
    inWindow(fakeWindow("/app/a"), async (win) => {
        const { router, fullLoads } = failing(win, { base: "/app" });
        assert.equal(await router.navigate("/b"), false);
        assert.deepEqual(fullLoads, ["/app/b"]);
        assert.equal(win.address(), "/app/b");
    }));

// ---- clearState ------------------------------------------------------------------------------------

test("the router survives clearState: Back still writes the route, and a failed load still loads the page in full", () =>
    inWindow(fakeWindow("/"), async (win) => {
        const { juris, router, fullLoads } = failing(win);
        await router.navigate("/c");
        win.traverse(-1);
        juris.clearState();
        win.traverse(+1);
        assert.equal(peek(juris, "$route.path"), "/c");
        assert.deepEqual(peek(juris, "$route.matched"), [2], "derived again: the derivation outlives the state");
        assert.deepEqual(peek(juris, "$route.history"), { index: 1, length: 2 }, "the trail is read from the entry");
        win.traverse(-1);
        juris.clearState();
        assert.equal(await router.navigate("/b"), false);
        assert.deepEqual(fullLoads, ["/b"]);
        assert.equal(win.address(), "/b");
        assert.equal(win.history.state.fullLoad, "/b");
        win.traverse(-1);
        juris.clearState();
        juris.setValue("$route.path", "/c");
        assert.equal(win.address(), "/c", "and the URL still follows the state");
        assert.equal(pushes(win).at(-1)[0], "/c");
    }));

// ---- hash mode ------------------------------------------------------------------------------------

test("hash mode: the route is the fragment, and the page's own path and query are left as they are", () =>
    inWindow(fakeWindow("/index.html?v=2#/a?x=1"), async (win) => {
        const { juris, router } = boot(win, { mode: "hash" });
        assert.equal(peek(juris, "$route.path"), "/a");
        assert.deepEqual(plain(peek(juris, "$route.query")), { x: "1" });
        await router.navigate("/b");
        assert.deepEqual(pushes(win).map(([url]) => url), ["#/b"]);
        assert.equal(win.address(), "/index.html?v=2#/b");
        assert.equal(router.link("/c").href, "#/c");
    }));

test("hash mode: navigating to where the tab already is pushes no entry", () =>
    inWindow(fakeWindow("/index.html#/a"), async (win) => {
        const { router } = boot(win, { mode: "hash" });
        await router.navigate("/b");
        await router.navigate("/b");
        await router.navigate("/b");
        assert.deepEqual(pushes(win).map(([url]) => url), ["#/b"]);
    }));

test("hash mode: a page opened without a fragment is settled on #/", () =>
    inWindow(fakeWindow("/index.html"), (win) => {
        const { juris } = boot(win, { mode: "hash" });
        assert.equal(peek(juris, "$route.path"), "/");
        assert.equal(win.address(), "/index.html#/");
        assert.deepEqual(pushes(win), []);
    }));

test("hash mode: Back reads the route from the fragment", () =>
    inWindow(fakeWindow("/index.html#/a"), async (win) => {
        const { juris, router } = boot(win, { mode: "hash" });
        await router.navigate("/lots/9");
        assert.equal(peek(juris, "$route.name"), "lot");
        win.traverse(-1);
        assert.equal(peek(juris, "$route.path"), "/a");
    }));

// ---- Link with replace, and uninstall --------------------------------------------------------------------

test("Link: replace replaces the entry", () =>
    inWindow(fakeWindow("/a"), async (win) => {
        const { juris } = boot(win);
        const link = juris.componentManager.get("Link")({ to: "/b", replace: true, textContent: "B" }, juris.api);
        link.a.onclick({ button: 0, preventDefault() { } });
        await settle();
        assert.equal(win.address(), "/b");
        assert.deepEqual(pushes(win), []);
        assert.deepEqual(replaces(win).at(-1), ["/b", { juris: true, idx: 0 }]);
    }));

test("uninstall removes the popstate listener, so Back no longer moves the route", () =>
    inWindow(fakeWindow("/a"), async (win) => {
        const { juris, router } = boot(win);
        await router.navigate("/b");
        assert.equal(win.listenerCount("popstate"), 1);
        router.uninstall();
        assert.equal(win.listenerCount("popstate"), 0);
        win.traverse(-1);
        assert.equal(peek(juris, "$route.path"), "/b");
    }));
