// server/kernel.js, createJurisServer running, held to REFERENCE.md's "server/kernel.js" and the
// request invariants: `listen` (once, on the loopback address unless told), every request answered in
// one fixed order (the lifecycle's, development's reload, /api/, the app's handlers, the modules,
// /favicon.ico and /.well-known/, then the page), what the server hands its parts (the instance's
// options, exposeError, the router's guard, `versioned`, the service names, trustProxy's caller key),
// the fixed 500, and `close()`'s drain in its order within `closeTimeoutMs`. Real servers on port 0
// in temporary app directories, each closed and removed.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createJurisServer } from "juris-kit/server/kernel.js";
import { createPageCache } from "juris-kit/server/page-cache.js";
import {
    appRoot, MODULES, register, request, openStream, titleIn, stateIn, servicesIn, gate, sleep, recorder,
} from "../support/kernel-app.mjs";

const ROUTES = [
    { path: "/", name: "home", component: "Home", head: { title: "Home" } },
    { path: "/items/:id", name: "item", component: "Item", preload: ({ params }) => [["item", params.id]], head: { titleFrom: (item) => item?.name } },
    { path: "/admin", name: "admin", component: "Home", meta: { admin: true } },
    { path: "*", name: "missing", component: "Home" },
];
const COMPONENTS = { Home: () => ({ p: { textContent: "home" } }), Item: () => ({ p: { textContent: "item" } }) };

// A server for the app in a fresh directory, closed and removed when the test ends.
async function shop(t, config = {}, files = {}) {
    const dir = await appRoot({ "app/other.js": "export const other = 1;\n", "app/site.css": "body { margin: 0 }\n", ...files });
    const server = await createJurisServer({
        root: dir.root,
        build: "b1",
        services: { async item(id) { return { id, name: `Item ${id}` }; } },
        routes: ROUTES,
        setup: register(COMPONENTS),
        modules: { ...MODULES },
        onError: () => {},
        ...config,
    });
    t.after(async () => { await server.close(); await dir.remove(); });
    return server;
}

const post = (port, pathname, args) => request(port, pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
const handlerApi = (names = [], answer = async () => false) => Object.assign(answer, { names });

// ---- listen -----------------------------------------------------------------------------------

test("listen serves on the loopback address unless told, answering { port, host, url }, and starts the jobs", async (t) => {
    const runs = [];
    const app = await shop(t, { jobs: [{ name: "warm", every: 60_000, atStart: true, run: () => { runs.push("warm"); } }] });
    assert.deepEqual(runs, [], "a job ran before listen");
    const bound = await app.listen();
    assert.equal(bound.host, "127.0.0.1");
    assert.ok(bound.port > 0);
    assert.equal(bound.url, `http://127.0.0.1:${bound.port}`);
    assert.deepEqual(runs, ["warm"]);
    const page = await request(bound.port, "/items/a");
    assert.equal(page.status, 200);
    assert.equal(titleIn(page.body), "Item a");
});

test("a page boots the entry at the module server's versioned URL, stamped with the server's code id", async (t) => {
    const app = await shop(t);
    const { port } = await app.listen();
    const page = await request(port, "/");
    const entry = /import\("(\/app\/boot\.js\?v=[^"]+)"\)/.exec(page.body)?.[1];
    assert.ok(entry, "no versioned entry in the page");
    assert.ok(entry.endsWith(`-${app.codeId}`), `${entry} does not name ${app.codeId}`);
    const boot = await request(port, entry);
    assert.equal(boot.status, 200);
    assert.match(boot.headers["content-type"], /javascript/);
    assert.equal((await request(port, "/src/juris.js")).status, 200, "the framework's own modules are served at /src/");
});

test("listen is once: a second is refused, and so is one after close", async (t) => {
    const app = await shop(t);
    await app.listen();
    await assert.rejects(app.listen(), { message: "createJurisServer: already listening" });
    await app.close();
    await assert.rejects(app.listen(), { message: "createJurisServer: closed" });
});

test("a listen that fails (the port is taken) leaves the server able to listen again", async (t) => {
    const taken = http.createServer();
    await new Promise((resolve) => taken.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => taken.close(resolve)));
    const app = await shop(t);
    await assert.rejects(app.listen({ port: taken.address().port }), { code: "EADDRINUSE" });
    const { port } = await app.listen({ port: 0 });
    assert.equal((await request(port, "/")).status, 200);
});

test("listen on an IPv6 address writes it in brackets in the url", async (t) => {
    const app = await shop(t);
    let bound;
    try {
        bound = await app.listen({ host: "::1" });
    } catch (error) {
        return t.skip(`no IPv6 loopback here (${error.code})`);
    }
    assert.equal(bound.host, "::1");
    assert.equal(bound.url, `http://[::1]:${bound.port}`);
});

// ---- the order --------------------------------------------------------------------------------

test("every request is answered in one order: the lifecycle's, /api/, the app's handlers, the modules, /favicon.ico, /.well-known/, then the page", async (t) => {
    const asked = [];
    const pages = [];
    const claim = (name, paths) => async (req, res, url) => {
        asked.push([name, url.pathname]);
        if (!paths.includes(url.pathname)) return false;
        res.end(name);
        return true;
    };
    const app = await shop(t, {
        services: { async hello(who) { return `hello ${who}`; }, async item(id) { return { id, name: id }; } },
        handlers: [claim("first", ["/version", "/healthz", "/api/hello", "/upload", "/app/boot.js", "/favicon.ico", "/x"]), claim("second", ["/x", "/second"])],
        page: { before: [(ctx) => { pages.push(ctx.url.pathname); return null; }] },
    });
    const { port } = await app.listen();
    assert.deepEqual(JSON.parse((await request(port, "/version")).body), { build: "b1" });
    assert.equal((await request(port, "/healthz")).status, 200);
    assert.deepEqual(JSON.parse((await post(port, "/api/hello", ["Ann"])).body), "hello Ann");
    assert.deepEqual(asked, [], "a handler was asked before the lifecycle or the dispatcher");
    assert.equal((await request(port, "/upload")).body, "first");
    assert.equal((await request(port, "/x")).body, "first", "the first handler to answer ends the search");
    assert.equal((await request(port, "/second")).body, "second");
    assert.equal((await request(port, "/app/boot.js")).body, "first", "the app's handlers come before the modules");
    assert.equal((await request(port, "/favicon.ico")).body, "first");
    asked.length = 0;
    assert.equal((await request(port, "/app/other.js")).status, 200);
    assert.deepEqual(asked, [["first", "/app/other.js"], ["second", "/app/other.js"]]);
    assert.deepEqual(pages, [], "a page was rendered for something else");
    assert.equal((await request(port, "/items/1")).status, 200);
    assert.deepEqual(pages, ["/items/1"]);
});

test("/favicon.ico is a 204 and /.well-known/ a 404, without rendering a page, unless a root file answers", async (t) => {
    const pages = [];
    const plain = await shop(t, { page: { before: [(ctx) => { pages.push(ctx.url.pathname); return null; }] } });
    const { port } = await plain.listen();
    const icon = await request(port, "/favicon.ico");
    assert.equal(icon.status, 204);
    assert.equal(icon.body, "");
    const known = await request(port, "/.well-known/security.txt");
    assert.equal(known.status, 404);
    assert.equal(known.body, "");
    assert.match((await request(port, "/.well-known")).body, /^<!doctype html>/, "only what is under /.well-known/ is refused unrendered");
    assert.deepEqual(pages, ["/.well-known"]);

    const withIcon = await shop(t, { modules: { ...MODULES, rootFiles: { "/favicon.ico": { file: "public/favicon.ico", type: "image/x-icon" } } } }, { "public/favicon.ico": "ICON" });
    const other = await withIcon.listen();
    const served = await request(other.port, "/favicon.ico");
    assert.equal(served.status, 200);
    assert.equal(served.body, "ICON");
    assert.equal(served.headers["content-type"], "image/x-icon");
});

// RFC 9110, 9.1 and 15.5.6: a method an address does not take is a 405 naming, in Allow, the ones
// it does; 9.3.7: a successful OPTIONS sends Allow. Answered once, before the modules and the page.
test("the kit's own addresses take GET and HEAD: OPTIONS is a 204, another method a 405, nothing rendered", async (t) => {
    const pages = [];
    const asked = [];
    const upload = (req, res, url) => {
        if (url.pathname !== "/upload") return false;
        asked.push(req.method);
        res.end(`${req.method} upload`);
        return true;
    };
    const modules = {
        ...MODULES,
        rootFiles: { "/sw.js": "public/sw.js" },
        static: [{ url: "/logo.svg", file: "public/logo.svg" }],
    };
    const app = await shop(t, {
        handlers: [upload],
        modules,
        page: { before: [(ctx) => { pages.push(ctx.url.pathname); return null; }] },
    }, { "public/sw.js": "self;\n", "public/logo.svg": "<svg/>" });
    const { port } = await app.listen();
    const heads = {
        "/": 200,
        "/items/1": 200,
        "/nowhere": 404,
        "//items/1": 301,
        "/app/boot.js": 200,
        "/sw.js": 200,
        "/logo.svg": 200,
        "/favicon.ico": 204,
        "/.well-known/security.txt": 404,
    };
    for (const pathname of Object.keys(heads)) {
        for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
            const json = { "content-type": "application/json", "content-length": "2" };
            const answer = await request(port, pathname, { method, headers: json, body: "[]" });
            assert.equal(answer.status, 405, `${method} ${pathname}`);
            assert.equal(answer.headers.allow, "GET, HEAD", `${method} ${pathname}`);
            assert.equal(answer.headers["cache-control"], "no-store", `${method} ${pathname}`);
            assert.equal(answer.body, "This address takes GET, HEAD.", `${method} ${pathname}`);
        }
        const options = await request(port, pathname, { method: "OPTIONS" });
        assert.deepEqual([options.status, options.headers.allow, options.body], [204, "GET, HEAD", ""], pathname);
    }
    assert.deepEqual(pages, [], "a page was rendered for a method it does not take");
    for (const [pathname, status] of Object.entries(heads)) {
        const head = await request(port, pathname, { method: "HEAD" });
        assert.deepEqual([head.status, head.body], [status, ""], pathname);
    }
    assert.deepEqual(pages, ["/", "/items/1", "/nowhere"]);
    const uploaded = await request(port, "/upload", { method: "POST" });
    assert.equal(uploaded.body, "POST upload", "the app's handlers take what they take");
    assert.equal((await request(port, "/upload", { method: "OPTIONS" })).body, "OPTIONS upload");
    assert.deepEqual(asked, ["POST", "OPTIONS"]);
    const service = await request(port, "/api/item", { method: "OPTIONS" });
    assert.deepEqual([service.status, service.headers.allow], [405, "POST"], "a service still takes POST alone");
});

// RFC 9110, 13.2.1: the conditional headers are ignored when the answer would not be a 2xx, and
// 13.1.2: only a GET or a HEAD is answered 304.
test("never a 304: a missing page is a 404 whatever If-None-Match says, a POST with a page's tag a 405", async (t) => {
    const app = await shop(t);
    const { port } = await app.listen();
    const missing = await request(port, "/nowhere");
    assert.equal(missing.status, 404);
    const again = await request(port, "/nowhere", { headers: { "if-none-match": missing.headers.etag } });
    assert.equal(again.status, 404);
    assert.equal(again.body, missing.body);
    const page = await request(port, "/items/1");
    const held = { "if-none-match": page.headers.etag };
    assert.equal((await request(port, "/items/1", { method: "POST", headers: held })).status, 405);
    assert.equal((await request(port, "/items/1", { method: "HEAD", headers: held })).status, 304);
    assert.equal((await request(port, "/items/1", { headers: held })).status, 304);
});

test("anything that throws is the lifecycle's fixed 500, and the error goes to onError as \"request\"", async (t) => {
    const errors = [];
    const app = await shop(t, {
        handlers: [(req, res, url) => { if (url.pathname === "/boom") throw new Error("at /srv/app/db.js:12"); return false; }],
        page: { head: (ctx) => { if (ctx.route.name === "admin") throw new Error("head failed"); return {}; } },
        onError: (error, where) => errors.push([where, error.message]),
    });
    const { port } = await app.listen();
    for (const pathname of ["/boom", "/admin"]) {
        const answer = await request(port, pathname);
        assert.equal(answer.status, 500, pathname);
        assert.equal(answer.body, "Something went wrong on our side. Try again in a moment.");
    }
    assert.deepEqual(errors, [["request", "at /srv/app/db.js:12"], ["request", "head failed"]]);
});

test("the server's log, unless onError is given, is the console's error stream", async (t) => {
    const lines = [];
    t.mock.method(console, "error", (...args) => lines.push(args));
    const dir = await appRoot();
    const app = await createJurisServer({
        root: dir.root, build: "b1", services: {}, routes: ROUTES, setup: register(COMPONENTS), modules: { ...MODULES },
        handlers: [() => { throw new Error("unlogged"); }],
    });
    t.after(async () => { await app.close(); await dir.remove(); });
    const res = recorder();
    await app.handle({ url: "/", headers: {}, method: "GET" }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(lines.length, 1);
    assert.equal(lines[0][0], "  request:");
    assert.equal(lines[0][1].message, "unlogged");
});

// ---- what the server hands its parts ----------------------------------------------------------

test("the lifecycle's options are the server's: the instance, its header, the health check, and a build asked per request", async (t) => {
    let build = "b1";
    let healthy = true;
    const errors = [];
    const app = await shop(t, {
        build: () => build,
        instance: "web-3", instanceHeader: true,
        health: { check: () => { if (!healthy) throw new Error("db down"); }, details: () => ({ pool: 1 }) },
        onError: (error, where) => errors.push(where),
    });
    const { port } = await app.listen();
    const health = await request(port, "/healthz");
    assert.equal(health.headers["x-instance"], "web-3");
    assert.deepEqual(JSON.parse(health.body), { ok: true, instance: "web-3", build: "b1", pool: 1 });
    build = "b2";
    assert.deepEqual(JSON.parse((await request(port, "/version")).body), { build: "b2" });
    healthy = false;
    assert.equal((await request(port, "/healthz")).status, 503);
    assert.deepEqual(errors, ["healthz"]);
    assert.equal((await request(port, "/")).headers["x-instance"], "web-3");
});

test("a dispatcher built here answers the services as JSON, and what it hides reaches onError as \"api <name>\"", async (t) => {
    const errors = [];
    const app = await shop(t, {
        services: { async add(a, b) { return a + b; }, async leak() { throw new Error("password for 10.0.0.5"); } },
        onError: (error, where) => errors.push([where, error.message]),
    });
    const { port } = await app.listen();
    assert.equal(JSON.parse((await post(port, "/api/add", [2, 3])).body), 5);
    const hidden = await post(port, "/api/leak", []);
    assert.equal(hidden.status, 400);
    assert.doesNotMatch(hidden.body, /10\.0\.0\.5/);
    assert.deepEqual(errors, [["api leak", "password for 10.0.0.5"]]);
    assert.equal((await request(port, "/api/add", { method: "POST", headers: { "content-type": "text/plain" }, body: "[1,2]" })).status, 415);
});

test("exposeError decides whether a caller reads an error's message, in a service's answer and in a failed preload", async (t) => {
    const services = { async item() { throw new Error("shelf 4 is empty"); }, async ask() { throw new Error("shelf 4 is empty"); } };
    const shown = await shop(t, { services, exposeError: () => true });
    const hidden = await shop(t, { services });
    const a = await shown.listen();
    const b = await hidden.listen();
    assert.match((await request(a.port, "/items/x")).body, /shelf 4 is empty/);
    assert.match((await post(a.port, "/api/ask", [])).body, /shelf 4 is empty/);
    assert.doesNotMatch((await request(b.port, "/items/x")).body, /shelf 4 is empty/);
    assert.doesNotMatch((await post(b.port, "/api/ask", [])).body, /shelf 4 is empty/);
});

test("a failed preload is reported to onError as \"preload <name>\"", async (t) => {
    const errors = [];
    const app = await shop(t, {
        services: { async item(id) { throw new Error(`no ${id}`); } },
        onError: (error, where) => errors.push([where, error.message]),
    });
    const { port } = await app.listen();
    assert.equal((await request(port, "/items/q")).status, 200);
    assert.deepEqual(errors, [["preload item", "no q"]]);
});

test("the instance is built with the app's juris options: a tag it allows is drawn, and refused without them", async (t) => {
    const frame = { Home: () => ({ iframe: { src: "https://maps.example/embed" } }), Item: COMPONENTS.Item };
    const allowed = await shop(t, { setup: register(frame), juris: { allowTags: ["iframe"] } });
    const refused = await shop(t, { setup: register(frame) });
    const a = await allowed.listen();
    const b = await refused.listen();
    assert.match((await request(a.port, "/")).body, /<iframe src="https:\/\/maps\.example\/embed"/);
    assert.doesNotMatch((await request(b.port, "/")).body, /<iframe/);
    assert.equal(allowed.juris.isServer, true);
});

test("the instance is built with the app's juris.components: a page draws them, as the browser's boot draws them", async (t) => {
    function App() {
        return { main: { children: [{ RouterView: {} }] } };
    }
    function Home() {
        return { Basket: { count: 2 } };
    }
    function Basket(props) {
        return { p: { class: "basket", textContent: `${props.count} items` } };
    }
    const shared = { components: [App, Home, Basket, COMPONENTS.Item] };
    const server = await shop(t, { setup: undefined, juris: shared });
    const { port } = await server.listen();
    const page = (await request(port, "/")).body;
    assert.match(page, /<main><p class="basket"[^>]*>2 items<\/p><\/main>/);
    assert.equal(server.juris.componentManager.get("Basket"), Basket);
});

test("the router's guard is asked with who the page's viewer hook says is asking", async (t) => {
    const app = await shop(t, {
        router: { guard: (to, ctx) => (to.meta.admin && !ctx.viewer?.admin ? "/" : undefined) },
        page: { viewer: (req) => (req.headers["x-admin"] ? { admin: true } : null) },
    });
    const { port } = await app.listen();
    const guest = await request(port, "/admin");
    assert.equal(guest.status, 302);
    assert.equal(guest.headers.location, "/");
    const admin = await request(port, "/admin", { headers: { "x-admin": "1" } });
    assert.equal(admin.status, 200);
    assert.equal(admin.headers["cache-control"], "private, no-cache");
    assert.deepEqual(await app.render("/admin"), { redirect: "/" }, "render asks the guard too");
});

test("a page's head is given versioned, the module server's URL for a file it serves, beside the pipeline's context", async (t) => {
    const asked = [];
    const app = await shop(t, {
        modules: { mounts: [{ url: "/app/", dir: "app", only: [".js", ".css"] }], entry: "/app/boot.js" },
        page: { head: async (ctx) => { asked.push([ctx.route.name, ctx.title]); return { styles: [{ href: await ctx.versioned("/app/site.css") }] }; } },
    });
    const { port } = await app.listen();
    const page = await request(port, "/items/v");
    const href = /<link rel="stylesheet" href="([^"]+)">/.exec(page.body)?.[1];
    assert.match(href, new RegExp(`^/app/site\\.css\\?v=[^"]+-${app.codeId}$`));
    assert.equal((await request(port, href)).status, 200);
    assert.deepEqual(asked, [["item", "Item v"]]);
});

test("the page's hooks are the pipeline's: origin, title, notFound and the rest reach every page", async (t) => {
    const app = await shop(t, {
        services: { async item(id) { return id === "gone" ? null : { id, name: `Item ${id}` }; } },
        page: { origin: "https://shop.example", title: { suffix: " - Shop" }, notFound: (own) => own === null, state: () => ({ shop: { open: true } }) },
    });
    const { port } = await app.listen();
    const page = await request(port, "/items/x");
    assert.equal(titleIn(page.body), "Item x - Shop");
    assert.match(page.body, /<link rel="canonical" href="https:\/\/shop\.example\/items\/x">/);
    assert.equal(stateIn(page.body).shop.open, true);
    assert.equal((await request(port, "/items/gone")).status, 404);
    const direct = await app.render("/items/y");
    assert.equal(titleIn(direct.body.toString()), "Item y - Shop");
});

test("every page carries the service names a browser may call: the dispatcher's, the page's own list, or none", async (t) => {
    const services = { async item(id) { return { id }; }, async save() {} };
    const byDefault = await shop(t, { services });
    const listed = await shop(t, { services, page: { serviceNames: ["item"] } });
    const none = await shop(t, { services, page: { serviceNames: false } });
    const exposed = await shop(t, { services, api: { expose: ["save"] } });
    const handler = await shop(t, { services, api: handlerApi(["item", "save", "remote"]) });
    assert.deepEqual(servicesIn((await byDefault.render("/")).body.toString()), ["item", "save"]);
    assert.deepEqual(servicesIn((await listed.render("/")).body.toString()), ["item"]);
    assert.equal(servicesIn((await none.render("/")).body.toString()), null);
    assert.deepEqual(servicesIn((await exposed.render("/")).body.toString()), ["save"]);
    assert.deepEqual(servicesIn((await handler.render("/")).body.toString()), ["item", "save", "remote"]);
});

test("a handler the app built answers /api/ in place of the dispatcher; when it answers false the request goes on", async (t) => {
    const asked = [];
    let closed = 0;
    const api = Object.assign(async (req, res, url) => {
        asked.push(url.pathname);
        if (url.pathname !== "/api/mine") return false;
        res.end("mine");
        return true;
    }, { names: [], close: () => { closed++; } });
    const app = await shop(t, { api, handlers: [async (req, res, url) => { if (url.pathname !== "/api/other") return false; res.end("handler"); return true; }] });
    const { port } = await app.listen();
    assert.equal((await request(port, "/api/mine")).body, "mine");
    assert.equal((await request(port, "/api/other")).body, "handler");
    assert.equal((await request(port, "/items/1")).status, 200);
    assert.deepEqual(asked, ["/api/mine", "/api/other"], "the handler was asked about a path outside /api/");
    await app.close();
    assert.equal(closed, 1, "the handler's close() was not called when the server drained");
    await assert.rejects(app.invalidate(["item"]), { name: "TypeError", message: /invalidate\(\) is the dispatcher's, and this server was given a handler of the app's/ });
});

test("a server whose handler has no close() drains without one", async (t) => {
    const order = [];
    const app = await shop(t, { api: handlerApi(), onShutdown: [() => { order.push("shutdown"); }] });
    const { port } = await app.listen();
    assert.equal((await request(port, "/")).status, 200);
    await app.close();
    assert.deepEqual(order, ["shutdown"]);
    assert.ok((await request(port, "/")).error, "the server still answers after close()");
});

test("a page cache beside a handler the app built keeps guests' pages", async (t) => {
    let calls = 0;
    const cache = createPageCache();
    const app = await shop(t, { api: handlerApi(), cache, services: { async item(id) { calls++; return { id, name: id }; } } });
    const { port } = await app.listen();
    const first = await request(port, "/items/c");
    const second = await request(port, "/items/c");
    assert.equal(second.body, first.body);
    assert.equal(first.headers["cache-control"], "public, max-age=0, must-revalidate");
    assert.equal(calls, 1);
    assert.equal(cache.has("/items/c"), true);
});

test("in development every page is no-store, and the reload is served first, written into every page, and ended when the server drains", async (t) => {
    const asked = [];
    let closed = 0;
    const devReload = {
        script: "window.__reload = 1;",
        handle: (req, res, url) => { asked.push(url.pathname); if (url.pathname !== "/__reload") return false; res.end("reload stream"); return true; },
        close: () => { closed++; },
    };
    const app = await shop(t, { dev: true, devReload, services: { async hello() { return "hi"; } } });
    const { port } = await app.listen();
    assert.equal((await request(port, "/__reload")).body, "reload stream");
    assert.equal(JSON.parse((await post(port, "/api/hello", [])).body), "hi");
    const page = await request(port, "/");
    assert.equal(page.headers["cache-control"], "no-store");
    assert.match(page.body, /<script>window\.__reload = 1;<\/script>/);
    assert.deepEqual(asked, ["/__reload", "/api/hello", "/"]);
    assert.equal((await request(port, "/version")).status, 200);
    assert.deepEqual(asked, ["/__reload", "/api/hello", "/"], "the reload was asked before the lifecycle's own");
    await app.close();
    assert.equal(closed, 1);
});

// ---- trustProxy: who a caller is --------------------------------------------------------------

// Opens event streams one after another and answers each one's status; closes them all after.
async function streams(t, port, list) {
    const opened = [];
    t.after(() => { for (const stream of opened) stream.close(); });
    const statuses = [];
    for (const headers of list) {
        const stream = await openStream(port, "/api/events", headers);
        opened.push(stream);
        statuses.push(stream.status);
    }
    return statuses;
}

const LIVE = { queries: ["items"], public: true, maxStreamsPerCaller: 1 };
const liveServices = { async items() { return []; } };

test("without trustProxy, a dispatcher built here counts its callers by the socket's address, whatever X-Forwarded-For says", async (t) => {
    const app = await shop(t, { services: liveServices, api: { live: LIVE } });
    const { port } = await app.listen();
    assert.deepEqual(await streams(t, port, [{ "x-forwarded-for": "1.1.1.1" }, { "x-forwarded-for": "2.2.2.2" }]), [200, 429]);
});

test("behind one trusted proxy, a caller is the address the proxy saw", async (t) => {
    const app = await shop(t, { services: liveServices, api: { live: LIVE }, trustProxy: true });
    const { port } = await app.listen();
    assert.deepEqual(await streams(t, port, [{ "x-forwarded-for": "1.1.1.1" }, { "x-forwarded-for": "6.6.6.6, 1.1.1.1" }, { "x-forwarded-for": "2.2.2.2" }]), [200, 429, 200]);
});

test("behind { hops } trusted proxies, a caller is the address the nearest of them saw", async (t) => {
    const app = await shop(t, { services: liveServices, api: { live: LIVE }, trustProxy: { hops: 2 } });
    const { port } = await app.listen();
    assert.deepEqual(await streams(t, port, [
        { "x-forwarded-for": "9.9.9.9, 1.1.1.1, 10.0.0.1" },
        { "x-forwarded-for": "8.8.8.8, 1.1.1.1, 10.0.0.2" },
        { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 10.0.0.1" },
    ]), [200, 429, 200]);
});

test("behind a trusted proxy, a caller who is someone (live.identify) is counted as that someone", async (t) => {
    const app = await shop(t, { services: liveServices, api: { live: { ...LIVE, identify: ({ req }) => req.headers["x-user"] ?? null } }, trustProxy: true });
    const { port } = await app.listen();
    assert.deepEqual(await streams(t, port, [
        { "x-forwarded-for": "1.1.1.1", "x-user": "ann" },
        { "x-forwarded-for": "2.2.2.2", "x-user": "ann" },
        { "x-forwarded-for": "1.1.1.1", "x-user": "bob" },
    ]), [200, 429, 200]);
});

test("behind a trusted proxy, the app's own live.clientKey is kept", async (t) => {
    const app = await shop(t, { services: liveServices, api: { live: { ...LIVE, clientKey: () => "everyone" } }, trustProxy: true });
    const { port } = await app.listen();
    assert.deepEqual(await streams(t, port, [{ "x-forwarded-for": "1.1.1.1" }, { "x-forwarded-for": "2.2.2.2" }]), [200, 429]);
});

// ---- invalidate -------------------------------------------------------------------------------

test("invalidate() carries a change made outside a service call to live.onInvalidate, as a service's touches do", async (t) => {
    const heard = [];
    const app = await shop(t, { services: liveServices, api: { live: { queries: ["items"], public: true, onInvalidate: (targets, info) => heard.push([targets, info.remote]) } } });
    await app.invalidate([{ name: "items", where: { list: "a" } }]);
    assert.deepEqual(heard, [[[{ name: "items", where: { list: "a" } }], false]]);
});

// ---- close ------------------------------------------------------------------------------------

test("close() drains in order: out of rotation, the streams ended, the connections closed, the jobs stopped, then onShutdown in order", async (t) => {
    const order = [];
    const job = gate();
    let closedReload = 0;
    const app = await shop(t, {
        dev: true,
        devReload: { script: "1;", handle: () => false, close: () => { closedReload++; order.push("reload closed"); } },
        services: liveServices,
        api: { live: { queries: ["items"], public: true } },
        jobs: [{ name: "sweep", every: 60_000, atStart: true, run: async () => { order.push("job started"); await job.promise; order.push("job finished"); } }],
        onShutdown: [
            async () => { order.push("pool closed"); },
            async () => { order.push("bus failed"); throw new Error("bus already gone"); },
            () => { order.push("last"); },
        ],
        onError: (error, where) => order.push(`error ${where}: ${error.message}`),
    });
    const { port } = await app.listen();
    const stream = await openStream(port, "/api/events");
    assert.equal(stream.status, 200);
    stream.end.then(() => order.push("stream ended"));
    const closing = app.close();
    // Out of rotation at once: a request that still reaches the instance hears it is stopping.
    const health = recorder();
    await app.handle({ url: "/healthz", headers: {}, method: "GET" }, health);
    assert.equal(health.statusCode, 503);
    assert.deepEqual(JSON.parse(health.body), { ok: false, error: "stopping" });
    await sleep(10);
    assert.deepEqual(order, ["job started", "reload closed", "stream ended"], "the drain went past a job in flight");
    job.open();
    await closing;
    assert.deepEqual(order, ["job started", "reload closed", "stream ended", "job finished", "pool closed", "bus failed", "error shutdown: bus already gone", "last"]);
    assert.equal(closedReload, 1);
    assert.equal(app.close(), closing, "close() answers the same promise however often it is called");
    await app.close();
    assert.equal(closedReload, 1);
});

test("close() waits for a stale page's replacement before the onShutdown hooks", async (t) => {
    const order = [];
    let clock = 0;
    let slow = false;
    const held = gate();
    const cache = createPageCache({ ttlMs: 100, staleMs: 100_000, now: () => clock });
    const app = await shop(t, {
        api: handlerApi(), cache,
        services: { async item(id) { if (slow) { order.push("replacement started"); await held.promise; order.push("replacement done"); } return { id, name: id }; } },
        onShutdown: [() => { order.push("shutdown"); }],
    });
    const { port } = await app.listen();
    await request(port, "/items/s");
    clock += 1000;
    slow = true;
    assert.equal((await request(port, "/items/s")).status, 200);
    await sleep(5);
    const closing = app.close();
    await sleep(5);
    assert.deepEqual(order, ["replacement started"]);
    held.open();
    await closing;
    assert.deepEqual(order, ["replacement started", "replacement done", "shutdown"]);
});

test("close() lets a request in flight finish within closeTimeoutMs", async (t) => {
    const slow = gate();
    const app = await shop(t, { closeTimeoutMs: 2000, handlers: [async (req, res, url) => { if (url.pathname !== "/slow") return false; await slow.promise; res.end("finished"); return true; }] });
    const { port } = await app.listen();
    const inFlight = request(port, "/slow");
    await sleep(10);
    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    await sleep(10);
    assert.equal(closed, false, "close() did not wait for the request in flight");
    slow.open();
    const answer = await inFlight;
    await closing;
    assert.equal(answer.status, 200);
    assert.equal(answer.body, "finished");
});

test("close() cuts what is still open once closeTimeoutMs has passed, and still runs onShutdown", async (t) => {
    const never = gate();
    const shutdown = [];
    const app = await shop(t, {
        closeTimeoutMs: 30,
        handlers: [async (req, res, url) => { if (url.pathname !== "/hang") return false; await never.promise; return true; }],
        onShutdown: [() => { shutdown.push("closed"); }],
    });
    t.after(() => never.open());
    const { port } = await app.listen();
    const inFlight = request(port, "/hang");
    await sleep(10);
    const started = Date.now();
    await app.close();
    const elapsed = Date.now() - started;
    const answer = await inFlight;
    assert.ok(answer.error, "the request was answered instead of cut");
    assert.ok(elapsed >= 25 && elapsed < 1000, `close() took ${elapsed} ms`);
    assert.deepEqual(shutdown, ["closed"]);
});

test("a closeTimeoutMs of 0 cuts a request in flight at once", async (t) => {
    const never = gate();
    const app = await shop(t, { closeTimeoutMs: 0, handlers: [async (req, res, url) => { if (url.pathname !== "/hang") return false; await never.promise; return true; }] });
    t.after(() => never.open());
    const { port } = await app.listen();
    const inFlight = request(port, "/hang");
    await sleep(10);
    const started = Date.now();
    await app.close();
    assert.ok(Date.now() - started < 500);
    assert.ok((await inFlight).error);
});

test("an idle kept-alive connection does not hold close() for closeTimeoutMs", async (t) => {
    const agent = new http.Agent({ keepAlive: true });
    t.after(() => agent.destroy());
    const app = await shop(t, { closeTimeoutMs: 5000 });
    const { port } = await app.listen();
    assert.equal((await request(port, "/", { agent })).status, 200);
    const started = Date.now();
    await app.close();
    assert.ok(Date.now() - started < 1000, `close() waited ${Date.now() - started} ms on an idle connection`);
});

test("close() before listen stops the jobs and runs onShutdown", async (t) => {
    const order = [];
    const app = await shop(t, { onShutdown: [() => { order.push("a"); }, () => { order.push("b"); }] });
    await app.close();
    assert.deepEqual(order, ["a", "b"]);
});
