// createPageCache: put and get, a page past its TTL served stale while exactly one caller renders it
// again (and release when that fails), invalidation by service or of everything, the race between a
// render and a change (snapshot), a refused or failed render's effect on the copy kept before it,
// the bounded LRU and the share of it pages with a query may hold, purge, clear, and stats().
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPageCache, EVERYTHING } from "juris-kit/server/page-cache.js";

const staticTrace = () => ({ static: true, services: [], roots: [], flags: [], unknown: [], failed: [] });
const reads = (...services) => ({ static: false, services, roots: [], flags: [], unknown: [], failed: [] });
const guest = {};

// A cache on a clock the test moves.
function cacheAt(options = {}) {
    const clock = { now: 0 };
    const cache = createPageCache({ now: () => clock.now, ...options });
    return { cache, clock };
}

// ---- put and get ----------------------------------------------------------------------------------

test("a page put is got back as it was, fresh", () => {
    const { cache } = cacheAt();
    const entry = { html: "<p>hi</p>", status: 200 };
    assert.deepEqual(cache.put("/", entry, staticTrace(), guest), { cache: true, reason: "static", forever: true, services: [] });
    assert.ok(cache.has("/"));
    const hit = cache.get("/");
    assert.equal(hit.entry, entry);
    assert.equal(hit.stale, false);
    assert.equal(cache.stats().hits, 1);
    assert.equal(cache.stats().stores, 1);
});

test("a key never put is a miss", () => {
    const { cache } = cacheAt();
    assert.equal(cache.get("/nowhere"), null);
    assert.equal(cache.has("/nowhere"), false);
    assert.equal(cache.stats().misses, 1);
});

test("a put of a key already kept replaces its page", () => {
    const { cache } = cacheAt();
    cache.put("/", "old", staticTrace(), guest);
    cache.put("/", "new", reads("chat"), guest);
    assert.equal(cache.get("/").entry, "new");
    assert.equal(cache.stats().entries, 1);
    cache.invalidate("chat");
    assert.equal(cache.has("/"), false, "the replacement's services are the ones that count");
});

test("the cache's unkeyedRoots refuse a page that read one of them", () => {
    const { cache } = cacheAt({ unkeyedRoots: ["locale"] });
    const read = { ...staticTrace(), roots: ["locale"] };
    assert.deepEqual(cache.put("/", "page", read, guest), { cache: false, reason: "request-state:locale" });
    assert.equal(cache.has("/"), false);
});

// ---- the TTL and regeneration -------------------------------------------------------------------

test("past its TTL a page is served stale, and only the first caller is told to render it again", () => {
    const { cache, clock } = cacheAt({ ttlMs: 1000, staleMs: 10_000 });
    cache.put("/news", "v1", reads("news"), guest);
    clock.now = 999;
    assert.deepEqual(cache.get("/news"), { entry: "v1", stale: false });
    clock.now = 1000;
    assert.deepEqual(cache.get("/news"), { entry: "v1", stale: true }, "this caller regenerates");
    assert.deepEqual(cache.get("/news"), { entry: "v1", stale: false }, "the others are served the stale page");
    assert.deepEqual(cache.get("/news"), { entry: "v1", stale: false });
    assert.equal(cache.stats().stale, 3);
    cache.put("/news", "v2", reads("news"), guest);
    assert.equal(cache.stats().regenerated, 1);
    assert.deepEqual(cache.get("/news"), { entry: "v2", stale: false }, "the next visitor gets the fresh one");
});

test("a regeneration that failed hands the flag back, so the next caller tries again", () => {
    const { cache, clock } = cacheAt({ ttlMs: 1000 });
    cache.put("/news", "v1", reads("news"), guest);
    clock.now = 1500;
    assert.equal(cache.get("/news").stale, true);
    assert.equal(cache.get("/news").stale, false);
    cache.release("/news");
    assert.equal(cache.stats().released, 1);
    assert.equal(cache.get("/news").stale, true);
});

test("release of a page nobody is regenerating, or of no page, changes nothing", () => {
    const { cache } = cacheAt();
    cache.put("/", "v1", reads("x"), guest);
    cache.release("/");
    cache.release("/nowhere");
    assert.equal(cache.stats().released, 0);
    assert.deepEqual(cache.get("/"), { entry: "v1", stale: false });
});

test("past staleMs a page is too old to trust: a miss, and gone", () => {
    const { cache, clock } = cacheAt({ ttlMs: 1000, staleMs: 5000 });
    cache.put("/news", "v1", reads("news"), guest);
    clock.now = 4999;
    assert.equal(cache.get("/news").stale, true);
    clock.now = 5000;
    assert.equal(cache.get("/news"), null);
    assert.equal(cache.has("/news"), false);
    assert.equal(cache.stats().misses, 1);
});

test("a static page never expires", () => {
    const { cache, clock } = cacheAt({ ttlMs: 1000, staleMs: 5000 });
    cache.put("/about", "page", staticTrace(), guest);
    clock.now = 1e9;
    assert.deepEqual(cache.get("/about"), { entry: "page", stale: false });
});

test("by default a page is fresh for a minute and trusted for ten, on the wall clock", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
    const cache = createPageCache();
    cache.put("/news", "v1", reads("news"), guest);
    t.mock.timers.tick(59_999);
    assert.equal(cache.get("/news").stale, false);
    t.mock.timers.tick(1);
    assert.equal(cache.get("/news").stale, true);
    t.mock.timers.tick(9 * 60_000 - 1);
    assert.equal(cache.get("/news").entry, "v1");
    t.mock.timers.tick(1);
    assert.equal(cache.get("/news"), null);
});

// ---- invalidation ---------------------------------------------------------------------------------

test("a change that names a service drops exactly the pages that read it", () => {
    const { cache } = cacheAt();
    cache.put("/chat/1", "a", reads("chat", "users"), guest);
    cache.put("/users", "b", reads("users"), guest);
    cache.put("/weather", "c", reads("weather"), guest);
    cache.put("/about", "d", staticTrace(), guest);
    cache.invalidate("users");
    assert.deepEqual(["/chat/1", "/users", "/weather", "/about"].map((k) => cache.has(k)), [false, false, true, true]);
    assert.equal(cache.stats().dropped, 2);
    assert.equal(cache.stats().invalidations, 1);
});

test("targets are read as the change bus carries them: names, { name, ... }, or a list of either", () => {
    const { cache } = cacheAt();
    for (const s of ["a", "b", "c", "d"]) cache.put(`/${s}`, s, reads(s), guest);
    cache.invalidate({ name: "a", args: [1] });
    assert.equal(cache.has("/a"), false);
    cache.invalidate(["b", { name: "c" }]);
    assert.deepEqual(["/b", "/c", "/d"].map((k) => cache.has(k)), [false, false, true]);
});

test("a static page survives every named change, and only $pages or clear drop it", () => {
    const { cache } = cacheAt();
    cache.put("/about", "page", staticTrace(), guest);
    cache.invalidate(["chat", "users", { name: "anything" }]);
    assert.ok(cache.has("/about"));
    cache.invalidate(EVERYTHING);
    assert.equal(cache.has("/about"), false);
});

test("$pages, or a target that cannot be read, drops every page", () => {
    for (const target of [EVERYTHING, { name: EVERYTHING }, null, undefined, {}, { name: "" }, 42, ["chat", null]]) {
        const { cache } = cacheAt();
        cache.put("/about", "a", staticTrace(), guest);
        cache.put("/chat", "b", reads("chat"), guest);
        cache.put("/weather", "c", reads("weather"), guest);
        cache.invalidate(target);
        assert.equal(cache.stats().entries, 0, JSON.stringify(target) ?? String(target));
        assert.equal(cache.stats().dropped, 3);
    }
});

// ---- the race between a render and a change -------------------------------------------------------

test("a page whose service was invalidated while it rendered is refused, and the older copy dropped", () => {
    const { cache } = cacheAt();
    cache.put("/chat", "old", reads("chat"), guest);
    const before = cache.snapshot();
    cache.invalidate("chat");                 // dropped the old copy; a render was under way
    cache.put("/chat", "old again", reads("chat"), guest);   // a render that started later is let in
    const decision = cache.put("/chat", "read before the change", reads("chat"), guest, before);
    assert.equal(decision.cache, false);
    assert.equal(decision.reason, "raced");
    assert.equal(cache.has("/chat"), false, "not stored, and the copy there is not served either");
    assert.equal(cache.stats().raced, 1);
});

test("a page whose services did not move while it rendered is stored, whatever else changed", () => {
    const { cache } = cacheAt();
    const before = cache.snapshot();
    cache.invalidate("weather");
    assert.equal(cache.put("/chat", "page", reads("chat"), guest, before).cache, true);
    assert.equal(cache.get("/chat").entry, "page");
});

test("a page rendered for a service invalidated before its first snapshot is stored", () => {
    const { cache } = cacheAt();
    cache.invalidate("chat");
    const before = cache.snapshot();
    assert.equal(cache.put("/chat", "page", reads("chat"), guest, before).cache, true);
});

test("any page, a static one too, rendered across $pages or clear() is refused", () => {
    for (const change of [(cache) => cache.invalidate(EVERYTHING), (cache) => cache.clear(), (cache) => cache.invalidate(null)]) {
        const { cache } = cacheAt();
        const before = cache.snapshot();
        change(cache);
        assert.deepEqual(cache.put("/about", "page", staticTrace(), guest, before),
            { cache: false, reason: "raced", forever: true, services: [] });
        assert.equal(cache.has("/about"), false);
        assert.equal(cache.put("/about", "page", staticTrace(), guest, cache.snapshot()).cache, true, "a later render is let in");
    }
});

test("a snapshot is a copy: what moves after it is compared against it, not with it", () => {
    const { cache } = cacheAt();
    const before = cache.snapshot();
    cache.invalidate("chat");
    assert.equal(before.versions.get("chat"), undefined);
    assert.equal(cache.snapshot().versions.get("chat"), 1);
});

// ---- a refused render ---------------------------------------------------------------------------

test("a render that may not be kept removes the copy kept before it", () => {
    for (const [trace, context, reason] of [
        [{ ...staticTrace(), flags: ["clock"] }, guest, "volatile:clock"],
        [{ ...staticTrace(), unknown: ["Card"] }, guest, "unknown:Card"],
        [staticTrace(), { status: 404 }, "not-found"],
        [staticTrace(), { viewer: { id: "u1" } }, "personal"],
    ]) {
        const { cache } = cacheAt();
        cache.put("/p", "kept", reads("x"), guest);
        assert.equal(cache.put("/p", "now", trace, context).reason, reason);
        assert.equal(cache.has("/p"), false, reason);
        assert.equal(cache.stats().skipped, 1);
        assert.equal(cache.stats().dropped, 1);
    }
});

test("a refused render with nothing kept before it drops nothing", () => {
    const { cache } = cacheAt();
    cache.put("/p", "now", staticTrace(), { status: 404 });
    assert.equal(cache.stats().skipped, 1);
    assert.equal(cache.stats().dropped, 0);
});

test("a render whose preloaded call failed leaves the page kept before it as it was", () => {
    const { cache } = cacheAt();
    cache.put("/post/1", "the page", reads("post"), guest);
    const decision = cache.put("/post/1", "the failure", { ...reads("post"), failed: ["post"] }, guest);
    assert.deepEqual(decision, { cache: false, reason: "failed:post" });
    assert.deepEqual(cache.get("/post/1"), { entry: "the page", stale: false });
    assert.equal(cache.stats().dropped, 0);
    assert.equal(cache.stats().released, 0, "nothing was handed out");
});

test("a failed render of a stale page hands its regeneration back for the next visitor", () => {
    const { cache, clock } = cacheAt({ ttlMs: 1000 });
    cache.put("/post/1", "the page", reads("post"), guest);
    clock.now = 2000;
    assert.equal(cache.get("/post/1").stale, true);
    cache.put("/post/1", "the failure", { ...reads("post"), failed: ["post"] }, guest);
    assert.equal(cache.stats().released, 1);
    assert.deepEqual(cache.get("/post/1"), { entry: "the page", stale: true });
});

test("a failed render that was also flagged volatile still leaves the page kept before it", () => {
    const { cache } = cacheAt();
    cache.put("/post/1", "the page", reads("post"), guest);
    cache.put("/post/1", "the failure", { ...reads("post"), failed: ["post"], flags: ["clock"] }, guest);
    assert.equal(cache.get("/post/1").entry, "the page");
});

test("a failed render with nothing kept before it keeps nothing", () => {
    const { cache } = cacheAt();
    cache.put("/post/404", "the failure", { ...staticTrace(), failed: ["post"] }, guest);
    assert.equal(cache.has("/post/404"), false);
    assert.equal(cache.stats().entries, 0);
});

// ---- services no change names ---------------------------------------------------------------------

test("a page that depends on a service no touches names is warned about, once per service", () => {
    const warnings = [];
    const { cache } = cacheAt({ invalidatable: new Set(["chat"]), onWarn: (message) => warnings.push(message) });
    cache.put("/a", "a", reads("chat", "weather"), guest);
    cache.put("/b", "b", reads("weather", "stocks"), guest);
    cache.put("/c", "c", staticTrace(), guest);
    assert.deepEqual(warnings, [
        'page cache: pages depend on "weather" but no mutation\'s touches names it — they will only ever expire by TTL',
        'page cache: pages depend on "stocks" but no mutation\'s touches names it — they will only ever expire by TTL',
    ]);
    assert.ok(cache.has("/a") && cache.has("/b"), "warned about, still kept");
});

test("no warning without an invalidatable set, nor without onWarn", () => {
    const warnings = [];
    const { cache } = cacheAt({ onWarn: (message) => warnings.push(message) });
    cache.put("/a", "a", reads("weather"), guest);
    assert.deepEqual(warnings, []);
    const quiet = cacheAt({ invalidatable: new Set() }).cache;
    assert.equal(quiet.put("/a", "a", reads("weather"), guest).cache, true);
});

test("a page whose put is refused is not warned about", () => {
    const warnings = [];
    const { cache } = cacheAt({ invalidatable: new Set(), onWarn: (message) => warnings.push(message) });
    cache.put("/a", "a", { ...reads("weather"), flags: ["clock"] }, guest);
    assert.deepEqual(warnings, []);
});

// ---- the bound and the share of pages with a query ------------------------------------------------

test("a full cache makes room by dropping the least recently used page", () => {
    const { cache } = cacheAt({ maxEntries: 2 });
    cache.put("/a", "a", staticTrace(), guest);
    cache.put("/b", "b", staticTrace(), guest);
    cache.get("/a");
    cache.put("/c", "c", staticTrace(), guest);
    assert.deepEqual(["/a", "/b", "/c"].map((k) => cache.has(k)), [true, false, true]);
    assert.equal(cache.stats().evicted, 1);
    cache.put("/a", "a2", staticTrace(), guest);
    assert.equal(cache.stats().evicted, 1, "replacing a page makes no room");
});

test("a stale page served counts as used", () => {
    const { cache, clock } = cacheAt({ maxEntries: 2, ttlMs: 10 });
    cache.put("/a", "a", reads("x"), guest);
    cache.put("/b", "b", reads("x"), guest);
    clock.now = 20;
    cache.get("/a");
    cache.put("/c", "c", reads("x"), guest);
    assert.deepEqual(["/a", "/b", "/c"].map((k) => cache.has(k)), [true, false, true]);
});

test("pages with a query hold their share, and a new one pushes out the least recently used of them, never a page without", () => {
    const { cache } = cacheAt({ maxEntries: 4, maxQueryEntries: 2 });
    cache.put("/", "home", staticTrace(), guest);
    cache.put("/search?q=1", "1", staticTrace(), guest);
    cache.put("/search?q=2", "2", staticTrace(), guest);
    cache.get("/search?q=1");
    cache.put("/search?q=3", "3", staticTrace(), guest);
    assert.deepEqual(["/", "/search?q=1", "/search?q=2", "/search?q=3"].map((k) => cache.has(k)), [true, true, false, true]);
    for (let n = 4; n < 50; n++) cache.put(`/search?q=${n}`, String(n), staticTrace(), guest);
    assert.ok(cache.has("/"), "a guest sending values never pushes the pages out");
    const stats = cache.stats();
    assert.equal(stats.queryEntries, 2);
    assert.equal(stats.entries, 3);
});

test("a page with a query still makes room in a full cache when its share is not used up", () => {
    const { cache } = cacheAt({ maxEntries: 2, maxQueryEntries: 1 });
    cache.put("/a", "a", staticTrace(), guest);
    cache.put("/b", "b", staticTrace(), guest);
    cache.put("/s?q=1", "1", staticTrace(), guest);
    assert.deepEqual(["/a", "/b", "/s?q=1"].map((k) => cache.has(k)), [false, true, true]);
});

test("the query share is a quarter of the bound unless told, and at least 1", () => {
    assert.deepEqual(pick(createPageCache().stats()), { maxEntries: 1000, maxQueryEntries: 250 });
    assert.deepEqual(pick(createPageCache({ maxEntries: 10 }).stats()), { maxEntries: 10, maxQueryEntries: 2 });
    assert.deepEqual(pick(createPageCache({ maxEntries: 3 }).stats()), { maxEntries: 3, maxQueryEntries: 1 });
    assert.deepEqual(pick(createPageCache({ maxEntries: 10, maxQueryEntries: 7 }).stats()), { maxEntries: 10, maxQueryEntries: 7 });
});
const pick = ({ maxEntries, maxQueryEntries }) => ({ maxEntries, maxQueryEntries });

// ---- purge and clear ------------------------------------------------------------------------------

test("purge drops the pages past staleMs nobody asked for since, keeps the rest, and answers how many", () => {
    const { cache, clock } = cacheAt({ ttlMs: 100, staleMs: 1000 });
    cache.put("/old", "o", reads("x"), guest);
    cache.put("/about", "s", staticTrace(), guest);
    clock.now = 500;
    cache.put("/newer", "n", reads("x"), guest);
    clock.now = 1000;
    assert.equal(cache.purge(), 0, "exactly staleMs old is not past it");
    clock.now = 1001;
    assert.equal(cache.purge(), 1);
    assert.deepEqual(["/old", "/about", "/newer"].map((k) => cache.has(k)), [false, true, true]);
    assert.equal(cache.stats().evicted, 1);
    clock.now = 1e9;
    assert.equal(cache.purge(), 1);
    assert.ok(cache.has("/about"), "a static page is never purged");
});

test("clear drops every page", () => {
    const { cache } = cacheAt();
    cache.put("/a", "a", staticTrace(), guest);
    cache.put("/b", "b", reads("x"), guest);
    cache.clear();
    assert.equal(cache.stats().entries, 0);
    assert.equal(cache.stats().dropped, 2);
});

// ---- stats ----------------------------------------------------------------------------------------

test("stats() counts what the cache did, and what it holds", () => {
    const { cache } = cacheAt({ maxEntries: 8, maxQueryEntries: 3 });
    cache.put("/", "home", staticTrace(), guest);
    cache.put("/chat", "chat", reads("chat"), guest);
    cache.put("/s?q=1", "s", reads("search"), guest);
    cache.put("/me", "me", staticTrace(), { viewer: "u1" });
    cache.get("/");
    cache.get("/missing");
    assert.deepEqual(cache.stats(), {
        hits: 1, stale: 0, misses: 1, stores: 3, skipped: 1, raced: 0, invalidations: 0, dropped: 0, evicted: 0,
        regenerated: 0, released: 0, entries: 3, static: 1, maxEntries: 8, queryEntries: 1, maxQueryEntries: 3,
    });
});
