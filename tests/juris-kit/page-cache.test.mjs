// The page cache's policy, decide(trace, context): which traced renders may be kept and why not,
// in the order the reasons are weighed, and the `$pages` target (EVERYTHING) that names every page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, EVERYTHING } from "juris-kit/server/page-cache.js";

// A trace as renderRequest({ trace: true }) reports it: by default a render that read nothing.
const trace = (over = {}) => ({ static: true, services: [], roots: [], flags: [], queries: [], unknown: [], failed: [], ...over });
const dependent = (services, over = {}) => trace({ static: false, services, ...over });

test("EVERYTHING is the $pages target", () => {
    assert.equal(EVERYTHING, "$pages");
});

test("a render in which nothing reactive ran and nothing was called is kept forever", () => {
    assert.deepEqual(decide(trace()), { cache: true, reason: "static", forever: true, services: [] });
});

test("a render that read preloaded data is kept until a change names one of its services", () => {
    assert.deepEqual(decide(dependent(["chat", "users"])), { cache: true, reason: "dependent", forever: false, services: ["chat", "users"] });
});

test("a page rendered for a viewer is never kept, however plain it is", () => {
    assert.deepEqual(decide(trace(), { viewer: { id: "u1" } }), { cache: false, reason: "personal" });
    assert.deepEqual(decide(null, { viewer: "u1", status: 404 }), { cache: false, reason: "personal" }, "before anything else");
});

test("a page that was not found is never kept", () => {
    assert.deepEqual(decide(trace(), { status: 404 }), { cache: false, reason: "not-found" });
    assert.deepEqual(decide(null, { status: 404 }), { cache: false, reason: "not-found" });
    assert.equal(decide(trace(), { status: 200 }).cache, true);
});

test("a render that was not traced is never kept", () => {
    assert.deepEqual(decide(null), { cache: false, reason: "untraced" });
    assert.deepEqual(decide(undefined, {}), { cache: false, reason: "untraced" });
});

test("a render whose preloaded call failed is never kept, and says which calls failed", () => {
    assert.deepEqual(decide(dependent(["post"], { failed: ["post", "comments"] })), { cache: false, reason: "failed:post,comments" });
    assert.deepEqual(decide(trace({ failed: ["post"] })), { cache: false, reason: "failed:post" }, "a static-looking page too");
});

test("a render that drew a component nobody registered is never kept, and says which", () => {
    assert.deepEqual(decide(trace({ unknown: ["PriceTag", "Footer"] })), { cache: false, reason: "unknown:PriceTag,Footer" });
});

test("a render a plugin flagged volatile is never kept, and says which flags", () => {
    assert.deepEqual(decide(trace({ flags: ["clock", "random"] })), { cache: false, reason: "volatile:clock,random" });
});

test("a render that read a state root the URL does not key is never kept, and says which roots", () => {
    const read = trace({ roots: ["route", "locale", "ab", "theme"] });
    assert.deepEqual(decide(read, { unkeyedRoots: ["ab", "locale"] }), { cache: false, reason: "request-state:locale,ab" });
    assert.equal(decide(read, { unkeyedRoots: ["cart"] }).cache, true, "only a root it read counts");
    assert.equal(decide(read).cache, true, "no unkeyed roots unless told");
});

test("a failed call is the reason whatever else the render did, since it says the render was that request's failure", () => {
    const options = { unkeyedRoots: ["locale"] };
    assert.equal(decide(trace({ failed: ["post"], unknown: ["X"], flags: ["clock"], roots: ["locale"] }), options).reason, "failed:post");
    assert.equal(decide(trace({ failed: ["post"], flags: ["clock"] })).reason, "failed:post");
});

test("a render with several reasons not to keep it is refused for one of them", () => {
    const decision = decide(trace({ unknown: ["X"], flags: ["clock"], roots: ["locale"] }), { unkeyedRoots: ["locale"] });
    assert.equal(decision.cache, false);
    assert.ok(["unknown:X", "volatile:clock", "request-state:locale"].includes(decision.reason), decision.reason);
});

test("a trace made before failed and unknown existed is decided as it was", () => {
    const old = { static: false, services: ["chat"], roots: [], flags: [] };
    assert.deepEqual(decide(old), { cache: true, reason: "dependent", forever: false, services: ["chat"] });
    assert.deepEqual(decide({ static: true, services: [], roots: [], flags: [] }), { cache: true, reason: "static", forever: true, services: [] });
});
