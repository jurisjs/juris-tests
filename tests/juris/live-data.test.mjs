// live-data.js: useLiveData, useRouteData and claimPath, the helpers a component keeps a live query's
// answer on screen with. Most tests hand them a stand-in api that records what it is asked, so the
// order of a subscribe and the stop of the one before it can be read; the rest run on a real
// instance. Held to REFERENCE.md ("live-data.js") and the module's own comments.
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import { createRouter } from "juris/router.js";
import { useLiveData, useRouteData, claimPath } from "juris/live-data.js";
import { HTML } from "../fixtures/elements.mjs";
import { fakeDocument, FakeNode, FakeElement, serialize } from "../support/dom.mjs";
import { withGlobals, flush } from "../support/remote-services-fakes.mjs";
import { withSSR } from "../support/ssr-renderer.mjs";

// An api that records every live() and every stop, keeps its state as { path: value }, and holds the
// cleanups a component would run when it goes.
function fakeApi({ state = {}, router } = {}) {
    const log = [];
    const cleanups = [];
    let made = 0;
    const api = {
        log,
        cleanups,
        state,
        live(path, service, ...args) {
            const id = (made += 1);
            log.push(["live", path, service, args, id]);
            return () => log.push(["stop", id]);
        },
        getState(path, fallback) {
            return Object.hasOwn(state, path) ? state[path] : fallback;
        },
        onCleanup(fn) {
            cleanups.push(fn);
        },
        liveState: (path) => `state of ${path}`,
        liveMessage: (path) => `message of ${path}`,
        router,
    };
    return api;
}

const subscribes = (api) => api.log.filter(([what]) => what === "live");
const end = (api) => { for (const fn of api.cleanups) fn(); };

// ---- claimPath ---------------------------------------------------------------------------------

test("claimPath refuses anything that is not a component's api, with a TypeError", () => {
    for (const api of [undefined, null, {}, { live: "x" }, 1]) {
        assert.throws(() => claimPath(api, "p", "s"), (error) => error instanceof TypeError && /^claimPath\(api, path, service\): the first argument is the component's api/.test(error.message));
    }
});

// An instance is not its api: its `live` is the prototype's, the same function for every instance,
// so a claim keyed on it was every instance's, and one instance's claim refused another's path.
test("claimPath refuses the instance itself, and an object that only inherits an api's live", () => {
    const juris = new Juris();
    const refused = (error) => error instanceof TypeError && /the first argument is the component's api/.test(error.message);
    assert.throws(() => claimPath(juris, "cart", "cart"), refused);
    assert.throws(() => claimPath(Object.create(juris.api), "cart", "cart"), refused);
});

test("claimPath keeps a claim on its own instance: another instance's api starts with none", () => {
    const shop = new Juris();
    const admin = new Juris();
    claimPath(shop.api, "cart", "cart");
    assert.doesNotThrow(() => claimPath(admin.api, "cart", "wishlist"));
    assert.throws(() => claimPath(shop.api, "cart", "wishlist"), /already written by "cart"/);
});

test("claimPath lets one service claim a path again, and claim several paths", () => {
    const api = fakeApi();
    claimPath(api, "rows", "rows");
    assert.doesNotThrow(() => claimPath(api, "rows", "rows"));
    assert.doesNotThrow(() => claimPath(api, "other", "rows"));
});

test("claimPath refuses a second service on a path, naming the path and both services", () => {
    const api = fakeApi();
    claimPath(api, "page.data", "orders");
    assert.throws(() => claimPath(api, "page.data", "invoices"), (error) => {
        assert.equal(error.constructor, Error);
        assert.match(error.message, /^Live path "page\.data" is already written by "orders", so "invoices" cannot use it too\./);
        return true;
    });
    assert.doesNotThrow(() => claimPath(api, "page.data", "orders"), "the first claim stands");
});

test("claimPath keeps its claims per instance: another instance starts with none", () => {
    const one = fakeApi();
    const two = fakeApi();
    claimPath(one, "p", "a");
    assert.doesNotThrow(() => claimPath(two, "p", "b"));
});

test("claimPath keeps the instance's claims when juris.use replaces its api", () => {
    const juris = new Juris({ isServer: true });
    const before = juris.api;
    claimPath(before, "p", "a");
    juris.use(() => ({ somethingNew: () => 1 }));
    assert.notEqual(juris.api, before, "the api object was replaced");
    assert.throws(() => claimPath(juris.api, "p", "b"), /already written by "a"/);
    assert.doesNotThrow(() => claimPath(new Juris({ isServer: true }).api, "p", "b"), "another instance in the process has none");
});

// ---- useLiveData -------------------------------------------------------------------------------

test("useLiveData subscribes nothing until the getter is read", () => {
    const api = fakeApi();
    useLiveData(api, "rows", () => [1], "rows.list");
    assert.deepEqual(api.log, []);
});

test("useLiveData subscribes on the first read with what argsFrom builds, and answers what is at the path", () => {
    const api = fakeApi({ state: { "rows.list": [{ id: 1 }] } });
    const rows = useLiveData(api, "rows", () => [1, { sort: "name" }], "rows.list");
    assert.deepEqual(rows(), [{ id: 1 }]);
    assert.deepEqual(api.log, [["live", "rows.list", "rows", [1, { sort: "name" }], 1]]);
});

test("useLiveData answers null while nothing is at the path", () => {
    const api = fakeApi();
    assert.equal(useLiveData(api, "rows", () => [])(), null);
});

test("useLiveData writes at the service's name unless given a path", () => {
    const api = fakeApi();
    const inbox = useLiveData(api, "inbox", () => []);
    inbox();
    assert.equal(inbox.path, "inbox");
    assert.deepEqual(subscribes(api).map(([, path]) => path), ["inbox"]);
});

test("useLiveData reads its arguments on every read, and keeps one subscription while they stay the same", () => {
    const api = fakeApi();
    let built = 0;
    const read = useLiveData(api, "rows", () => { built += 1; return [{ page: 1 }]; }, "rows.list");
    read();
    read();
    read();
    assert.equal(built, 3, "argsFrom runs inside the getter");
    assert.equal(subscribes(api).length, 1, "equal arguments, built anew each time, are the same call");
});

test("useLiveData subscribes the new arguments before it stops the old subscription", () => {
    const api = fakeApi();
    let page = 1;
    const read = useLiveData(api, "rows", () => [page], "rows.list");
    read();
    page = 2;
    read();
    assert.deepEqual(api.log, [
        ["live", "rows.list", "rows", [1], 1],
        ["live", "rows.list", "rows", [2], 2],
        ["stop", 1],
    ]);
    page = 1;
    read();
    assert.deepEqual(api.log.slice(3), [["live", "rows.list", "rows", [1], 3], ["stop", 2]], "and back again");
});

test("useLiveData keys its arguments by their JSON: list() and list({}) are two calls", () => {
    const api = fakeApi();
    let args = [];
    const read = useLiveData(api, "list", () => args);
    read();
    args = [{}];
    read();
    assert.deepEqual(subscribes(api).map(([, , , a]) => a), [[], [{}]]);
});

test("useLiveData's subscription ends with the component", () => {
    const api = fakeApi();
    let page = 1;
    const read = useLiveData(api, "rows", () => [page], "rows.list");
    read();
    page = 2;
    read();
    end(api);
    assert.deepEqual(api.log.filter(([what]) => what === "stop"), [["stop", 1], ["stop", 2]], "the latest is stopped when the component goes");
});

test("useLiveData registers a cleanup that does nothing when the getter was never read", () => {
    const api = fakeApi();
    useLiveData(api, "rows", () => [1]);
    assert.equal(api.cleanups.length, 1);
    assert.doesNotThrow(() => end(api));
    assert.deepEqual(api.log, []);
});

test("useLiveData's getter carries its path, and state() and message() read liveState and liveMessage there", () => {
    const api = fakeApi();
    const read = useLiveData(api, "rows", () => [], "page.rows");
    assert.equal(read.path, "page.rows");
    assert.equal(read.state(), "state of page.rows");
    assert.equal(read.message(), "message of page.rows");
});

test("useLiveData claims its path: a second service there is refused at its read, and subscribes nothing", () => {
    const api = fakeApi();
    useLiveData(api, "orders", () => [], "shared")();
    const other = useLiveData(api, "invoices", () => [], "shared");
    assert.throws(() => other(), /Live path "shared" is already written by "orders", so "invoices" cannot use it too/);
    assert.deepEqual(subscribes(api).map(([, , service]) => service), ["orders"]);
});

test("useLiveData lets one service write two paths", () => {
    const api = fakeApi();
    useLiveData(api, "rows", () => [1], "left")();
    useLiveData(api, "rows", () => [2], "right")();
    assert.deepEqual(subscribes(api).map(([, path, , args]) => [path, args]), [["left", [1]], ["right", [2]]]);
});

// ---- useRouteData ------------------------------------------------------------------------------

const routed = (state = {}, routePath = "$route") => fakeApi({ state, router: { routePath } });

test("useRouteData builds the arguments from the route's params, named in order", () => {
    const api = routed({ "$route.params.shop": "north", "$route.params.slug": "lamp" });
    const read = useRouteData(api, "thingPage", ["slug", "shop"]);
    read();
    assert.deepEqual(subscribes(api), [["live", "thingPage", "thingPage", ["lamp", "north"], 1]]);
});

test("useRouteData passes null for a param the route does not have", () => {
    const api = routed({ "$route.params.slug": "lamp" });
    useRouteData(api, "thingPage", ["slug", "missing"])();
    assert.deepEqual(subscribes(api)[0][3], ["lamp", null]);
});

test("useRouteData with no params calls the service with no arguments, at the path it is given", () => {
    const api = routed();
    const read = useRouteData(api, "inbox", [], "mail.inbox");
    read();
    assert.equal(read.path, "mail.inbox");
    assert.deepEqual(subscribes(api), [["live", "mail.inbox", "inbox", [], 1]]);
    const bare = routed();
    useRouteData(bare, "inbox")();
    assert.deepEqual(subscribes(bare), [["live", "inbox", "inbox", [], 1]], "params default to none, the path to the service's name");
});

test("useRouteData reads the params where the router keeps the route", () => {
    const api = routed({ "nav.params.id": 7 }, "nav");
    useRouteData(api, "item", ["id"])();
    assert.deepEqual(subscribes(api)[0][3], [7]);
});

test("useRouteData re-subscribes when a param it names changes, and only then", () => {
    const api = routed({ "$route.params.id": 1, "$route.params.tab": "a" });
    const read = useRouteData(api, "item", ["id"]);
    read();
    api.state["$route.params.tab"] = "b";
    read();
    assert.equal(subscribes(api).length, 1, "a param it does not name moves nothing");
    api.state["$route.params.id"] = 2;
    read();
    assert.deepEqual(api.log, [["live", "item", "item", [1], 1], ["live", "item", "item", [2], 2], ["stop", 1]]);
});

test("useRouteData passes the viewer's value as the last argument, after the params", () => {
    const api = routed({ "$route.params.id": 3, "session.user": "u1" });
    useRouteData(api, "item", ["id"], "item", { viewer: "session.user" })();
    assert.deepEqual(subscribes(api)[0][3], [3, "u1"]);
});

test("useRouteData passes null for a viewer when there is none", () => {
    const api = routed({ "session.user": undefined });
    useRouteData(api, "mine", [], "mine", { viewer: "session.user" })();
    assert.deepEqual(subscribes(api)[0][3], [null]);
    const other = routed();
    useRouteData(other, "mine", [], "mine", { viewer: "nobody.here" })();
    assert.deepEqual(subscribes(other)[0][3], [null]);
});

test("useRouteData without a viewer, or with viewer false, adds no argument", () => {
    const api = routed({ "session.user": "u1" });
    useRouteData(api, "a", [], "a", {})();
    useRouteData(api, "b", [], "b", { viewer: false })();
    useRouteData(api, "c", [], "c", null)();
    assert.deepEqual(subscribes(api).map(([, , , args]) => args), [[], [], []]);
});

test("useRouteData's getter is useLiveData's, with path, state() and message()", () => {
    const api = routed();
    const read = useRouteData(api, "inbox", [], "box");
    assert.equal(read.path, "box");
    assert.equal(read.state(), "state of box");
    assert.equal(read.message(), "message of box");
    read();
    end(api);
    assert.deepEqual(api.log.at(-1), ["stop", 1], "and ends with the component");
});

test("useRouteData refuses an option it does not know", () => {
    assert.throws(() => useRouteData(routed(), "s", [], "s", { viewr: "session.user" }), (error) => error instanceof TypeError && error.message === 'useRouteData: unknown option "viewr"');
});

test("useRouteData refuses a viewer that is not a state path", () => {
    for (const viewer of [true, "", 1, {}, ["session.user"]]) {
        assert.throws(() => useRouteData(routed(), "s", [], "s", { viewer }), (error) => error instanceof TypeError && /^useRouteData: `viewer` is the state path of who is asking/.test(error.message), JSON.stringify(viewer));
    }
});

test("useRouteData refuses params that are not a list of names", () => {
    for (const params of ["slug", [""], [1], ["a", null], { 0: "a" }, null]) {
        assert.throws(() => useRouteData(routed(), "s", params), (error) => error instanceof TypeError && /^useRouteData: `params` is a list of the route's param names/.test(error.message), JSON.stringify(params));
    }
});

test("useRouteData refuses an instance with no router", () => {
    for (const router of [undefined, {}, { routePath: "" }, { routePath: 1 }]) {
        const api = fakeApi({ router });
        assert.throws(() => useRouteData(api, "s", ["id"]), (error) => error instanceof Error && /^useRouteData: the arguments are the route's params, read from the router, and this instance has none: install one first/.test(error.message));
        assert.deepEqual(api.log, [], "and subscribes nothing");
    }
});

test("useRouteData claims its path as useLiveData does", () => {
    const api = routed();
    useRouteData(api, "orders", [], "shared")();
    assert.throws(() => useRouteData(api, "invoices", [], "shared")(), /already written by "orders"/);
});

// ---- on a real instance ------------------------------------------------------------------------

test("useRouteData on a server builds exactly the route's preload entry, so requirePreload answers it", async () => {
    const asked = [];
    const juris = new Juris(withSSR({ isServer: true, requirePreload: true, services: { thingPage: async (...args) => { asked.push(args); return { name: `thing ${args[0]}` }; } } }));
    juris.use(createRouter({ routes: [{ path: "/things/:slug", name: "thing" }] }));
    juris.registerComponent("Page", (props, api) => {
        const thing = useRouteData(api, "thingPage", ["slug"], "page.thing", { viewer: "session.user" });
        return { p: () => `${thing()?.name} (${thing.state()})` };
    });
    const out = await juris.renderRequest({
        preload: [["thingPage", "lamp", "u1"]],
        state: { $route: { path: "/things/lamp" }, session: { user: "u1" } },
        layout: { Page: {} },
    });
    assert.equal(out.html, "<p>thing lamp (live)</p>");
    assert.deepEqual(asked, [["lamp", "u1"]], "the preload's call, and no other");
});

test("useRouteData on a server with arguments other than the preload's is refused by requirePreload", async () => {
    const juris = new Juris(withSSR({ isServer: true, requirePreload: true, services: { list: async () => [] } }));
    juris.use(createRouter({ routes: [{ path: "/" }] }));
    let thrown = null;
    juris.registerComponent("Page", (props, api) => {
        const read = useLiveData(api, "list", () => [{}]);
        try { read(); } catch (error) { thrown = error; }
        return { p: "x" };
    });
    await juris.renderRequest({ preload: [["list"]], state: { $route: { path: "/" } }, layout: { Page: {} } });
    assert.ok(thrown instanceof Error, "list({}) is not the preloaded list()");
});

test("useLiveData in a browser component re-subscribes when the state it reads moves, the last answer on screen and pending until the next", async () => {
    const answers = new Map();
    await withGlobals({ document: fakeDocument, Node: FakeNode }, async () => {
        const juris = new Juris({ isServer: false, services: { rows: (page) => new Promise((resolve) => answers.set(page, resolve)) } });
        juris.setValue("page", 1);
        juris.registerComponent("Page", (props, api) => {
            const rows = useLiveData(api, "rows", () => [api.getState("page", 1)], "rows.list");
            return { p: () => `${JSON.stringify(rows())} ${rows.state()}` };
        });
        const host = new FakeElement("div", HTML);
        const node = juris.render(host, { Page: {} });
        assert.equal(serialize(host), "<div><p>null pending</p></div>");
        answers.get(1)(["page one"]);
        await flush();
        assert.equal(serialize(host), '<div><p>["page one"] live</p></div>');
        juris.setValue("page", 2);
        assert.equal(serialize(host), '<div><p>["page one"] pending</p></div>', "page 1's rows stay, marked as not page 2's");
        answers.get(2)(["page two"]);
        await flush();
        assert.equal(serialize(host), '<div><p>["page two"] live</p></div>');
        juris.disposeTree(node);
        assert.equal(juris.api.liveState("rows.list"), null, "the subscription ended with the component");
        assert.deepEqual([...answers.keys()], [1, 2], "one call per set of arguments");
    });
});
