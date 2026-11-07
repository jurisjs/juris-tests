// router.js without an instance: the URL helpers (parseQuery, formatQuery, splitUrl, joinUrl), the
// options createRouter takes and refuses, the route table (match, resolveTarget, redirects),
// resolve() as a server asks it, the guard's answers, a page's head and titleOf.
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import createRouterDefault, { createRouter, Router, parseQuery, formatQuery, splitUrl, joinUrl, titleOf, ROUTER_COMPONENTS } from "juris/router.js";
import { plain, fakeStorage } from "../support/router-window.mjs";

// Targets a browser would read as another host, given as a Location or an href.
const HOSTILE = ["/\\evil.com", "\\\\evil.com", "//evil.com", "\\/evil.com", "/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "///evil.com"];

// ---- URLs -----------------------------------------------------------------------------------

test("parseQuery builds an object with no prototype, a repeated key as a list", () => {
    const query = parseQuery("?a=1&b=two+words&a=3&a=%26&c=");
    assert.equal(Object.getPrototypeOf(query), null);
    assert.deepEqual(plain(query), { a: ["1", "3", "&"], b: "two words", c: "" });
    assert.deepEqual(plain(parseQuery("x=1")), { x: "1" }, "the leading ? is optional");
    assert.deepEqual(plain(parseQuery("")), {});
});

test("parseQuery keeps a key named after an Object.prototype member, or __proto__, as a plain own key", () => {
    const query = parseQuery("?hasOwnProperty=1&constructor=c&__proto__=a&__proto__=b&toString=t&toString=u");
    assert.equal(Object.getPrototypeOf(query), null, "no key replaces the prototype");
    assert.equal(query.hasOwnProperty, "1");
    assert.equal(query.constructor, "c");
    assert.deepEqual(Object.getOwnPropertyDescriptor(query, "__proto__").value, ["a", "b"]);
    assert.deepEqual(query.toString, ["t", "u"]);
    for (const value of Object.values(query)) assert.notEqual(typeof value, "function");
});

test("formatQuery writes a list as a repeated key, skips null and undefined, and answers empty for nothing", () => {
    assert.equal(formatQuery({ a: ["1", 2], b: null, c: undefined, d: true, e: "x y&z" }), "?a=1&a=2&d=true&e=x+y%26z");
    assert.equal(formatQuery({}), "");
    assert.equal(formatQuery({ gone: null, nope: undefined }), "");
    assert.equal(formatQuery(null), "");
    assert.equal(formatQuery(undefined), "");
});

test("parseQuery and formatQuery put each other back", () => {
    assert.equal(formatQuery(parseQuery("?a=1&a=2&b=%26&c=%C3%A9")), "?a=1&a=2&b=%26&c=%C3%A9");
});

test("splitUrl answers path, query and hash, the path with one leading slash and no trailing one", () => {
    assert.deepEqual(plain(splitUrl("/a/b/?x=1&x=2#top")), { path: "/a/b", query: { x: ["1", "2"] }, hash: "top" });
    assert.deepEqual(plain(splitUrl("")), { path: "/", query: {}, hash: "" });
    assert.deepEqual(plain(splitUrl("a//")), { path: "/a", query: {}, hash: "" });
    assert.deepEqual(plain(splitUrl("#only")), { path: "/", query: {}, hash: "only" });
    assert.deepEqual(plain(splitUrl("?q=1")), { path: "/", query: { q: "1" }, hash: "" });
    assert.deepEqual(plain(splitUrl("/a#x?y=1")), { path: "/a", query: {}, hash: "x?y=1" }, "a ? after the # is the hash's");
    assert.equal(Object.getPrototypeOf(splitUrl("/a?b=1").query), null);
});

test("splitUrl reads a backslash as a slash and drops tabs and newlines, so no path names another host", () => {
    for (const url of HOSTILE) assert.equal(splitUrl(url).path, "/evil.com", JSON.stringify(url));
    assert.equal(splitUrl("/%5Cevil.com").path, "/%5Cevil.com", "an encoded backslash is not one");
    assert.equal(splitUrl("/a\n/b\t").path, "/a/b");
    assert.equal(splitUrl("\\a\\b\\").path, "/a/b");
});

test("joinUrl puts a split URL back together", () => {
    assert.equal(joinUrl({ path: "/a", query: { x: "1", y: ["2", "3"] }, hash: "h" }), "/a?x=1&y=2&y=3#h");
    assert.equal(joinUrl({ path: "/a", query: {}, hash: "" }), "/a");
    assert.equal(joinUrl({ path: "/a" }), "/a");
    for (const url of ["/", "/a/b?c=d#e", "/x#y"]) assert.equal(joinUrl(splitUrl(url)), url);
});

// ---- options ----------------------------------------------------------------------------------

test("createRouter refuses an option it does not know, naming it and the ones it takes", () => {
    assert.throws(() => createRouter({ routes: [], gaurd: () => null }), (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /^Router: "gaurd" is not an option \(/);
        for (const name of ["routes", "mode", "base", "routePath", "scroll", "fullLoad", "guard", "context", "history"]) assert.match(error.message, new RegExp(`\\b${name}\\b`));
        return true;
    });
});

test("guard, context and fullLoad are functions, or not given", () => {
    for (const name of ["guard", "context", "fullLoad"]) {
        for (const wrong of ["yes", true, {}, null]) {
            assert.throws(() => createRouter({ [name]: wrong }), { name: "TypeError", message: `Router: ${name} is a function` }, `${name}: ${String(wrong)}`);
        }
        assert.doesNotThrow(() => createRouter({ [name]: () => null }));
        assert.doesNotThrow(() => createRouter({ [name]: undefined }));
    }
});

test("routePath is a root of the state: a dotted, empty or non-string name is refused", () => {
    for (const wrong of ["app.route", "", 5, {}, ".x"]) {
        assert.throws(() => createRouter({ routePath: wrong }), (error) => error instanceof TypeError && error.message.includes(`not ${JSON.stringify(wrong)}`), JSON.stringify(wrong));
    }
});

test("routePath names where the route is kept", () => {
    const juris = new Juris({ isServer: true });
    const router = createRouter({ routes: [{ path: "/a", name: "a" }], routePath: "nav" });
    juris.use(router);
    juris.setValue("nav.path", "/a");
    assert.equal(juris.stateManager.peek("nav.name"), "a");
    assert.equal(juris.stateManager.peek("$route"), undefined);
    assert.deepEqual(plain(router.resolve("/a").state), { nav: { path: "/a", query: {}, hash: "" } });
});

test("history is { storage, key }, or false; anything else is refused", () => {
    const refused = [
        ["session", /history is \{ storage, key \}/],
        [[], /history is \{ storage, key \}/],
        [{ storge: fakeStorage() }, /history\.storge is not an option \(storage, key\)/],
        [{ key: "" }, /history\.key is a non-empty string/],
        [{ key: 5 }, /history\.key is a non-empty string/],
        [{ storage: {} }, /history\.storage is a Storage/],
        [{ storage: null }, /history\.storage is a Storage/],
    ];
    for (const [history, message] of refused) {
        assert.throws(() => createRouter({ history }), (error) => error instanceof TypeError && message.test(error.message), JSON.stringify(history));
    }
    for (const history of [false, {}, undefined, { key: "mine" }, { storage: fakeStorage() }, { storage: fakeStorage(), key: "k" }]) {
        assert.doesNotThrow(() => createRouter({ history }), JSON.stringify(history));
    }
});

test("createRouter is the default export, and makes a Router; new Router() takes no options at all", () => {
    assert.equal(createRouterDefault, createRouter);
    assert.ok(createRouter() instanceof Router);
    const router = new Router();
    const answer = router.resolve("/anything");
    assert.equal(answer.notFound, true, "an empty table answers nothing");
    assert.equal(answer.name, null);
    assert.deepEqual(plain(answer.state), { $route: { path: "/anything", query: {}, hash: "" } });
});

// ---- the route table ----------------------------------------------------------------------------

const lots = () =>
    createRouter({
        routes: [
            { path: "/", name: "home" },
            {
                path: "/lots",
                name: "lots",
                meta: { area: "lots", auth: true },
                children: [
                    { path: ":id", name: "lot", meta: { auth: false, depth: 1 }, children: [{ path: "files/*rest", name: "files" }] },
                ],
            },
            { path: "/items/new", name: "new-item" },
            { path: "/items/:id", name: "item" },
            { path: "/items/:id/edit", name: "edit" },
            { path: "*", name: "not-found" },
        ],
    });

test("match: the deepest matching record wins, with its chain and decoded params", () => {
    const found = lots().match("/lots/L%201");
    assert.equal(found.name, "lot");
    assert.equal(found.record.path, "/lots/:id");
    assert.deepEqual(found.params, { id: "L 1" });
    assert.deepEqual(found.matched, [1, 2], "the parent, then the child");
    const parent = lots().match("/lots");
    assert.equal(parent.name, "lots");
    assert.deepEqual(parent.matched, [1]);
});

test("match: meta merges over the matched chain, the inner record's keys winning", () => {
    assert.deepEqual(lots().match("/lots/L1").meta, { area: "lots", auth: false, depth: 1 });
    assert.deepEqual(lots().match("/lots").meta, { area: "lots", auth: true });
    assert.deepEqual(lots().match("/").meta, {}, "a record without meta has none");
});

test("match: a tie goes to the record registered first, so a literal before its parameterised sibling wins", () => {
    assert.equal(lots().match("/items/new").name, "new-item");
    assert.equal(lots().match("/items/7").name, "item");
    const reversed = createRouter({ routes: [{ path: "/items/:id", name: "item" }, { path: "/items/new", name: "new-item" }] });
    assert.equal(reversed.match("/items/new").name, "item");
    assert.deepEqual(reversed.match("/items/new").params, { id: "new" });
});

test("match: a catch-all answers only when nothing else does, even registered first", () => {
    const router = createRouter({ routes: [{ path: "*", name: "nf" }, { path: "/a", name: "a" }, { path: "/a/b", name: "ab" }] });
    assert.equal(router.match("/a").name, "a");
    assert.equal(router.match("/a/b").name, "ab");
    const nothing = router.match("/zz/top");
    assert.equal(nothing.name, "nf");
    assert.deepEqual(nothing.params, { pathMatch: "zz/top" });
});

test("match: a named rest parameter takes the rest of the path", () => {
    const found = lots().match("/lots/L1/files/a/b%20c");
    assert.equal(found.name, "files");
    assert.deepEqual(found.params, { id: "L1", rest: "a/b c" });
    assert.deepEqual(found.matched, [1, 2, 3]);
});

test("match: an address no record answers matches nothing", () => {
    const router = createRouter({ routes: [{ path: "/a" }] });
    assert.deepEqual(router.match("/b"), { record: null, params: {}, matched: [], meta: {}, name: undefined });
});

test("match: a segment that cannot be decoded is kept as it arrived, and the route still matches", () => {
    const found = lots().match("/items/%E0%A4%A");
    assert.equal(found.name, "item");
    assert.deepEqual(found.params, { id: "%E0%A4%A" });
    assert.deepEqual(lots().match("/lots/%E0%A4%A/files/%FF").params, { id: "%E0%A4%A", rest: "%FF" });
});

test("match: a literal segment is matched as text, not as a pattern", () => {
    const router = createRouter({ routes: [{ path: "/v1.0/a+b", name: "dotted" }, { path: "/(x)|[y]", name: "brackets" }] });
    assert.equal(router.match("/v1.0/a+b").name, "dotted");
    assert.equal(router.match("/v1x0/a+b").record, null);
    assert.equal(router.match("/v1.0/aab").record, null);
    assert.equal(router.match("/(x)|[y]").name, "brackets");
    assert.equal(router.match("/x").record, null);
});

test("match: a trailing slash on the address still matches its route; the root matches /", () => {
    assert.equal(lots().match("/lots/").name, "lots");
    assert.equal(lots().match("/").name, "home");
});

test("the table: a child's relative path is under its parent's, an absolute one is its own, none is the parent's", () => {
    const router = createRouter({
        routes: [
            { path: "/p", name: "p", children: [{ path: "c", name: "c" }, { path: "/abs", name: "abs" }, { name: "index" }] },
            { path: "/", name: "root", children: [{ path: "x", name: "x" }] },
            { path: "top/", name: "top" },
            { path: "/empty", name: "empty", children: [] },
        ],
    });
    assert.equal(router.match("/p/c").name, "c");
    const abs = router.match("/abs");
    assert.equal(abs.name, "abs");
    assert.deepEqual(abs.matched.map((i) => router.records[i].name), ["p", "abs"], "still nested under its parent");
    assert.equal(router.match("/p").name, "index", "the child without a path is the parent's own address, and deeper");
    assert.equal(router.match("/x").name, "x", "under the root: /x, not //x");
    assert.equal(router.match("/top").name, "top", "a top-level path without its slash");
    assert.equal(router.match("/empty").name, "empty", "an empty children list nests nothing");
});

test("the table: a duplicate route name is refused", () => {
    assert.throws(() => createRouter({ routes: [{ path: "/a", name: "a" }, { path: "/b", children: [{ path: "c", name: "a" }] }] }), {
        name: "Error",
        message: 'Router: duplicate route name "a"',
    });
});

// ---- targets -------------------------------------------------------------------------------------

test("resolveTarget: a name builds the path from its params, each encoded", () => {
    const router = lots();
    const target = router.resolveTarget({ name: "item", params: { id: "a b/c?" }, query: { x: "1" }, hash: "h" });
    assert.deepEqual(target, { path: "/items/a%20b%2Fc%3F", query: { x: "1" }, hash: "h" });
    assert.deepEqual(router.match(target.path).params, { id: "a b/c?" }, "and match reads it back");
    assert.deepEqual(router.resolveTarget({ name: "item", params: { id: 7 } }), { path: "/items/7", query: {}, hash: "" });
    assert.deepEqual(router.resolveTarget({ name: "home" }), { path: "/", query: {}, hash: "" });
});

test("resolveTarget: a param the target leaves out comes from the current route, or is refused", () => {
    const router = lots();
    assert.equal(router.resolveTarget({ name: "edit" }, { path: "/items/7", params: { id: "7" } }).path, "/items/7/edit");
    assert.equal(router.resolveTarget({ name: "edit", params: { id: "8" } }, { params: { id: "7" } }).path, "/items/8/edit", "the target's own wins");
    assert.throws(() => router.resolveTarget({ name: "edit" }), { name: "Error", message: 'Router: missing param "id" for route "edit"' });
    assert.throws(() => router.resolveTarget({ name: "edit" }, { params: {} }), /missing param "id"/);
});

test("resolveTarget: a rest parameter is filled by its name, the catch-all by pathMatch", () => {
    const router = lots();
    assert.equal(router.resolveTarget({ name: "files", params: { id: "L1", rest: "doc" } }).path, "/lots/L1/files/doc");
    assert.equal(router.resolveTarget({ name: "not-found", params: { pathMatch: "gone" } }).path, "/gone");
    assert.equal(router.resolveTarget({ name: "not-found" }, { params: { pathMatch: "here" } }).path, "/here", "pathMatch from the current route");
    assert.throws(() => router.resolveTarget({ name: "not-found" }), { message: 'Router: missing param "pathMatch" for route "not-found"' });
});

test("resolveTarget: an unknown route name is refused", () => {
    assert.throws(() => lots().resolveTarget({ name: "nope" }), { name: "Error", message: 'Router: unknown route name "nope"' });
});

test("resolveTarget: an object without a name keeps the current path, or goes to /", () => {
    const router = lots();
    assert.deepEqual(router.resolveTarget({ query: { q: "1" } }, { path: "/lots", query: { old: "1" }, hash: "h" }), { path: "/lots", query: { q: "1" }, hash: "" });
    assert.deepEqual(router.resolveTarget({ path: "lots/", hash: "x" }), { path: "/lots", query: {}, hash: "x" });
    assert.deepEqual(router.resolveTarget({}), { path: "/", query: {}, hash: "" });
    assert.deepEqual(router.resolveTarget(undefined), { path: "/", query: {}, hash: "" });
    assert.deepEqual(plain(router.resolveTarget("/lots?x=1#y")), { path: "/lots", query: { x: "1" }, hash: "y" });
});

test("resolveTarget: no target names another host", () => {
    const router = createRouter({ routes: [{ path: "/" }, { path: "/:id", name: "any" }, { path: "*", name: "rest" }] });
    for (const target of HOSTILE) {
        assert.equal(router.resolveTarget(target).path, "/evil.com", JSON.stringify(target));
        assert.equal(router.resolveTarget({ path: target }).path, "/evil.com", JSON.stringify(target));
    }
    assert.equal(router.resolveTarget("/%5Cevil.com").path, "/%5Cevil.com");
    assert.equal(router.resolveTarget({ name: "any", params: { id: "//evil.com" } }).path, "/%2F%2Fevil.com");
});

test("followRedirects: follows a string, an object and a function, each given the params of the route it leaves", () => {
    const seen = [];
    const router = createRouter({
        routes: [
            { path: "/old/:id", redirect: { name: "older" } },
            { path: "/older/:id", name: "older", redirect: (to) => (seen.push(to), `/new/${to.params.id}?from=older`) },
            { path: "/new/:id", name: "new" },
            { path: "/short", redirect: "/new/s" },
        ],
    });
    assert.deepEqual(plain(router.followRedirects(router.resolveTarget("/old/7?x=1"))), { path: "/new/7", query: { from: "older" }, hash: "" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, "/older/7");
    assert.deepEqual(seen[0].params, { id: "7" });
    assert.equal(router.followRedirects(router.resolveTarget("/short")).path, "/new/s");
    const still = router.resolveTarget("/new/1");
    assert.equal(router.followRedirects(still), still, "a route without a redirect is answered as it came");
});

test("followRedirects: a loop is refused, not followed for ever", () => {
    let hops = 0;
    const router = createRouter({ routes: [{ path: "/a", redirect: () => (hops += 1, "/b") }, { path: "/b", redirect: "/a" }] });
    assert.throws(() => router.followRedirects(router.resolveTarget("/a")), { name: "Error", message: /^Router: too many redirects resolving "\/(a|b)"$/ });
    assert.ok(hops > 1 && hops <= 10, `a bounded number of hops (${hops})`);
    assert.throws(() => router.resolve("/b"), /too many redirects/, "resolve() refuses it the same way");
});

// ---- resolve: a server's question ------------------------------------------------------------------

const shop = (options = {}) =>
    createRouter({
        routes: [
            {
                path: "/lots",
                name: "lots",
                meta: { section: "lots" },
                head: { title: "Lots", description: "Every lot" },
                preload: ({ query, viewer }) => [["lots.list", query.page ?? "1", viewer ?? null]],
                children: [
                    { path: ":id", name: "lot", head: { titleFrom: (lot) => lot.name, dataPath: "lot" }, preload: ({ params, path }) => [["lots.get", params.id, path]] },
                    { path: ":id/log", name: "log", preload: () => undefined },
                ],
            },
            { path: "/old", redirect: "/lots" },
            { path: "/login", name: "login" },
            { path: "/files/*rest", name: "files" },
            { path: "*", name: "missing" },
        ],
        ...options,
    });

test("resolve: the state, the preload list and the route an address lands on", () => {
    const answer = shop().resolve("/lots/L1?page=2#top", { viewer: "ann" });
    assert.deepEqual(plain(answer.state), { $route: { path: "/lots/L1", query: { page: "2" }, hash: "top" } });
    assert.deepEqual(answer.preload, [["lots.list", "2", "ann"], ["lots.get", "L1", "/lots/L1"]], "outermost first, with the location, params and extra");
    assert.equal(answer.redirect, null);
    assert.equal(answer.name, "lot");
    assert.deepEqual(answer.params, { id: "L1" });
    assert.deepEqual(answer.meta, { section: "lots" });
    assert.deepEqual(answer.matched, [0, 1]);
    assert.equal(answer.notFound, false);
    assert.equal(answer.head.title, "Lots");
    assert.equal(answer.head.dataPath, "lot");
    assert.equal(answer.head.description, "Every lot");
    assert.equal(typeof answer.head.titleFrom, "function");
});

test("resolve: a preload that answers nothing adds nothing, and a record without one is skipped", () => {
    assert.deepEqual(shop().resolve("/lots/L1/log").preload, [["lots.list", "1", null]]);
    assert.deepEqual(shop().resolve("/login").preload, []);
});

test("resolve: the table's redirect is answered as a URL, with the route it lands on", () => {
    const answer = shop().resolve("/old?keep=1");
    assert.equal(answer.redirect, "/lots");
    assert.equal(answer.name, "lots");
    assert.deepEqual(plain(answer.state), { $route: { path: "/lots", query: {}, hash: "" } });
    assert.equal(shop().resolve("/lots/").redirect, null, "another spelling of the same address is no redirect");
});

test("resolve: notFound is true for the bare catch-all or no record, false for a named rest parameter", () => {
    const missing = shop().resolve("/nowhere");
    assert.equal(missing.notFound, true);
    assert.equal(missing.name, "missing");
    assert.deepEqual(missing.params, { pathMatch: "nowhere" });
    assert.equal(shop().resolve("/files/a/b").notFound, false);
    const empty = createRouter({ routes: [{ path: "/a" }] }).resolve("/b");
    assert.equal(empty.notFound, true);
    assert.equal(empty.name, null);
    assert.deepEqual(empty.matched, []);
    assert.deepEqual(empty.head, {});
    const nested = createRouter({ routes: [{ path: "/docs", children: [{ path: "*", name: "docs-missing" }] }] }).resolve("/docs/x");
    assert.equal(nested.name, "docs-missing");
    assert.equal(nested.notFound, true);
    assert.equal(createRouter({ routes: [{ path: "/a" }] }).resolve("/a").name, null, "a route without a name answers null");
});

test("resolve: an absolute URL's origin is dropped; the base is taken off the address and put on the redirect", () => {
    const router = shop({ base: "/app/" });
    const answer = router.resolve("https://example.com/app/lots/L1?x=1#h");
    assert.equal(answer.name, "lot");
    assert.deepEqual(plain(answer.state.$route), { path: "/lots/L1", query: { x: "1" }, hash: "h" });
    assert.equal(router.resolve("http://example.com/app/old").redirect, "/app/lots");
    assert.equal(router.resolve("/app").state.$route.path, "/");
    assert.deepEqual(plain(router.resolve("/app?x=1").state.$route), { path: "/", query: { x: "1" }, hash: "" });
    assert.deepEqual(plain(router.resolve("/app#frag").state.$route), { path: "/", query: {}, hash: "frag" });
    assert.equal(router.resolve("/application").state.$route.path, "/application", "a path that only starts with the base's letters is not under it");
    assert.equal(shop({ base: "/" }).resolve("/old").redirect, "/lots", "a base of / is no base");
});

test("resolve: the guard is asked with the route and the context, and a location it answers is the redirect", () => {
    const asked = [];
    const router = shop({
        guard: (to, ctx) => {
            asked.push([to, ctx]);
            return to.name === "lot" && !ctx.user ? { name: "login", query: { next: to.path } } : null;
        },
    });
    const refused = router.resolve("/lots/L1?page=3", null, { user: null });
    assert.equal(refused.redirect, "/login?next=%2Flots%2FL1");
    const [to, ctx] = asked[0];
    assert.deepEqual(plain({ path: to.path, query: to.query, hash: to.hash, params: to.params, name: to.name, meta: to.meta }), {
        path: "/lots/L1",
        query: { page: "3" },
        hash: "",
        params: { id: "L1" },
        name: "lot",
        meta: { section: "lots" },
    });
    assert.deepEqual(ctx, { user: null });
    assert.equal(router.resolve("/lots/L1", null, { user: "ann" }).redirect, null);
});

test("resolve: with no context given the guard is asked with an empty one", () => {
    const contexts = [];
    const router = shop({ guard: (to, ctx) => void contexts.push(ctx) });
    router.resolve("/lots");
    router.resolve("/lots", null, null);
    assert.deepEqual(contexts, [{}, {}]);
});

test("resolve: a guard's answer goes through the table's redirects, and is relative to the refused route", () => {
    const router = shop({ base: "/app", guard: (to) => (to.name === "lot" ? "/old" : to.name === "log" ? { name: "lot" } : null) });
    assert.equal(router.resolve("/app/lots/L1").redirect, "/app/lots");
    assert.equal(router.resolve("/app/lots/L9/log").redirect, "/app/lots/L9", "the refused route's params fill the target's");
});

test("resolve: a guard's answer cannot name another host", () => {
    const router = createRouter({ routes: [{ path: "/" }, { path: "/go" }], guard: (to) => (to.path === "/go" ? to.query.next : null) });
    for (const next of HOSTILE) assert.equal(router.resolve(`/go?next=${encodeURIComponent(next)}`).redirect, "/evil.com", JSON.stringify(next));
    assert.equal(router.resolve(`/go?next=${encodeURIComponent("/%5Cevil.com")}`).redirect, "/%5Cevil.com");
});

test("guard: answering nothing, null or true lets the route open", () => {
    for (const answer of [undefined, null, true]) {
        const router = shop({ guard: () => answer });
        assert.equal(router.resolve("/lots").redirect, null, String(answer));
    }
});

test("guard: false, an empty string, a number, a function or a promise is refused with a TypeError", () => {
    const cases = [
        [false, "false"],
        ["", '""'],
        [0, "0"],
        [1, "1"],
        [Promise.resolve("/login"), "[object Promise]"],
        [{ then() { } }, "[object Object]"],
    ];
    for (const [answer, said] of cases) {
        const router = shop({ guard: () => answer });
        assert.throws(() => router.resolve("/lots"), (error) => {
            assert.ok(error instanceof TypeError);
            assert.equal(error.message, `Router: a guard answers a location to go to instead, or nothing; for "/lots" it answered ${said}`);
            return true;
        }, said);
    }
    assert.throws(() => shop({ guard: () => () => "/login" }).resolve("/lots"), TypeError);
});

// ---- a page's name ------------------------------------------------------------------------------

test("headOf merges each record's head over its parents', outermost first", () => {
    const router = createRouter({
        routes: [
            { path: "/lots", head: { title: "Lots", description: "Every lot" }, children: [{ path: ":id", name: "lot", head: { title: "A lot", dataPath: "lot" } }] },
        ],
    });
    assert.deepEqual(router.headOf(router.match("/lots/1").matched), { title: "A lot", description: "Every lot", dataPath: "lot" });
    assert.deepEqual(router.resolve("/lots/1").head, { title: "A lot", description: "Every lot", dataPath: "lot" });
    assert.deepEqual(router.headOf(router.match("/lots").matched), { title: "Lots", description: "Every lot" });
});

test("headOf: meta.title and meta.titleFrom stand in where no head says", () => {
    const named = (data) => data.name;
    const router = createRouter({
        routes: [
            { path: "/old", meta: { title: "Old", titleFrom: named } },
            { path: "/both", meta: { title: "From meta" }, head: { title: "From head" } },
            { path: "/p", meta: { title: "Parent" }, children: [{ path: "c", meta: { title: "Child" } }] },
        ],
    });
    assert.deepEqual(router.resolve("/old").head, { title: "Old", titleFrom: named });
    assert.equal(router.resolve("/both").head.title, "From head");
    assert.equal(router.resolve("/p/c").head.title, "Child", "the inner record's meta, as with meta itself");
});

test("headOf: no chain, or indices the table does not have, give an empty head", () => {
    const router = createRouter({ routes: [{ path: "/a", head: { title: "A" } }] });
    assert.deepEqual(router.headOf(), {});
    assert.deepEqual(router.headOf(null), {});
    assert.deepEqual(router.headOf([7, 8]), {});
    assert.deepEqual(router.headOf([7, 0]), { title: "A" });
});

test("titleOf names a page from its data, cut to max and followed by the suffix", () => {
    const head = { title: "Lot", titleFrom: (lot) => lot.name };
    assert.equal(titleOf(head, { name: "L-100" }, { suffix: " · Shop" }), "L-100 · Shop");
    assert.equal(titleOf(head, { name: "L-100" }, { suffix: " · Shop", max: 3 }), "L-1 · Shop");
    assert.equal(titleOf(head, { name: "abc" }, { max: 3 }), "abc", "a name no longer than max is whole");
    assert.equal(titleOf({ titleFrom: () => 42 }, {}), "42", "a name that is not a string is written as one");
});

test("titleOf: without a name, the head's title, then the fallback; the suffix only follows a name", () => {
    assert.equal(titleOf({ title: "Lots" }, null, { suffix: " · Shop", fallback: "Shop" }), "Lots");
    assert.equal(titleOf({}, undefined, { fallback: "Shop" }), "Shop");
    assert.equal(titleOf(undefined, undefined, { fallback: "Shop", suffix: " · x" }), "Shop");
    assert.equal(titleOf(null), "");
    assert.equal(titleOf({ title: "Lots", titleFrom: "not a function" }, { name: "x" }), "Lots");
});

test("titleOf: a titleFrom that throws, answers nothing, or has no data never names the page", () => {
    let calls = 0;
    const counting = { title: "Lot", titleFrom: () => (calls += 1, "named") };
    assert.equal(titleOf(counting, undefined), "Lot");
    assert.equal(titleOf(counting, null), "Lot");
    assert.equal(calls, 0, "no data: not asked");
    assert.equal(titleOf({ title: "Lot", titleFrom: () => { throw new Error("no name"); } }, { x: 1 }, { suffix: "!" }), "Lot");
    assert.equal(titleOf({ title: "Lot", titleFrom: () => "" }, { x: 1 }, { suffix: "!" }), "Lot");
    assert.equal(titleOf({ titleFrom: () => null }, { x: 1 }, { fallback: "App" }), "App");
});

test("titleOf: max counts code points, so a cut never leaves half an emoji", () => {
    const head = { titleFrom: (data) => data.name };
    const title = titleOf(head, { name: "😀😀😀" }, { max: 2 });
    assert.equal(title, "😀😀");
    assert.equal(Array.from(title).length, 2);
    assert.doesNotMatch(title, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "no lone surrogate");
    assert.equal(titleOf(head, { name: "a😀b" }, { max: 2, suffix: "…" }), "a😀…");
});

// ---- hash mode, as a server reads it ----------------------------------------------------------------

test("hash mode: the route is the fragment, and the base goes in front of it", () => {
    const router = createRouter({ routes: [{ path: "/a", name: "a" }, { path: "/old", redirect: "/a?from=old" }], mode: "hash", base: "/app" });
    assert.deepEqual(plain(router.resolve("/app/index.html#/a?x=1#inner").state.$route), { path: "/a", query: { x: "1" }, hash: "inner" });
    assert.equal(router.resolve("/app/index.html").state.$route.path, "/", "no fragment is the root");
    assert.equal(router.resolve("/app/index.html#").state.$route.path, "/", "an empty fragment too");
    assert.equal(router.resolve("/app/#/old").redirect, "/app#/a?from=old");
});

// ---- components -------------------------------------------------------------------------------

test("ROUTER_COMPONENTS names, frozen, the components installing a router registers", () => {
    assert.deepEqual([...ROUTER_COMPONENTS], ["RouterView", "Link"]);
    assert.ok(Object.isFrozen(ROUTER_COMPONENTS));
    const juris = new Juris({ isServer: true });
    for (const name of ROUTER_COMPONENTS) assert.equal(juris.hasComponent(name), false, `${name} before`);
    juris.use(createRouter({ routes: [] }));
    for (const name of ROUTER_COMPONENTS) assert.equal(juris.hasComponent(name), true, `${name} after`);
});
