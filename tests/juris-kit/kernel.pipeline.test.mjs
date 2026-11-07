// server/kernel.js, createPagePipeline, held to REFERENCE.md's "server/kernel.js" and the request
// invariants in "Security defaults and invariants": the options it refuses, `render` (the route's
// preload with the app's in front, the state, one renderRequest, the status, the title, the head,
// the page's own headers, the trace the cache decides on) and `handle` in its fixed order (the one
// spelling of the path, who is asking, the router's guard, the `before` hooks, the page cache for
// guests, the render, the answer's policy), stale pages' replacements and `close()`. A real Juris
// instance and router, a real page cache watched through a wrapper, and HTTP servers on port 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPagePipeline } from "juris-kit/server/kernel.js";
import { createPageCache } from "juris-kit/server/page-cache.js";
import { inlineScriptHashes } from "juris-kit/server/document.js";
import { CACHE_CONTROL } from "juris-kit/server/http.js";
import {
    pipelineApp, serve, request, titleIn, canonicalIn, stateIn, servicesIn, gate, sleep, recorder,
} from "../support/kernel-app.mjs";

// A small shop: a home page, an item page titled from its own call, an admin page behind the
// router's guard, a page that reads a query parameter, and the catch-all.
async function shop({ calls = [], guard, components = {}, services = {} } = {}) {
    return pipelineApp({
        services: {
            async item(id) { calls.push(["item", id]); if (id === "boom") throw new Error("db down at 10.0.0.5"); return id === "gone" ? null : { id, name: `Item ${id}` }; },
            async banner() { calls.push(["banner"]); return { text: "Sale" }; },
            async search(q) { calls.push(["search", q]); return { q }; },
            ...services,
        },
        routes: [
            { path: "/", name: "home", component: "Home", head: { title: "Home", description: "The home page" } },
            { path: "/items/:id", name: "item", component: "Item", preload: ({ params }) => [["item", params.id]], head: { titleFrom: (item) => item?.name, title: "An item" } },
            { path: "/search", name: "search", component: "Search", preload: ({ query }) => [["search", query.q ?? ""]] },
            { path: "/admin", name: "admin", component: "Home", meta: { admin: true } },
            { path: "*", name: "missing", component: "Missing" },
        ],
        router: guard ? { guard } : {},
        components: {
            Home: () => ({ p: { textContent: "home" } }),
            Item: () => ({ p: { textContent: "an item" } }),
            Search: () => ({ p: { textContent: "search" } }),
            Missing: () => ({ p: { textContent: "not here" } }),
            ...components,
        },
    });
}

// A page cache whose calls are recorded, as [method, key].
function watchedCache(options) {
    const real = createPageCache(options);
    const calls = [];
    const cache = { ...real, calls };
    for (const name of ["get", "put", "snapshot", "release"]) {
        cache[name] = (...args) => { calls.push([name, name === "snapshot" ? null : args[0]]); return real[name](...args); };
    }
    return cache;
}

const adminGuard = (to, ctx) => (to.meta.admin && !ctx.viewer?.admin ? "/" : undefined);
const asViewer = (req) => (req.headers["x-user"] ? { id: req.headers["x-user"], admin: req.headers["x-admin"] === "1" } : null);

async function served(t, pipeline) {
    const server = await serve((req, res) => pipeline.handle(req, res).catch((error) => { res.writeHead(500); res.end(String(error.message)); }));
    t.after(() => server.close());
    return server;
}

// ---- construction -----------------------------------------------------------------------------

test("a pipeline refuses a guard of its own, which it would never ask: the guard is the router's", async () => {
    const { juris, router } = await shop();
    assert.throws(() => createPagePipeline({ juris, router, entry: "/boot.js", guard: () => "/" }), { name: "TypeError", message: /guard is the router's \(createRouter\(\{ guard \}\)\)/ });
});

test("a pipeline refuses an option it does not know, naming the ones it does", async () => {
    const { juris, router } = await shop();
    assert.throws(() => createPagePipeline({ juris, router, entry: "/boot.js", befor: [] }), { name: "TypeError", message: /"befor" is not an option \(juris, router, layout, entry,.*onError\)/ });
});

test("a pipeline needs a server instance, its router, and the browser entry", async () => {
    const { juris, router } = await shop();
    assert.throws(() => createPagePipeline(), { name: "TypeError", message: /juris, a server instance \(isServer: true\), is required/ });
    assert.throws(() => createPagePipeline(null), { name: "TypeError", message: /juris, a server instance/ });
    assert.throws(() => createPagePipeline({ juris: { isServer: false }, router, entry: "/b.js" }), { name: "TypeError", message: /juris, a server instance/ });
    assert.throws(() => createPagePipeline({ juris, router: {}, entry: "/b.js" }), { name: "TypeError", message: /router, installed on that instance, is required/ });
    assert.throws(() => createPagePipeline({ juris, entry: "/b.js" }), { name: "TypeError", message: /router, installed/ });
    for (const entry of [undefined, null, 5, {}]) {
        assert.throws(() => createPagePipeline({ juris, router, entry }), { name: "TypeError", message: /entry, the browser entry's URL, is required/ }, String(entry));
    }
    assert.doesNotThrow(() => createPagePipeline({ juris, router, entry: () => "/boot.js" }));
});

test("a pipeline refuses serviceNames that are not a list of names, and headers that are not a function", async () => {
    const { juris, router } = await shop();
    for (const serviceNames of ["item", [1], [null], {}]) {
        assert.throws(() => createPagePipeline({ juris, router, entry: "/b.js", serviceNames }), { name: "TypeError", message: /serviceNames is a list of service names/ }, JSON.stringify(serviceNames));
    }
    for (const headers of [{}, "csp", 1]) {
        assert.throws(() => createPagePipeline({ juris, router, entry: "/b.js", headers }), { name: "TypeError", message: /headers is a function of the page's context/ }, JSON.stringify(headers));
    }
});

// ---- render -----------------------------------------------------------------------------------

test("render draws the page: a 200 named from the route, its body, its state and the loader for the entry", async () => {
    const { juris, router } = await shop();
    const pipeline = createPagePipeline({ juris, router, entry: "/app/boot.js?v=1" });
    const page = await pipeline.render("/");
    const html = page.body.toString();
    assert.equal(page.status, 200);
    assert.ok(Buffer.isBuffer(page.body));
    assert.match(page.etag, /^W\/"/);
    assert.equal(titleIn(html), "Home");
    assert.match(html, /<meta name="description" content="The home page">/);
    assert.match(html, /<p[^>]*>home<\/p>/);
    assert.equal(stateIn(html).$route.path, "/");
    assert.match(html, /import\("\/app\/boot\.js\?v=1"\)/);
    assert.equal(canonicalIn(html), undefined, "no origin, no canonical link");
    assert.equal(servicesIn(html), null, "no service names unless given");
});

test("render's canonical link is the origin and the page's path, encoded so a raw path cannot break the attribute", async () => {
    const { juris, router } = await shop();
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", origin: "https://shop.example" });
    assert.equal(canonicalIn((await pipeline.render("/items/a?x=1")).body.toString()), "https://shop.example/items/a");
    const odd = (await pipeline.render('/items/a"<b>')).body.toString();
    assert.equal(canonicalIn(odd), "https://shop.example/items/a%22%3Cb%3E");
    assert.doesNotMatch(odd, /href="[^"]*<b>/);
});

test("render writes the service names into every page, and the development reload client when given", async () => {
    const { juris, router } = await shop();
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", serviceNames: ["item", "banner"], devReload: "window.__reloading = true;" });
    const html = (await pipeline.render("/")).body.toString();
    assert.deepEqual(servicesIn(html), ["item", "banner"]);
    assert.match(html, /<script>window\.__reloading = true;<\/script>/);
});

test("render asks an entry that is a function for every page", async () => {
    const { juris, router } = await shop();
    let n = 0;
    const pipeline = createPagePipeline({ juris, router, entry: async () => `/boot.js?v=${++n}` });
    assert.match((await pipeline.render("/")).body.toString(), /import\("\/boot\.js\?v=1"\)/);
    assert.match((await pipeline.render("/")).body.toString(), /import\("\/boot\.js\?v=2"\)/);
});

test("render draws the layout it is given", async () => {
    const { juris, router } = await shop({ components: { Shell: () => ({ div: { className: "shell", children: [{ RouterView: {} }] } }) } });
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", layout: { Shell: {} } });
    assert.match((await pipeline.render("/")).body.toString(), /<div class="shell"><p[^>]*>home<\/p><\/div>/);
});

test("render answers the router's redirect instead of a page: the guard is asked with who is asking", async () => {
    const asked = [];
    const { juris, router } = await shop({ guard: (to, ctx) => { asked.push([to.name, ctx.viewer?.id ?? null]); return adminGuard(to, ctx); } });
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js" });
    assert.deepEqual(await pipeline.render("/admin"), { redirect: "/" });
    assert.deepEqual(await pipeline.render("/admin", { id: "eve" }), { redirect: "/" });
    assert.equal((await pipeline.render("/admin", { id: "root", admin: true })).status, 200);
    assert.deepEqual(asked, [["admin", null], ["admin", "eve"], ["admin", "root"]]);
});

test("render: an address no route answers but the catch-all is a 404, and notFound is not asked about it", async () => {
    const { juris, router } = await shop();
    const asked = [];
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", notFound: (own) => { asked.push(own); return false; } });
    const page = await pipeline.render("/nowhere");
    assert.equal(page.status, 404);
    assert.match(page.body.toString(), /not here/);
    assert.deepEqual(asked, []);
});

test("render: a page whose own call notFound says is about nothing is a 404, given that call's answer", async () => {
    const calls = [];
    const { juris, router } = await shop({ calls });
    const asked = [];
    const pipeline = createPagePipeline({
        juris, router, entry: "/b.js",
        notFound: async (own, ctx) => { asked.push({ own, route: ctx.route.name, path: ctx.url.pathname }); return own === null; },
    });
    assert.equal((await pipeline.render("/items/gone")).status, 404);
    assert.equal((await pipeline.render("/items/here")).status, 200);
    // A failed call is answered as undefined.
    assert.equal((await pipeline.render("/items/boom")).status, 200);
    assert.deepEqual(asked, [
        { own: null, route: "item", path: "/items/gone" },
        { own: { id: "here", name: "Item here" }, route: "item", path: "/items/here" },
        { own: undefined, route: "item", path: "/items/boom" },
    ]);
    // A route with no call of its own is never asked about.
    await pipeline.render("/");
    assert.equal(asked.length, 3);
});

test("render names a page from its own call: titleFrom, cut to max, then the suffix; decorate applied last", async () => {
    const { juris, router } = await shop();
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", title: { suffix: " · Shop", max: 6, decorate: (text) => `[${text}]` } });
    assert.equal(titleIn((await pipeline.render("/items/abcdef")).body.toString()), "[Item a · Shop]");
});

test("render: a failed call or a titleFrom that throws never names a page; the route's title, then the fallback, do", async () => {
    const { juris, router } = await pipelineApp({
        services: { async thing() { throw new Error("no"); }, async fine() { return { name: "Fine" }; } },
        routes: [
            { path: "/failed", name: "failed", component: "P", preload: () => [["thing"]], head: { titleFrom: (x) => x.name, title: "Static" } },
            { path: "/throws", name: "throws", component: "P", preload: () => [["fine"]], head: { titleFrom: () => { throw new Error("bad"); }, title: "Static too" } },
            { path: "/bare", name: "bare", component: "P" },
        ],
        components: { P: () => ({ p: { textContent: "p" } }) },
    });
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", title: { fallback: "The Shop" } });
    assert.equal(titleIn((await pipeline.render("/failed")).body.toString()), "Static");
    assert.equal(titleIn((await pipeline.render("/throws")).body.toString()), "Static too");
    assert.equal(titleIn((await pipeline.render("/bare")).body.toString()), "The Shop");
    const plain = createPagePipeline({ juris, router, entry: "/b.js" });
    assert.equal(titleIn((await plain.render("/bare")).body.toString()), "", "no fallback: an empty title");
});

test("render: a failed call's message reaches the page only as the instance's exposeError allows", async () => {
    const calls = [];
    const { juris, router } = await shop({ calls });
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js" });
    const html = (await pipeline.render("/items/boom")).body.toString();
    assert.doesNotMatch(html, /10\.0\.0\.5/, "the driver's words reached the page");
});

test("render asks the app's preload first, then the route's, and puts the app's state roots beside the router's", async () => {
    const calls = [];
    const { juris, router } = await shop({
        calls,
        components: { Item: (props, api) => ({ p: { textContent: () => `${api.getState("shop.name")}: ${api.getState("$route.path")}` } }) },
    });
    const seen = [];
    const pipeline = createPagePipeline({
        juris, router, entry: "/b.js",
        preload: (ctx) => { seen.push(["preload", ctx.route.name, ctx.viewer]); return [["banner"]]; },
        state: async (ctx) => { seen.push(["state", ctx.url.pathname]); return { shop: { name: "Corner" } }; },
    });
    const page = await pipeline.render("/items/x", { id: "u1" });
    const html = page.body.toString();
    assert.deepEqual(calls, [["banner"], ["item", "x"]]);
    assert.deepEqual(seen, [["preload", "item", { id: "u1" }], ["state", "/items/x"]]);
    assert.match(html, /<p[^>]*>Corner: \/items\/x<\/p>/);
    assert.equal(stateIn(html).shop.name, "Corner");
});

test("render takes a preload or state hook that answers nothing as none", async () => {
    const calls = [];
    const { juris, router } = await shop({ calls });
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", preload: () => null, state: () => undefined, head: () => null });
    const page = await pipeline.render("/items/q");
    assert.equal(page.status, 200);
    assert.deepEqual(calls, [["item", "q"]]);
    assert.equal(titleIn(page.body.toString()), "Item q");
});

test("render hands what extra answers, a promise's value, to the route's preload", async () => {
    const { juris, router } = await pipelineApp({
        services: { async who(id) { return { name: `user ${id}` }; } },
        routes: [{ path: "/", name: "home", component: "P", preload: ({ viewerId }) => [["who", viewerId ?? "nobody"]], head: { titleFrom: (who) => who?.name } }],
        components: { P: () => ({ p: { textContent: "p" } }) },
    });
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", extra: async (viewer) => { await sleep(1); return { viewerId: viewer?.id ?? null }; } });
    assert.equal(titleIn((await pipeline.render("/", { id: "u7" })).body.toString()), "user u7");
    assert.equal(titleIn((await pipeline.render("/")).body.toString()), "user nobody");
});

test("render gives head(ctx) the title, and writes what it answers; its description replaces the route's", async () => {
    const { juris, router } = await shop();
    const asked = [];
    const pipeline = createPagePipeline({
        juris, router, entry: "/b.js",
        title: { suffix: " | Shop" },
        head: (ctx) => {
            asked.push({ title: ctx.title, route: ctx.route.name, viewer: ctx.viewer, url: ctx.url.href });
            return ctx.route.name === "item" ? { description: `About ${ctx.title}`, meta: [{ name: "robots", content: "noindex" }] } : {};
        },
    });
    const item = (await pipeline.render("/items/z")).body.toString();
    assert.match(item, /<meta name="description" content="About Item z \| Shop">/);
    assert.match(item, /<meta name="robots" content="noindex">/);
    assert.match((await pipeline.render("/", { id: "u" })).body.toString(), /<meta name="description" content="The home page">/);
    assert.deepEqual(asked, [
        { title: "Item z | Shop", route: "item", viewer: null, url: "http://localhost/items/z" },
        { title: "Home", route: "home", viewer: { id: "u" }, url: "http://localhost/" },          // the suffix follows a titleFrom alone
    ]);
});

test("render gives the route to every hook as resolve named it, and the pipeline never matches the path again", async () => {
    const { juris, router } = await shop();
    const routes = [];
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", preload: (ctx) => { routes.push(ctx.route); return []; } });
    await pipeline.render("/items/abc");
    await pipeline.render("/zzz");
    assert.deepEqual(Object.keys(routes[0]).sort(), ["head", "matched", "meta", "name", "notFound", "params"]);
    assert.equal(routes[0].name, "item");
    assert.deepEqual(routes[0].params, { id: "abc" });
    assert.equal(routes[0].notFound, false);
    assert.equal(routes[1].name, "missing");
    assert.equal(routes[1].notFound, true);
});

test("render: the route's own call counts as read in the trace, whatever the page's body calls", async () => {
    const { juris, router } = await shop();
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js" });
    const page = await pipeline.render("/items/t");
    assert.equal(page.trace.static, false);
    assert.deepEqual(page.trace.services, ["item"]);
    assert.deepEqual(page.trace.calls, [juris.callKey("item", ["t"])]);
    // A page with no call of its own keeps the render's trace as it was.
    const home = await pipeline.render("/");
    assert.deepEqual(home.trace.calls, []);
    assert.deepEqual(home.trace.services, []);
});

test("render: a body that calls the route's own call too counts it once", async () => {
    const { juris, router } = await shop({
        components: { Item: (props, api) => ({ p: { textContent: () => { const value = api.call("item", api.getState("$route.path").split("/").pop()); return value?.name ?? "…"; } } }) },
    });
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js" });
    const page = await pipeline.render("/items/w");
    assert.deepEqual(page.trace.calls, [juris.callKey("item", ["w"])]);
    assert.deepEqual(page.trace.services, ["item"]);
});

test("render asks headers once per page with the hashes of its inline scripts, and keeps what it answers with the page", async () => {
    const { juris, router } = await shop();
    const asked = [];
    const pipeline = createPagePipeline({
        juris, router, entry: "/b.js", devReload: "console.log(1)",
        headers: async (ctx) => { asked.push(ctx); return { "Content-Security-Policy": `script-src ${ctx.scriptHashes.join(" ")}` }; },
    });
    const page = await pipeline.render("/items/h", { id: "v" });
    const html = page.body.toString();
    const inline = [...html.matchAll(/<script(?: type="module")?>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
    assert.equal(inline.length, 2);
    assert.deepEqual(asked[0].scriptHashes, inline);
    assert.deepEqual(asked[0].scriptHashes, inlineScriptHashes(html));
    assert.equal(asked[0].route.name, "item");
    assert.deepEqual(asked[0].viewer, { id: "v" });
    assert.equal(asked[0].url.pathname, "/items/h");
    assert.deepEqual(page.headers, { "Content-Security-Policy": `script-src ${inline.join(" ")}` });
    assert.equal(asked.length, 1);
});

test("render takes a headers hook that answers nothing as no headers, and refuses one that answers no object", async () => {
    const { juris, router } = await shop();
    assert.deepEqual((await createPagePipeline({ juris, router, entry: "/b.js", headers: () => null }).render("/")).headers, {});
    for (const answer of [["x"], "csp", 5]) {
        await assert.rejects(createPagePipeline({ juris, router, entry: "/b.js", headers: () => answer }).render("/"), { name: "TypeError", message: /headers\(ctx\) answers \{ name: value \}/ }, JSON.stringify(answer));
    }
});

test("render refuses a page header the response writes itself, in any case", async () => {
    const { juris, router } = await shop();
    for (const name of ["content-type", "ETag", "Cache-Control", "VARY", "content-encoding", "Content-Length"]) {
        const pipeline = createPagePipeline({ juris, router, entry: "/b.js", headers: () => ({ [name]: "x" }) });
        await assert.rejects(pipeline.render("/"), { name: "TypeError", message: new RegExp(`may not give ${name.toLowerCase()}, which the response writes itself`) }, name);
    }
});

test("render without a headers hook keeps no headers with the page", async () => {
    const { juris, router } = await shop();
    assert.equal((await createPagePipeline({ juris, router, entry: "/b.js" }).render("/")).headers, undefined);
});

// ---- handle: the order ------------------------------------------------------------------------

test("handle: any spelling of a path but its one is a 301 to it, before anything reads it", async (t) => {
    const { juris, router } = await shop();
    const asked = [];
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", viewer: (req) => { asked.push(req.url); return null; } });
    const server = await served(t, pipeline);
    for (const [from, to] of [["/items/../admin", "/admin"], ["//admin", "/admin"], ["/admin/", "/admin"], ["/a/./b?x=1", "/a/b?x=1"], ["/%2e%2e/admin", "/admin"]]) {
        const answer = await request(server.port, from);
        assert.equal(answer.status, 301, from);
        assert.equal(answer.headers.location, to, from);
    }
    assert.deepEqual(asked, [], "the viewer was asked about a path that is not its one spelling");
});

test("handle asks who is asking with the request and its URL, and takes nothing for a guest", async (t) => {
    const { juris, router } = await shop();
    const asked = [];
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", viewer: async (req, url) => { asked.push([req.headers["x-user"] ?? null, url.pathname]); return undefined; } });
    const server = await served(t, pipeline);
    const answer = await request(server.port, "/", { headers: { "x-user": "u1" } });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers["cache-control"], CACHE_CONTROL.public, "a viewer hook that answers nothing is a guest");
    assert.deepEqual(asked, [["u1", "/"]]);
});

test("handle: the router's guard redirects with 302 before the hooks and the cache are asked, and the copy kept for guests is never served past it", async (t) => {
    const { juris, router } = await shop({ guard: adminGuard });
    const cache = watchedCache();
    const hooks = [];
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", cache, viewer: asViewer, before: [() => { hooks.push("before"); return null; }], personal: () => { hooks.push("personal"); return false; } });
    const server = await served(t, pipeline);
    const guest = await request(server.port, "/admin");
    assert.equal(guest.status, 302);
    assert.equal(guest.headers.location, "/");
    assert.equal((await request(server.port, "/admin", { headers: { "x-user": "eve" } })).status, 302);
    assert.deepEqual(hooks, []);
    assert.deepEqual(cache.calls, []);
    const admin = await request(server.port, "/admin", { headers: { "x-user": "root", "x-admin": "1" } });
    assert.equal(admin.status, 200);
    assert.equal(admin.headers["cache-control"], CACHE_CONTROL.private);
});

test("handle: guards are pure, so two viewers' requests through one instance each get their own verdict", async (t) => {
    const { juris, router } = await shop({ guard: adminGuard });
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", viewer: async (req) => { await sleep(req.headers["x-admin"] === "1" ? 15 : 1); return asViewer(req); } });
    const server = await served(t, pipeline);
    const [admin, eve] = await Promise.all([
        request(server.port, "/admin", { headers: { "x-user": "root", "x-admin": "1" } }),
        request(server.port, "/admin", { headers: { "x-user": "eve" } }),
    ]);
    assert.equal(admin.status, 200);
    assert.equal(eve.status, 302);
});

test("handle asks the before hooks in order, and the first to answer a location redirects, 302 unless it says", async (t) => {
    const { juris, router } = await shop();
    const order = [];
    const pipeline = createPagePipeline({
        juris, router, entry: "/b.js", viewer: asViewer,
        before: [
            (ctx) => { order.push(["first", ctx.url.pathname, ctx.route.name, ctx.viewer?.id ?? null, typeof ctx.req.headers]); return null; },
            async (ctx) => { order.push(["second"]); return ctx.url.searchParams.has("old") ? { location: "/new", status: 308 } : ctx.route.name === "search" ? { location: "/login" } : { status: 999 }; },
            () => { order.push(["third"]); return undefined; },
        ],
    });
    const server = await served(t, pipeline);
    const moved = await request(server.port, "/?old=1", { headers: { "x-user": "u1" } });
    assert.equal(moved.status, 308);
    assert.equal(moved.headers.location, "/new");
    const login = await request(server.port, "/search");
    assert.equal(login.status, 302);
    assert.equal(login.headers.location, "/login");
    assert.equal((await request(server.port, "/")).status, 200, "an answer with no location goes on");
    assert.deepEqual(order, [
        ["first", "/", "home", "u1", "object"], ["second"],
        ["first", "/search", "search", null, "object"], ["second"],
        ["first", "/", "home", null, "object"], ["second"], ["third"],
    ]);
});

test("handle takes a single before hook as well as a list", async (t) => {
    const { juris, router } = await shop();
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", before: (ctx) => (ctx.route.name === "home" ? { location: "/items/1" } : null) });
    const server = await served(t, pipeline);
    assert.equal((await request(server.port, "/")).headers.location, "/items/1");
    assert.equal((await request(server.port, "/items/1")).status, 200);
});

// ---- handle: the cache ------------------------------------------------------------------------

test("handle keeps a guest's page and serves the next guest the kept copy, public", async (t) => {
    const calls = [];
    const { juris, router } = await shop({ calls });
    const cache = watchedCache();
    const decisions = [];
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", cache, onRender: (info) => decisions.push(info) });
    const server = await served(t, pipeline);
    const first = await request(server.port, "/items/k");
    const second = await request(server.port, "/items/k");
    assert.equal(first.status, 200);
    assert.equal(second.body, first.body);
    assert.equal(second.headers.etag, first.headers.etag);
    assert.equal(second.headers["cache-control"], CACHE_CONTROL.public);
    assert.deepEqual(calls, [["item", "k"]], "the second guest's page was rendered again");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].key, "/items/k");
    assert.equal(decisions[0].decision.cache, true);
    assert.deepEqual(decisions[0].trace.services, ["item"]);
    assert.equal((await request(server.port, "/items/k", { headers: { "if-none-match": first.headers.etag } })).status, 304);
});

test("handle renders a page the cache may keep from its cache key, so no visitor's other query parameters reach another", async (t) => {
    const calls = [];
    const { juris, router } = await shop({ calls });
    const cache = watchedCache();
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", cache, cacheParams: ["q"] });
    const server = await served(t, pipeline);
    const first = await request(server.port, "/search?utm=mine&q=shoes&token=secret");
    const state = stateIn(first.body);
    assert.deepEqual({ ...state.$route.query }, { q: "shoes" });
    assert.doesNotMatch(first.body, /secret/);
    const second = await request(server.port, "/search?q=shoes&utm=other");
    assert.equal(second.body, first.body);
    assert.deepEqual(calls, [["search", "shoes"]]);
    assert.ok(cache.calls.some(([name, key]) => name === "put" && key === "/search?q=shoes"));
});

test("handle never keeps a 404, nor serves one from the cache", async (t) => {
    const calls = [];
    const { juris, router } = await shop({ calls });
    const cache = watchedCache();
    const decisions = [];
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", cache, notFound: (own) => own === null, onRender: ({ decision }) => decisions.push(decision.reason) });
    const server = await served(t, pipeline);
    assert.equal((await request(server.port, "/items/gone")).status, 404);
    assert.equal((await request(server.port, "/items/gone")).status, 404);
    assert.equal((await request(server.port, "/wp-admin")).status, 404);
    assert.deepEqual(decisions, ["not-found", "not-found", "not-found"]);
    assert.equal(calls.length, 2);
});

// RFC 9110, 13.2.1: the conditional headers are ignored when the answer would not be a 2xx.
test("handle answers a 404 in full whatever If-None-Match names: a missing page is never a 304", async (t) => {
    const { juris, router } = await shop();
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", notFound: (own) => own === null });
    const server = await served(t, pipeline);
    for (const pathname of ["/items/gone", "/wp-admin"]) {
        const first = await request(server.port, pathname);
        const again = await request(server.port, pathname, { headers: { "if-none-match": first.headers.etag } });
        assert.equal(again.status, 404, pathname);
        assert.equal(again.body, first.body, pathname);
    }
});

test("handle renders a viewer's page as asked, sends it private, and never asks the cache about it", async (t) => {
    const calls = [];
    const { juris, router } = await shop({ calls });
    const cache = watchedCache();
    const decisions = [];
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", cache, viewer: asViewer, cacheParams: [], onRender: ({ key, decision }) => decisions.push([key, decision]) });
    const server = await served(t, pipeline);
    await request(server.port, "/items/v");                                   // the guests' copy
    cache.calls.length = 0;
    const mine = await request(server.port, "/search?q=hats&mine=1", { headers: { "x-user": "u1" } });
    assert.equal(mine.headers["cache-control"], CACHE_CONTROL.private);
    assert.deepEqual({ ...stateIn(mine.body).$route.query }, { q: "hats", mine: "1" }, "a viewer's page is rendered from the address as asked");
    const signedIn = await request(server.port, "/items/v", { headers: { "x-user": "u1" } });
    assert.equal(signedIn.headers["cache-control"], CACHE_CONTROL.private);
    assert.deepEqual(cache.calls, [], "the cache was asked about a viewer's page");
    assert.deepEqual(decisions.slice(1).map(([key, decision]) => [key, decision]), [
        ["/search", { cache: false, reason: "personal" }],
        ["/items/v", { cache: false, reason: "personal" }],
    ]);
    assert.deepEqual(calls, [["item", "v"], ["search", "hats"], ["item", "v"]]);
    // The guests' copy is still there for the next guest.
    assert.equal((await request(server.port, "/items/v")).headers["cache-control"], CACHE_CONTROL.public);
    assert.equal(calls.length, 3);
});

test("handle: a guest's request personal says is theirs alone is rendered as asked, sent private, and never kept", async (t) => {
    const calls = [];
    const { juris, router } = await shop({ calls });
    const cache = watchedCache();
    const asked = [];
    const decisions = [];
    const pipeline = createPagePipeline({
        juris, router, entry: "/b.js", cache, viewer: asViewer,
        personal: async (ctx) => { asked.push([ctx.url.search, ctx.route.name, ctx.viewer]); return ctx.url.searchParams.has("refused"); },
        onRender: ({ decision }) => decisions.push(decision),
    });
    const server = await served(t, pipeline);
    await request(server.port, "/search?q=a");                                // the guests' copy
    const own = await request(server.port, "/search?q=a&refused=r1");
    assert.equal(own.headers["cache-control"], CACHE_CONTROL.private);
    assert.equal(stateIn(own.body).$route.query.refused, "r1");
    assert.equal((await request(server.port, "/search?q=a")).headers["cache-control"], CACHE_CONTROL.public);
    assert.doesNotMatch((await request(server.port, "/search?q=a")).body, /r1/, "a guest got the personal page");
    await request(server.port, "/search?q=a&refused=r1", { headers: { "x-user": "u1" } });
    assert.deepEqual(asked.map(([search]) => search), ["?q=a", "?q=a&refused=r1", "?q=a", "?q=a"], "personal was asked about a viewer");
    assert.deepEqual(decisions.map((decision) => decision.reason), ["dependent", "personal", "personal"]);
    assert.equal(cache.calls.filter(([name]) => name === "put").length, 1);
});

test("handle without a cache renders every page and tells onRender the cache is off", async (t) => {
    const calls = [];
    const { juris, router } = await shop({ calls });
    const decisions = [];
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", onRender: ({ key, decision }) => decisions.push([key, decision]) });
    const server = await served(t, pipeline);
    const answer = await request(server.port, "/items/n");
    await request(server.port, "/items/n");
    assert.equal(answer.headers["cache-control"], CACHE_CONTROL.public);
    assert.deepEqual(decisions, [["/items/n", { cache: false, reason: "cache off" }], ["/items/n", { cache: false, reason: "cache off" }]]);
    assert.equal(calls.length, 2);
});

test("render in development writes #juris-dev into every page, which turns the browser's devMode on; never outside it", async () => {
    const { juris, router } = await shop();
    const dev = createPagePipeline({ juris, router, entry: "/b.js", dev: true, viewer: asViewer });
    for (const viewer of [null, { id: "u" }]) {
        const html = (await dev.render("/", viewer)).body.toString();
        assert.ok(html.includes('<script type="application/json" id="juris-dev">{}</script>'), `for ${JSON.stringify(viewer)}`);
    }
    assert.ok((await dev.render("/nowhere", null)).body.toString().includes('id="juris-dev"'), "a 404 too");
    for (const options of [{}, { dev: false }]) {
        const html = (await createPagePipeline({ juris, router, entry: "/b.js", ...options }).render("/", null)).body.toString();
        assert.ok(!html.includes("juris-dev"), JSON.stringify(options));
    }
});

test("handle in development answers every page no-store, a guest's and a viewer's", async (t) => {
    const { juris, router } = await shop();
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", dev: true, viewer: asViewer });
    const server = await served(t, pipeline);
    assert.equal((await request(server.port, "/")).headers["cache-control"], "no-store");
    assert.equal((await request(server.port, "/", { headers: { "x-user": "u" } })).headers["cache-control"], "no-store");
});

test("handle sends a page's own headers with it, from the cache too, and on a 304", async (t) => {
    const { juris, router } = await shop();
    let asked = 0;
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", cache: createPageCache(), headers: () => { asked++; return { "x-frame-options": "DENY" }; } });
    const server = await served(t, pipeline);
    const first = await request(server.port, "/");
    const kept = await request(server.port, "/");
    const again = await request(server.port, "/", { headers: { "if-none-match": first.headers.etag } });
    assert.equal(first.headers["x-frame-options"], "DENY");
    assert.equal(kept.headers["x-frame-options"], "DENY");
    assert.equal(again.status, 304);
    assert.equal(again.headers["x-frame-options"], "DENY");
    assert.equal(asked, 1, "asked once per rendered page");
});

test("handle reads the request's own URL when it is given none", async () => {
    const { juris, router } = await shop();
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js" });
    const res = recorder();
    assert.equal(await pipeline.handle({ url: "/items/r?x=1", headers: {} }, res), true);
    assert.equal(res.statusCode, 200);
    assert.equal(titleIn(res.body), "Item r");
    const given = recorder();
    await pipeline.handle({ url: "/items/r", headers: {} }, given, new URL("http://localhost/items/r"));
    assert.equal(titleIn(given.body), "Item r");
});

test("handle: a render the guard refuses from the cache key (a parameter it reads that the key drops) is a 302, and the key is handed back", async (t) => {
    const { juris, router } = await shop({ guard: (to) => (to.name === "search" && !to.query.ok ? "/" : undefined) });
    const cache = watchedCache();
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", cache, cacheParams: ["q"] });
    const server = await served(t, pipeline);
    const answer = await request(server.port, "/search?q=x&ok=1");
    assert.equal(answer.status, 302);
    assert.equal(answer.headers.location, "/");
    assert.deepEqual(cache.calls.map(([name]) => name), ["get", "snapshot", "release"]);
});

test("handle: a render that throws hands its key back to the cache and the request fails", async (t) => {
    const { juris, router } = await shop();
    const cache = watchedCache();
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", cache, head: () => { throw new Error("head broke"); } });
    const server = await served(t, pipeline);
    const answer = await request(server.port, "/");
    assert.equal(answer.status, 500);
    assert.equal(answer.body, "head broke");
    assert.deepEqual(cache.calls.map(([name, key]) => [name, key]), [["get", "/"], ["snapshot", null], ["release", "/"]]);
});

// ---- stale pages and close() ------------------------------------------------------------------

test("handle serves a stale page as it was, and one render replaces it after the answer, from its key with no request", async (t) => {
    let clock = 0;
    let version = 1;
    const renders = [];
    const held = gate();
    const { juris, router } = await shop({ services: { async item(id) { renders.push(id); if (version === 2) await held.promise; return { id, name: `v${version} ${id}` }; } } });
    const cache = createPageCache({ ttlMs: 100, staleMs: 10_000, now: () => clock });
    const rendered = [];
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", cache, cacheParams: [], viewer: asViewer, onRender: ({ key }) => rendered.push(key) });
    const server = await served(t, pipeline);
    assert.equal(titleIn((await request(server.port, "/items/s?utm=1")).body), "v1 s");
    clock += 200;
    version = 2;
    const a = await request(server.port, "/items/s?utm=2");
    const b = await request(server.port, "/items/s");             // while the replacement renders
    assert.equal(titleIn(a.body), "v1 s", "a stale page is sent as it was");
    assert.equal(titleIn(b.body), "v1 s");
    held.open();
    await pipeline.close();
    assert.deepEqual(renders, ["s", "s"], "one replacement per staleness");
    assert.deepEqual(rendered, ["/items/s", "/items/s"]);
    assert.equal(titleIn((await request(server.port, "/items/s")).body), "v2 s");
});

test("a stale page's replacement that fails goes to onError as \"regenerate\", and the next visitor tries again", async (t) => {
    let clock = 0;
    let fail = false;
    const { juris, router } = await shop();
    const errors = [];
    const cache = createPageCache({ ttlMs: 100, staleMs: 10_000, now: () => clock });
    const pipeline = createPagePipeline({
        juris, router, entry: "/b.js", cache,
        head: () => { if (fail) throw new Error("replacement broke"); return {}; },
        onError: (error, where) => errors.push([where, error.message]),
    });
    const server = await served(t, pipeline);
    await request(server.port, "/items/f");
    clock += 200;
    fail = true;
    assert.equal((await request(server.port, "/items/f")).status, 200);
    await pipeline.close();
    assert.deepEqual(errors, [["regenerate", "replacement broke"]]);
    assert.equal(cache.stats().released, 1, "the key was not handed back");
});

test("a stale page's replacement that fails with no onError is dropped quietly", async (t) => {
    let clock = 0;
    const { juris, router } = await shop();
    let fail = false;
    const cache = createPageCache({ ttlMs: 100, staleMs: 10_000, now: () => clock });
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", cache, head: () => { if (fail) throw new Error("x"); return {}; } });
    const server = await served(t, pipeline);
    await request(server.port, "/");
    clock += 200;
    fail = true;
    assert.equal((await request(server.port, "/")).status, 200);
    await pipeline.close();
    assert.equal(cache.stats().released, 1);
});

test("close() resolves once the replacements under way have finished", async (t) => {
    let clock = 0;
    const slow = gate();
    let slowNow = false;
    const order = [];
    const { juris, router } = await shop({ services: { async item(id) { if (slowNow) { order.push("render started"); await slow.promise; order.push("render done"); } return { id, name: id }; } } });
    const cache = createPageCache({ ttlMs: 100, staleMs: 10_000, now: () => clock });
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", cache });
    const server = await served(t, pipeline);
    await request(server.port, "/items/c");
    clock += 200;
    slowNow = true;
    await request(server.port, "/items/c");
    await sleep(5);                                       // the replacement has begun
    const closed = pipeline.close().then(() => order.push("closed"));
    await sleep(5);
    assert.deepEqual(order, ["render started"]);
    slow.open();
    await closed;
    assert.deepEqual(order, ["render started", "render done", "closed"]);
});

test("close() begins no more replacements: one scheduled and not yet begun hands its key back to the cache", async () => {
    let clock = 0;
    const calls = [];
    const { juris, router } = await shop({ calls });
    const cache = watchedCache({ ttlMs: 100, staleMs: 10_000, now: () => clock });
    const pipeline = createPagePipeline({ juris, router, entry: "/b.js", cache });
    await pipeline.handle({ url: "/items/z", headers: {} }, recorder());
    clock += 200;
    cache.calls.length = 0;
    const res = recorder();
    await pipeline.handle({ url: "/items/z", headers: {} }, res);       // stale: a replacement is scheduled
    await pipeline.close();                                              // before it begins
    assert.equal(res.statusCode, 200);
    assert.deepEqual(cache.calls, [["get", "/items/z"], ["release", "/items/z"]]);
    assert.deepEqual(calls, [["item", "z"]], "a replacement ran after close()");
});
