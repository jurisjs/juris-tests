// router.js installed on an instance with no window (a server, or a browser instance before any
// location): the derived $route fields, navigate() with the guard, beforeEnter and redirects, a
// route's own code (load, register, loadAll), link(), isActive(), and the RouterView and Link
// components, drawn by both renderers.
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import { createRouter } from "juris/router.js";
import { fakeDocument, FakeNode, FakeElement, serialize } from "../support/dom.mjs";
import { attributesIn, startTag } from "../support/markup.mjs";
import { withGlobals, deferred, settle, plain } from "../support/router-window.mjs";
import { withSSR } from "../support/ssr-renderer.mjs";

const peek = (juris, path) => juris.stateManager.peek(path);
const server = () => new Juris(withSSR({ isServer: true }));

// An instance with a router installed; `juris.api` is the api with the router's names in it.
function installed(config, juris = server()) {
    const router = createRouter(config);
    juris.use(router);
    return { juris, router, api: juris.api };
}

// Counts how often `read` wakes once bound (its first run excluded).
function wakes(juris, read) {
    const seen = [];
    juris.bindState(read, (value) => seen.push(value));
    seen.shift();
    return seen;
}

const table = [
    { path: "/", name: "home" },
    { path: "/lots", name: "lots", meta: { area: "lots" }, children: [{ path: ":id", name: "lot", meta: { leaf: true }, children: [{ path: "files/:file", name: "file" }] }] },
    { path: "/x/:toString", name: "x" },
    { path: "/old", redirect: "/lots" },
    { path: "/login", name: "login" },
];

// ---- install and the derived fields ----------------------------------------------------------

test("install: a router is installed on one instance, once", () => {
    const { router } = installed({ routes: table });
    assert.throws(() => server().use(router), { name: "Error", message: "Router: already installed" });
});

test("install: the api gains the router and its functions", () => {
    const { router, api } = installed({ routes: table });
    assert.equal(api.router, router);
    for (const name of ["route", "navigate", "back", "forward", "canBack", "canForward", "link", "isActive"]) assert.equal(typeof api[name], "function", name);
});

test("derivation: before any path there is nothing derived, and the route reads as empty", () => {
    const { juris, api } = installed({ routes: table });
    assert.equal(peek(juris, "$route"), undefined);
    assert.deepEqual(api.route(), {});
});

test("derivation: writing $route.path derives name, params, matched and meta", () => {
    const { juris } = installed({ routes: table });
    juris.setValue("$route.path", "/lots/L%201/files/f.txt");
    assert.equal(peek(juris, "$route.name"), "file");
    assert.deepEqual(plain(peek(juris, "$route.params")), { id: "L 1", file: "f.txt" });
    assert.deepEqual(peek(juris, "$route.matched"), [1, 2, 3]);
    assert.deepEqual(plain(peek(juris, "$route.meta")), { area: "lots", leaf: true });
    juris.setValue("$route.path", "/nowhere");
    assert.equal(peek(juris, "$route.name"), null, "no route: a name of null");
    assert.deepEqual(plain(peek(juris, "$route.params")), {});
    assert.deepEqual(peek(juris, "$route.matched"), []);
    assert.deepEqual(plain(peek(juris, "$route.meta")), {});
});

test("derivation: a transferred route is derived at install", () => {
    const juris = new Juris({ isServer: true, state: { $route: { path: "/lots/L7", query: {}, hash: "" } } });
    installed({ routes: table }, juris);
    assert.equal(peek(juris, "$route.name"), "lot");
    assert.equal(peek(juris, "$route.params.id"), "L7");
});

test("derivation: a reader of one param wakes only when that param changes", () => {
    const { juris } = installed({ routes: table });
    juris.setValue("$route.path", "/lots/A/files/1");
    const ids = wakes(juris, () => juris.getState("$route.params.id"));
    const files = wakes(juris, () => juris.getState("$route.params.file"));
    const names = wakes(juris, () => juris.getState("$route.name"));
    juris.setValue("$route.path", "/lots/A/files/2");
    assert.deepEqual(ids, [], "the id did not change");
    assert.deepEqual(files, ["2"]);
    assert.deepEqual(names, [], "nor did the route");
    juris.setValue("$route.path", "/lots/B/files/2");
    assert.deepEqual(ids, ["B"]);
    assert.deepEqual(files, ["2"]);
});

test("derivation: matched is written again only when the chain changes", () => {
    const { juris } = installed({ routes: table });
    juris.setValue("$route.path", "/lots/A");
    const seen = wakes(juris, () => juris.toRaw(juris.getState("$route.matched")));
    juris.setValue("$route.path", "/lots/B");
    assert.deepEqual(seen, []);
    juris.setValue("$route.path", "/lots/B/files/1");
    assert.deepEqual(seen, [[1, 2, 3]]);
    juris.setValue("$route.path", "/lots");
    assert.deepEqual(seen, [[1, 2, 3], [1]]);
});

test("derivation: a param the next route lacks is deleted, even one named after an Object.prototype member", () => {
    const { juris } = installed({ routes: table });
    juris.setValue("$route.path", "/x/1");
    assert.equal(peek(juris, "$route.params.toString"), "1");
    juris.setValue("$route.path", "/login");
    assert.equal(Object.hasOwn(peek(juris, "$route.params"), "toString"), false);
});

test("api.route() reads the route, tracked", () => {
    const { juris, api } = installed({ routes: table });
    juris.setValue("$route.path", "/lots");
    const seen = wakes(juris, () => api.route().path);
    juris.setValue("$route.path", "/login");
    assert.deepEqual(seen, ["/login"]);
});

test("without a window there is no trail: back and forward do nothing, canBack and canForward are false", () => {
    const { juris, api, router } = installed({ routes: table });
    juris.setValue("$route.path", "/lots");
    assert.equal(api.back(), undefined);
    assert.equal(api.forward(), undefined);
    assert.equal(api.canBack(), false);
    assert.equal(api.canForward(), false);
    assert.equal(peek(juris, "$route.history"), undefined);
    assert.doesNotThrow(() => router.uninstall(), "uninstall touches no window");
});

// ---- navigate ---------------------------------------------------------------------------------

test("navigate: resolves with the location it wrote, in one batch", async () => {
    const { juris, router } = installed({ routes: table });
    const paths = wakes(juris, () => `${juris.getState("$route.path")}|${juris.getState("$route.hash")}`);
    const location = await router.navigate("/lots/L1?x=1#top");
    assert.deepEqual(plain(location), { path: "/lots/L1", query: { x: "1" }, hash: "top", params: { id: "L1" }, name: "lot" });
    assert.deepEqual(paths, ["/lots/L1|top"], "path and hash were written together");
    assert.deepEqual(plain(juris.toRaw(peek(juris, "$route.query"))), { x: "1" });
});

test("api.navigate and api.link are the router's own", async () => {
    const { router, api } = installed({ routes: table });
    assert.equal((await api.navigate("/lots/L3", { replace: true })).name, "lot");
    assert.equal(router.current().path, "/lots/L3");
    const props = api.link({ name: "lot", params: { id: "L4" } }, { replace: true });
    assert.equal(props.href, "/lots/L4");
    props.onclick({ button: 0, preventDefault() { } });
    await settle();
    assert.equal(router.current().path, "/lots/L4");
});

test("navigate: before any route, the location navigated from is the root", async () => {
    let from;
    const { router } = installed({ routes: [{ path: "/a", beforeEnter: (to, f) => void (from = f) }] });
    await router.navigate("/a");
    assert.deepEqual(from, { path: "/", query: {}, hash: "", params: {}, name: undefined });
});

test("navigate: a name, its params and a query alone are resolved against the current route", async () => {
    const { router } = installed({ routes: table });
    await router.navigate({ name: "file", params: { id: "L1", file: "a b" } });
    assert.equal(router.current().path, "/lots/L1/files/a%20b");
    await router.navigate({ name: "lot" });
    assert.equal(router.current().path, "/lots/L1", "the id comes from where the tab is");
    const location = await router.navigate({ query: { tab: "log" } });
    assert.equal(location.path, "/lots/L1");
    assert.deepEqual(location.query, { tab: "log" });
});

test("navigate: an unknown route name or a missing param throws at the call site", () => {
    const { router } = installed({ routes: table });
    assert.throws(() => router.navigate({ name: "nope" }), { message: 'Router: unknown route name "nope"' });
    assert.throws(() => router.navigate({ name: "lot" }), { message: 'Router: missing param "id" for route "lot"' });
});

test("navigate: follows the table's redirects", async () => {
    const { router } = installed({ routes: table });
    const location = await router.navigate("/old");
    assert.equal(location.path, "/lots");
    assert.equal(location.name, "lots");
});

test("navigate: the guard is asked with context(api), and a location it answers redirects", async () => {
    const asked = [];
    const { juris, router } = installed({
        routes: table,
        context: (api) => ({ user: api.getState("user", null) }),
        guard: (to, ctx) => {
            asked.push([to.path, to.name, ctx]);
            return to.name === "lot" && !ctx.user ? { name: "login", query: { next: to.path } } : null;
        },
    });
    const location = await router.navigate("/lots/L1");
    assert.equal(location.path, "/login");
    assert.deepEqual(location.query, { next: "/lots/L1" });
    assert.deepEqual(asked, [["/lots/L1", "lot", { user: null }], ["/login", "login", { user: null }]], "and again for where it sent the visitor");
    juris.setValue("user", "ann");
    assert.equal((await router.navigate("/lots/L1")).path, "/lots/L1");
});

test("navigate: a context that answers nothing gives the guard an empty one", async () => {
    const contexts = [];
    const { router } = installed({ routes: table, context: () => undefined, guard: (to, ctx) => void contexts.push(ctx) });
    await router.navigate("/lots");
    assert.deepEqual(contexts, [{}]);
    const defaults = [];
    const { router: plainRouter } = installed({ routes: table, guard: (to, ctx) => void defaults.push(ctx) });
    await plainRouter.navigate("/lots");
    assert.deepEqual(defaults, [{}], "without a context option, ctx is {}");
});

test("navigate: a guard's answer that is no location rejects with a TypeError, and the route stays", async () => {
    for (const answer of [false, "", Promise.resolve(null)]) {
        const { router } = installed({ routes: table, guard: (to) => (to.path === "/lots" ? answer : null) });
        await router.navigate("/login");
        await assert.rejects(router.navigate("/lots"), (error) => error instanceof TypeError && /a guard answers a location/.test(error.message));
        assert.equal(router.current().path, "/login");
    }
});

test("navigate: a guard that always redirects is refused after ten hops", async () => {
    const { router } = installed({ routes: table, guard: (to) => (to.path === "/lots" ? "/login" : "/lots") });
    await assert.rejects(router.navigate("/lots"), { name: "Error", message: /^Router: too many redirects navigating to "\/(lots|login)"$/ });
    assert.equal(router.current().path, "/");
});

test("beforeEnter: each matched record's runs, outermost first, with the route, where it came from and the api", async () => {
    const calls = [];
    const record = (name) => (to, from, api) => void calls.push({ name, to: to.path, params: plain(to.params), meta: plain(to.meta), routeName: to.name, from: from.path, api });
    const { router, api } = installed({
        routes: [{ path: "/", name: "home" }, { path: "/p", meta: { a: 1 }, beforeEnter: record("parent"), children: [{ path: ":id", name: "child", meta: { b: 2 }, beforeEnter: record("child") }] }],
    });
    await router.navigate("/");
    await router.navigate("/p/9");
    assert.deepEqual(calls.map((c) => c.name), ["parent", "child"]);
    for (const call of calls) {
        assert.equal(call.to, "/p/9");
        assert.deepEqual(call.params, { id: "9" });
        assert.deepEqual(call.meta, { a: 1, b: 2 });
        assert.equal(call.routeName, "child");
        assert.equal(call.from, "/");
        assert.equal(typeof call.api.getState, "function");
        assert.equal(call.api.router, api.router);
    }
});

test("beforeEnter: false aborts, and the route stays where it was", async () => {
    let inner = 0;
    const { router } = installed({ routes: [{ path: "/a" }, { path: "/b", beforeEnter: async () => false, children: [{ path: "c", beforeEnter: () => void (inner += 1) }] }] });
    await router.navigate("/a");
    assert.equal(await router.navigate("/b/c"), false);
    assert.equal(router.current().path, "/a");
    assert.equal(inner, 0, "an inner record's beforeEnter is not asked after the outer one said no");
});

test("beforeEnter: true and undefined go on; a string or a target redirects, relative to the refused route", async () => {
    const { router } = installed({
        routes: [
            { path: "/open", name: "open", beforeEnter: () => true },
            { path: "/also", beforeEnter: () => undefined },
            { path: "/s", beforeEnter: async () => "/open?from=s" },
            { path: "/t/:id", beforeEnter: () => ({ name: "u", hash: "h" }) },
            { path: "/u/:id", name: "u" },
        ],
    });
    assert.equal((await router.navigate("/open")).path, "/open");
    assert.equal((await router.navigate("/also")).path, "/also");
    const fromS = await router.navigate("/s");
    assert.equal(fromS.path, "/open");
    assert.deepEqual(plain(fromS.query), { from: "s" });
    const fromT = await router.navigate("/t/5");
    assert.equal(fromT.path, "/u/5", "the param comes from the refused route");
    assert.equal(fromT.hash, "h");
});

test("beforeEnter: the guard is asked first, and a route it refuses runs no beforeEnter", async () => {
    const ran = [];
    const { router } = installed({
        routes: [{ path: "/admin", beforeEnter: () => void ran.push("admin") }, { path: "/login", beforeEnter: () => void ran.push("login") }],
        guard: (to) => (to.path === "/admin" ? "/login" : null),
    });
    assert.equal((await router.navigate("/admin")).path, "/login");
    assert.deepEqual(ran, ["login"]);
});

test("beforeEnter: redirects that never end are refused after ten hops", async () => {
    const { router } = installed({ routes: [{ path: "/a", beforeEnter: () => "/b" }, { path: "/b", beforeEnter: () => "/a" }] });
    await assert.rejects(router.navigate("/a"), /too many redirects navigating to/);
});

test("navigate: a newer navigation supersedes one still in its beforeEnter", async () => {
    const gate = deferred();
    const { router } = installed({ routes: [{ path: "/slow", beforeEnter: () => gate.promise }, { path: "/fast" }] });
    const first = router.navigate("/slow");
    const second = await router.navigate("/fast");
    assert.equal(second.path, "/fast");
    gate.resolve(true);
    assert.equal(await first, false);
    assert.equal(router.current().path, "/fast");
});

// ---- a route's own code ------------------------------------------------------------------------

test("loads: navigate awaits every matched record's load, outermost first, before the location is written", async () => {
    const started = [];
    const parent = deferred();
    const child = deferred();
    const { juris, router } = installed({
        routes: [
            { path: "/", name: "home" },
            { path: "/p", load: (j) => (started.push(["parent", j]), parent.promise), children: [{ path: "c", name: "c", load: (j) => (started.push(["child", j]), child.promise) }] },
        ],
    });
    await router.navigate("/");
    const going = router.navigate("/p/c");
    await settle();
    assert.deepEqual(started.map(([name]) => name), ["parent", "child"]);
    for (const [, given] of started) assert.equal(given, juris, "load(juris) is given the instance");
    parent.resolve();
    await settle();
    assert.equal(router.current().path, "/", "the page being left stays until every load is done");
    child.resolve();
    assert.equal((await going).name, "c");
});

test("loads: each record's load runs once per router, however many routes or navigations reach it", async () => {
    let runs = 0;
    const shared = async () => void (runs += 1);
    const { router } = installed({ routes: [{ path: "/a", load: shared }, { path: "/b", load: shared }, { path: "/c" }] });
    await router.navigate("/a");
    await router.navigate("/c");
    await router.navigate("/a");
    await router.navigate("/b");
    assert.equal(runs, 1);
    const other = installed({ routes: [{ path: "/a", load: shared }] });
    await other.router.navigate("/a");
    assert.equal(runs, 2, "another router, another instance: loaded again there");
});

test("loads: two navigations that need the same load while it runs share it", async () => {
    let runs = 0;
    const gate = deferred();
    const { router } = installed({ routes: [{ path: "/a", load: () => (runs += 1, gate.promise) }] });
    const first = router.navigate("/a");
    const second = router.navigate("/a?again=1");
    await settle();
    gate.resolve();
    assert.equal(await first, false, "the first was superseded");
    assert.deepEqual(plain((await second).query), { again: "1" });
    assert.equal(runs, 1);
});

test("loads: with a register, load answers the module and the router registers it once per module", async () => {
    const page = { Page: () => ({ p: "page" }) };
    const registered = [];
    const register = (module, juris) => {
        registered.push([module, juris]);
        juris.registerComponent("Page", module.Page);
    };
    const { juris, router } = installed({
        routes: [
            { path: "/a", load: async () => page, register },
            { path: "/b", load: async () => page, register },
        ],
    });
    await router.navigate("/a");
    await router.navigate("/b");
    assert.equal(registered.length, 1, "the routes share the module, so they share its register");
    assert.deepEqual(registered[0], [page, juris]);
    assert.equal(juris.hasComponent("Page"), true);
});

test("loads: a module may be a function, but a load given a register must answer a module", async () => {
    const fnModule = () => null;
    let got;
    const { router } = installed({
        routes: [
            { path: "/fn", load: () => fnModule, register: (module) => void (got = module) },
            { path: "/none", load: async () => undefined, register: () => { } },
            { path: "/num", load: () => 5, register: () => { } },
            { path: "/null", load: () => null, register: () => { } },
        ],
    });
    await router.navigate("/fn");
    assert.equal(got, fnModule);
    for (const path of ["/none", "/num", "/null"]) {
        await assert.rejects(router.navigate(path), { name: "TypeError", message: "Router: a route's load, given a register, answers the page's module" }, path);
    }
});

test("loads: a register that throws has its error thrown again to every later load of that module", async () => {
    const page = {};
    const broken = new Error("register broke");
    let registers = 0;
    const register = () => {
        registers += 1;
        throw broken;
    };
    const { router } = installed({ routes: [{ path: "/" }, { path: "/a", load: async () => page, register }, { path: "/b", load: async () => page, register }] });
    await router.navigate("/");
    await assert.rejects(router.navigate("/a"), (error) => error === broken);
    await assert.rejects(router.navigate("/b"), (error) => error === broken, "the other route sharing the module");
    await assert.rejects(router.navigate("/a"), (error) => error === broken, "and the same route again");
    assert.equal(registers, 1, "never half-registered twice");
    assert.equal(router.current().path, "/", "no page was drawn");
});

test("loads: on a server a failed load rejects the navigation, and the next navigation tries it again", async () => {
    let tries = 0;
    const { router } = installed({
        routes: [{ path: "/" }, { path: "/a", load: async () => { tries += 1; if (tries === 1) throw new Error("offline"); } }],
    });
    await router.navigate("/");
    await assert.rejects(router.navigate("/a"), { message: "offline" });
    assert.equal(router.current().path, "/");
    assert.equal((await router.navigate("/a")).path, "/a");
    assert.equal(tries, 2);
    await router.navigate("/a?x=1");
    assert.equal(tries, 2, "loaded now, so not again");
});

test("loads: a load that throws synchronously fails the same way", async () => {
    const { router } = installed({ routes: [{ path: "/a", load: () => { throw new Error("sync"); } }] });
    await assert.rejects(router.navigate("/a"), { message: "sync" });
});

test("loads: a newer navigation supersedes one still loading, and a superseded failure rejects nothing", async () => {
    const slow = deferred();
    const failing = deferred();
    const { router } = installed({ routes: [{ path: "/slow", load: () => slow.promise }, { path: "/failing", load: () => failing.promise }, { path: "/fast" }] });
    const first = router.navigate("/slow");
    const second = router.navigate("/failing");
    const third = await router.navigate("/fast");
    assert.equal(third.path, "/fast");
    slow.resolve();
    failing.reject(new Error("too late to matter"));
    assert.equal(await first, false);
    assert.equal(await second, false);
    assert.equal(router.current().path, "/fast");
});

test("loadAll: loads every route's code, record by record in the table's order", async () => {
    const log = [];
    const step = (name) => async () => {
        log.push(`start ${name}`);
        await settle(2);
        log.push(`end ${name}`);
    };
    const { router } = installed({
        routes: [{ path: "/a", load: step("a"), children: [{ path: "c", load: step("c") }] }, { path: "/plain" }, { path: "/b", load: step("b") }],
    });
    assert.equal(await router.loadAll(), undefined);
    assert.deepEqual(log, ["start a", "end a", "start c", "end c", "start b", "end b"]);
});

test("loadAll: rejects with the first failure, and loads nothing twice", async () => {
    const runs = { a: 0, b: 0, c: 0 };
    let bFails = true;
    const { router } = installed({
        routes: [
            { path: "/a", load: async () => void (runs.a += 1) },
            { path: "/b", load: async () => { runs.b += 1; if (bFails) throw new Error("b failed"); } },
            { path: "/c", load: async () => void (runs.c += 1) },
        ],
    });
    await assert.rejects(router.loadAll(), { message: "b failed" });
    assert.deepEqual(runs, { a: 1, b: 1, c: 0 }, "the records after the failure are not reached");
    bFails = false;
    await router.loadAll();
    assert.deepEqual(runs, { a: 1, b: 2, c: 1 });
});

test("loadAll: refused before the router is installed", async () => {
    await assert.rejects(createRouter({ routes: [{ path: "/a", load: async () => { } }] }).loadAll(), {
        name: "Error",
        message: "Router: not installed, so there is no instance to load the routes' code onto",
    });
});

// ---- link and isActive -----------------------------------------------------------------------------

const click = (extra = {}) => {
    const event = { button: 0, defaultPrevented: false, prevented: 0, preventDefault() { this.prevented += 1; this.defaultPrevented = true; }, ...extra };
    return event;
};

test("link: an href, and an onclick that navigates on a plain left click", async () => {
    const { router } = installed({ routes: table });
    const props = router.link({ name: "lot", params: { id: "L2" }, query: { t: "1" } });
    assert.equal(props.href, "/lots/L2?t=1");
    const event = click();
    assert.equal(props.onclick(event), undefined);
    assert.equal(event.prevented, 1);
    await settle();
    assert.equal(router.current().path, "/lots/L2");
});

test("link: a modified click, another button, a prevented event or another target is left to the browser", async () => {
    const { router } = installed({ routes: table });
    await router.navigate("/login");
    const props = router.link("/lots");
    const leftAlone = [
        click({ metaKey: true }),
        click({ ctrlKey: true }),
        click({ shiftKey: true }),
        click({ altKey: true }),
        click({ button: 1 }),
        click({ defaultPrevented: true }),
        click({ currentTarget: { target: "_blank" } }),
        click({ currentTarget: { target: "frame" } }),
    ];
    for (const event of leftAlone) {
        props.onclick(event);
        assert.equal(event.prevented, 0, JSON.stringify(event));
    }
    await settle();
    assert.equal(router.current().path, "/login");
    for (const currentTarget of [{ target: "_self" }, { target: "" }, {}]) {
        const event = click({ currentTarget });
        router.link("/lots").onclick(event);
        assert.equal(event.prevented, 1, JSON.stringify(currentTarget));
    }
    await settle();
    assert.equal(router.current().path, "/lots");
});

test("link: the base is in the href, and no href names another host", () => {
    const { router } = installed({ routes: table, base: "/app" });
    assert.equal(router.link("/lots").href, "/app/lots");
    const { router: bare } = installed({ routes: table });
    for (const target of ["/\\evil.com", "\\\\evil.com", "//evil.com", "/\t/evil.com"]) assert.equal(bare.link(target).href, "/evil.com", JSON.stringify(target));
    assert.equal(bare.link("/%5Cevil.com").href, "/%5Cevil.com");
});

test("isActive: a path is active on itself and below it; exact, on itself only", async () => {
    const { router, api } = installed({ routes: table });
    await router.navigate("/lots/L1");
    assert.equal(api.isActive("/lots"), true);
    assert.equal(api.isActive("/lots", { exact: true }), false);
    assert.equal(api.isActive("/lots/L1", { exact: true }), true);
    assert.equal(api.isActive({ name: "lot" }), true, "a name resolved against the current route");
    assert.equal(api.isActive("/lot"), false, "a prefix of a segment is not an ancestor");
    assert.equal(api.isActive("/"), false, "/ is active on / alone");
    await router.navigate("/");
    assert.equal(api.isActive("/"), true);
    assert.equal(api.isActive("/", { exact: true }), true);
});

test("isActive is tracked: a reader wakes when the path changes", async () => {
    const { juris, router } = installed({ routes: table });
    await router.navigate("/login");
    const seen = wakes(juris, () => router.isActive("/lots"));
    await router.navigate("/lots/L1");
    await router.navigate("/lots");
    assert.deepEqual(seen, [true, true]);
    await router.navigate("/login");
    assert.deepEqual(seen, [true, true, false]);
});

// ---- RouterView and Link, as the server draws them --------------------------------------------------------

function pages(juris) {
    juris.registerComponent("Page", (props) => ({ p: { textContent: `page ${props.id ?? "-"} ${props.key ?? ""}` } }));
    juris.registerComponent("Shell", () => ({ section: { children: [{ RouterView: { depth: 1, fallback: { i: "no child" } } }] } }));
}

const viewTable = [
    { path: "/named", component: "Page", props: { id: "fixed" } },
    { path: "/fn/:id", component: (props, api) => ({ span: { textContent: `fn ${props.id} ${props.key} ${typeof api.getState}` } }), props: (params) => ({ id: params.id }) },
    { path: "/layout", component: { em: "a layout" } },
    { path: "/bare" },
    { path: "/plain", component: "Page" },
    { path: "/shell", component: "Shell", children: [{ path: ":id", component: "Page", props: (params) => ({ id: params.id }) }] },
];

test("RouterView draws the matched record's component: a registered name, keyed by the record, with its props", () => {
    const { juris } = installed({ routes: viewTable });
    pages(juris);
    juris.setValue("$route.path", "/named");
    assert.equal(juris.renderToString({ RouterView: {} }), '<p data-key="route-0">page fixed route-0</p>');
    juris.setValue("$route.path", "/plain");
    assert.equal(juris.renderToString({ RouterView: {} }), '<p data-key="route-4">page - route-4</p>', "no props: none");
});

test("RouterView: a function component is called with the route's props, its key and the api; a layout is drawn as given", () => {
    const { juris } = installed({ routes: viewTable });
    juris.setValue("$route.path", "/fn/7");
    assert.equal(juris.renderToString({ RouterView: {} }), "<span>fn 7 route-1 function</span>");
    juris.setValue("$route.path", "/layout");
    assert.equal(juris.renderToString({ RouterView: {} }), "<em>a layout</em>");
});

test("RouterView: nothing matched draws the fallback, or nothing; a record without a component draws nothing", () => {
    const { juris } = installed({ routes: viewTable });
    assert.equal(juris.renderToString({ div: { children: [{ RouterView: { fallback: { b: "none yet" } } }] } }), "<div><b>none yet</b></div>", "before any path");
    juris.setValue("$route.path", "/nowhere");
    assert.equal(juris.renderToString({ div: { children: [{ RouterView: { fallback: { b: "missing" } } }] } }), "<div><b>missing</b></div>");
    assert.equal(juris.renderToString({ div: { children: [{ RouterView: {} }] } }), "<div></div>");
    juris.setValue("$route.path", "/bare");
    assert.equal(juris.renderToString({ div: { children: [{ RouterView: { fallback: { b: "unused" } } }] } }), "<div></div>");
});

test("RouterView: depth draws the nested route inside its parent's component", () => {
    const { juris } = installed({ routes: viewTable });
    pages(juris);
    juris.setValue("$route.path", "/shell/9");
    assert.equal(juris.renderToString({ RouterView: {} }), '<section data-key="route-5"><p data-key="route-6">page 9 route-6</p></section>');
    juris.setValue("$route.path", "/shell");
    assert.equal(juris.renderToString({ RouterView: {} }), '<section data-key="route-5"><i>no child</i></section>');
});

test("Link draws an anchor with the href and, while its route is active, the active class", () => {
    const { juris } = installed({ routes: table, base: "/app" });
    juris.setValue("$route.path", "/lots/L1");
    const drawn = (props) => {
        const html = juris.renderToString({ Link: props });
        const { tag, rest } = startTag(html);
        return { tag, attributes: attributesIn(html), inner: rest.replace(/<\/a>$/, "") };
    };
    assert.deepEqual(drawn({ to: "/lots", textContent: "Lots" }), { tag: "a", attributes: { href: "/app/lots", class: "active" }, inner: "Lots" });
    assert.deepEqual(drawn({ to: "/lots", exact: true, textContent: "Lots" }), { tag: "a", attributes: { href: "/app/lots" }, inner: "Lots" });
    assert.deepEqual(drawn({ to: "/lots", activeClass: "here", title: "t", children: [{ b: "Lots" }] }), { tag: "a", attributes: { href: "/app/lots", class: "here", title: "t" }, inner: "<b>Lots</b>" });
    assert.deepEqual(drawn({ to: "/login", class: "nav", textContent: "In" }), { tag: "a", attributes: { href: "/app/login", class: "nav" }, inner: "In" });
    for (const name of ["to", "exact", "replace", "activeClass", "onclick"]) {
        assert.equal(name.toLowerCase() in drawn({ to: "/lots", exact: false, replace: true, activeClass: "on", onclick: () => { } }).attributes, false, `${name} is the Link's, not the anchor's`);
    }
});

// ---- RouterView and Link, as a browser draws them ------------------------------------------------------

const host = () => new FakeElement("div", "http://www.w3.org/1999/xhtml");

test("RouterView keeps the page's instance when only the params change, and its param readers follow", () =>
    withGlobals({ document: fakeDocument, Node: FakeNode }, () => {
        const juris = new Juris({ isServer: false });
        const router = createRouter({ routes: [{ path: "/items/:id", component: "Item" }, { path: "/other", component: "Other" }] });
        juris.use(router);
        let made = 0;
        juris.registerComponent("Item", (props, api) => {
            made += 1;
            return { p: { textContent: () => `item ${api.getState("$route.params.id")}` } };
        });
        juris.registerComponent("Other", () => ({ p: { textContent: "other" } }));
        juris.setValue("$route.path", "/items/1");
        const root = host();
        juris.render(root, { RouterView: {} });
        const page = root.childNodes[0];
        assert.equal(serialize(root), "<div><p>item 1</p></div>");
        juris.setValue("$route.path", "/items/2");
        assert.equal(serialize(root), "<div><p>item 2</p></div>");
        assert.equal(made, 1, "the same instance");
        assert.equal(root.childNodes[0], page, "and the same element");
        juris.setValue("$route.path", "/other");
        assert.equal(serialize(root), "<div><p>other</p></div>");
        juris.setValue("$route.path", "/items/3");
        assert.equal(made, 2, "a new route, a new instance");
    }));

test("Link: the href follows the route when only the params change, and a click goes where it says", () =>
    withGlobals({ document: fakeDocument, Node: FakeNode }, async () => {
        const juris = new Juris({ isServer: false });
        const router = createRouter({ routes: [{ path: "/items/:id", name: "item" }, { path: "/items/:id/edit", name: "edit" }] });
        juris.use(router);
        juris.setValue("$route.path", "/items/1");
        const root = host();
        juris.render(root, { Link: { to: { name: "edit" }, textContent: "Edit" } });
        const anchor = root.childNodes[0];
        assert.equal(anchor.getAttribute("href"), "/items/1/edit");
        juris.setValue("$route.path", "/items/2");
        assert.equal(anchor.getAttribute("href"), "/items/2/edit");
        const listener = anchor.listeners.find((l) => l.type === "click").listener;
        const event = click({ currentTarget: anchor });
        listener(event);
        assert.equal(event.prevented, 1);
        await settle();
        assert.equal(router.current().path, "/items/2/edit");
        assert.equal(anchor.getAttribute("class"), "active", "and the class follows the route");
    }));

test("Link: a caller's onclick runs first, then the navigation, unless it prevented it", async () => {
    const { juris, router } = installed({ routes: table });
    await router.navigate("/login");
    const order = [];
    const define = juris.componentManager.get("Link");
    const theirs = define({ to: "/lots", onclick: (event) => order.push(["theirs", event.prevented, router.current().path]) }, juris.api);
    const event = click();
    theirs.a.onclick(event);
    assert.deepEqual(order, [["theirs", 0, "/login"]], "theirs first, before the navigation began");
    assert.equal(event.prevented, 1, "then the navigation took the click");
    await settle();
    assert.equal(router.current().path, "/lots");
    const stopping = define({ to: "/", onclick: (e) => e.preventDefault() }, juris.api);
    stopping.a.onclick(click());
    await settle();
    assert.equal(router.current().path, "/lots", "a caller that prevented the click keeps it");
    const notAFunction = define({ to: "/", onclick: "nope" }, juris.api);
    notAFunction.a.onclick(click());
    await settle();
    assert.equal(router.current().path, "/", "an onclick that is no function is not called");
});
