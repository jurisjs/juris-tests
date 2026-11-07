// The two spellings the page cache's server reads before anything else: canonicalPath, the one
// spelling of a request path (doubled, leading-double and trailing slashes, dot segments in any
// spelling, `\` read as `/`, and what a path may not carry raw encoded), and pageCacheKey, a page's
// path with only the query parameters pages read, in a fixed order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalPath, pageCacheKey, createPageCache } from "juris-kit/server/page-cache.js";

// ---- canonicalPath ----------------------------------------------------------------------------------

test("a path already in its one spelling is not redirected", () => {
    for (const url of ["/", "/a", "/a/b", "/a%2Fb", "/a?x=1", "/a?b?c"]) {
        assert.equal(canonicalPath(url).redirect, null, url);
    }
    assert.deepEqual(canonicalPath("/a/b?x=1"), { path: "/a/b", canonical: "/a/b", query: "x=1", redirect: null });
});

test("doubled, leading-double and trailing slashes are redirected to one", () => {
    assert.deepEqual(canonicalPath("/admin//"), { path: "/admin//", canonical: "/admin", query: undefined, redirect: "/admin" });
    assert.equal(canonicalPath("/a//b/").redirect, "/a/b");
    assert.equal(canonicalPath("/a/b/").redirect, "/a/b");
    assert.equal(canonicalPath("///").redirect, "/");
});

test("a leading // stays a path, never a host", () => {
    assert.deepEqual(canonicalPath("//evil.example/x"), { path: "//evil.example/x", canonical: "/evil.example/x", query: undefined, redirect: "/evil.example/x" });
});

test("dot segments are resolved in any spelling", () => {
    for (const [url, canonical] of [
        ["/a/./b", "/a/b"],
        ["/a/../b", "/b"],
        ["/a/%2e%2e/b", "/b"],
        ["/a/%2E%2E/b", "/b"],
        ["/a/.%2e/b", "/b"],
        ["/a/%2e/b", "/a/b"],
        ["/../../etc/passwd", "/etc/passwd"],
        ["/..", "/"],
    ]) {
        assert.equal(canonicalPath(url).canonical, canonical, url);
        assert.equal(canonicalPath(url).redirect, canonical, url);
    }
});

test("a backslash is read as a slash", () => {
    assert.equal(canonicalPath("/a\\b").redirect, "/a/b");
    assert.equal(canonicalPath("\\\\evil.example\\x").redirect, "/evil.example/x");
    assert.equal(canonicalPath("/a\\..\\b").redirect, "/b");
});

test("what a path may not carry raw is encoded", () => {
    assert.equal(canonicalPath('/a"b').redirect, "/a%22b");
    assert.equal(canonicalPath("/<script>").redirect, "/%3Cscript%3E");
    assert.equal(canonicalPath("/a b").redirect, "/a%20b");
});

test("the query is carried through a redirect as it was sent, an empty one included", () => {
    assert.deepEqual(canonicalPath("/a//b?x=1&y"), { path: "/a//b", canonical: "/a/b", query: "x=1&y", redirect: "/a/b?x=1&y" });
    assert.equal(canonicalPath("/a/?").redirect, "/a?");
    assert.equal(canonicalPath("/a/?q=a/../b").redirect, "/a?q=a/../b", "the query is not a path");
    assert.equal(canonicalPath("/a?").query, "");
});

test("no path, or an empty one, is the root", () => {
    assert.deepEqual(canonicalPath(undefined), { path: "/", canonical: "/", query: undefined, redirect: null });
    assert.deepEqual(canonicalPath(null), { path: "/", canonical: "/", query: undefined, redirect: null });
    assert.equal(canonicalPath("").redirect, "/");
});

test("the spelling redirected to is itself canonical, so no redirect leads to another", () => {
    for (const url of ["/admin//", "//evil.example/x", "/a/%2e%2e/b", "/a\\b", '/a"<b>', "/a b", "/café", "/x/./y/../z//?q=1", "", "\\\\h\\p"]) {
        const { redirect } = canonicalPath(url);
        assert.notEqual(redirect, null, url);
        assert.equal(canonicalPath(redirect).redirect, null, `${JSON.stringify(url)} -> ${redirect}`);
    }
});

// ---- pageCacheKey -----------------------------------------------------------------------------------

const url = (path) => new URL(path, "http://site.example");

test("the key is the path alone when pages read no parameter the URL carries", () => {
    assert.equal(pageCacheKey(url("/posts"), new Set()), "/posts");
    assert.equal(pageCacheKey(url("/posts?utm_source=x&fbclid=y"), new Set(["page"])), "/posts");
});

test("the key keeps only the parameters pages read, in name order", () => {
    const known = new Set(["page", "q", "sort"]);
    assert.equal(pageCacheKey(url("/search?utm=1&sort=new&q=lots&junk=2&page=3"), known), "/search?page=3&q=lots&sort=new");
    assert.equal(pageCacheKey(url("/search?q=lots&page=3"), known), pageCacheKey(url("/search?page=3&q=lots&x=9"), known),
        "one entry however they come");
});

test("repeated values of one parameter keep the order they came in", () => {
    assert.equal(pageCacheKey(url("/f?tag=b&z=1&tag=a"), new Set(["tag"])), "/f?tag=b&tag=a");
});

test("the key's values are encoded as a query", () => {
    assert.equal(pageCacheKey(url("/search?q=a%20b%26c&page"), new Set(["q", "page"])), "/search?page=&q=a+b%26c");
    assert.equal(pageCacheKey(url("/café?q=é"), new Set(["q"])), "/caf%C3%A9?q=%C3%A9");
});

test("junk parameters cannot push real pages out of a cache keyed by pageCacheKey", () => {
    const cache = createPageCache({ maxEntries: 4 });
    const page = { static: true, services: [], roots: [], flags: [] };
    const known = new Set(["page"]);
    cache.put("/", "home", page, {});
    for (let n = 0; n < 100; n++) cache.put(pageCacheKey(url(`/posts?junk=${n}`), known), "posts", page, {});
    assert.ok(cache.has("/"));
    assert.equal(cache.stats().entries, 2);
    assert.equal(cache.stats().queryEntries, 0);
});
