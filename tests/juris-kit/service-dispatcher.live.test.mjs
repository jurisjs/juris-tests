// serviceDispatcher's live layer, the event stream and the subscribe endpoint: the stream's headers,
// `retry:` and hello; client ids minted by the server and bound to `identify`; one stream per id; the
// per-caller ceilings and `clientKey`; what a subscribe is checked for (a live query, `authorize`,
// the key, the ceilings) and answered with (the full value, from the cache when the group has one);
// unsubscribe; re-runs and their patches; invalidateAccess; stats and close.
import { test } from "node:test";
import assert from "node:assert/strict";
import { serviceDispatcher } from "juris-kit/server/service-dispatcher.js";
import { CALL_KIND, callKind, liveKey, LIVE_CODES } from "juris/live-protocol.js";
import { ServiceError } from "juris/errors.js";
import { serve, request, live, subscribe, openStream, until, flush, deferred, driver } from "../support/service-dispatcher-harness.mjs";

const STALE = { error: "unknown or foreign client id", code: LIVE_CODES.CLIENT_UNKNOWN };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function withServer(services, options, run) {
    const handler = serviceDispatcher(services, "/api", options);
    const host = await serve(handler);
    const streams = [];
    const open = async (opts) => { const stream = await openStream(host.port, opts); streams.push(stream); return stream; };
    try {
        await run({ host, handler, open });
        assert.deepEqual(host.failures, [], "nothing rejected out of the dispatcher");
    } finally {
        for (const stream of streams) stream.close();
        handler.close();
        await host.close();
    }
}
// A dispatcher driven with made requests (no socket), closed after.
async function withDriver(services, options, run) {
    const handler = serviceDispatcher(services, "/api", options);
    try {
        await run({ handler, d: driver(handler) });
    } finally {
        handler.close();
    }
}

// ---- the stream ---------------------------------------------------------------------------------------

test("the event stream is an uncached, unbuffered text/event-stream that says retry first, then the client id", async () => {
    await withServer({ q: () => 1 }, { live: { queries: ["q"], public: true } }, async ({ open }) => {
        const stream = await open();
        assert.equal(stream.status, 200);
        assert.equal(stream.headers["content-type"], "text/event-stream");
        assert.equal(stream.headers["cache-control"], "no-cache, no-transform");
        assert.equal(stream.headers.connection, "keep-alive");
        assert.equal(stream.headers["x-accel-buffering"], "no");
        assert.match(stream.id, UUID, "a random UUID from the platform");
        assert.ok(stream.text.startsWith(`retry: 2000\n\nevent: hello\ndata: {"client":"${stream.id}"}\n\n`), stream.text);
    });
});

test("live.retryMs is the retry: the stream sends", async () => {
    await withServer({ q: () => 1 }, { live: { queries: ["q"], public: true, retryMs: 7500 } }, async ({ open }) => {
        assert.ok((await open()).text.startsWith("retry: 7500\n\n"));
    });
});

test("every stream opened without an id is minted a new one", async () => {
    await withServer({ q: () => 1 }, { live: { queries: ["q"], public: true } }, async ({ open, handler }) => {
        const ids = new Set();
        for (let i = 0; i < 3; i++) ids.add((await open()).id);
        assert.equal(ids.size, 3);
        assert.equal(handler.stats().clients, 3);
        assert.equal(handler.stats().connected, 3);
    });
});

test("a stream reopened with its id keeps the id and ends the stream it replaces", async () => {
    await withServer({ q: () => 1 }, { live: { queries: ["q"], public: true } }, async ({ open, handler }) => {
        const first = await open();
        const second = await open({ client: first.id });
        assert.equal(second.status, 200);
        assert.equal(second.id, first.id);
        assert.ok(await until(() => first.ended, 500), "the replaced stream is ended");
        assert.equal(second.ended, false);
        assert.equal(handler.stats().clients, 1);
        assert.equal(handler.stats().connected, 1);
    });
});

test("a stream asked for with an id this server never minted is refused 403 live.client-unknown", async () => {
    await withServer({ q: () => 1 }, { live: { queries: ["q"], public: true } }, async ({ open, handler }) => {
        const stream = await open({ client: "made-up" });
        assert.equal(stream.status, 403);
        assert.deepEqual(stream.json, STALE);
        assert.equal(handler.stats().clients, 0);
    });
});

test("a client id is bound to its owner: another owner, or a guest, cannot open its stream, and the reverse", async () => {
    const owners = { a: "alice", b: "bob" };
    await withServer({ q: () => 1 }, { live: { queries: ["q"], public: true, identify: ({ req }) => owners[req.headers["x-who"]] ?? null } }, async ({ open }) => {
        const alices = await open({ headers: { "x-who": "a" } });
        assert.equal((await open({ client: alices.id, headers: { "x-who": "b" } })).status, 403);
        assert.equal((await open({ client: alices.id })).status, 403, "a guest cannot take a signed-in id");
        const guests = await open();
        const taken = await open({ client: guests.id, headers: { "x-who": "a" } });
        assert.equal(taken.status, 403, "a signed-in session cannot take a guest's id");
        assert.deepEqual(taken.json, STALE);
        assert.equal((await open({ client: alices.id, headers: { "x-who": "a" } })).status, 200, "its owner can");
        assert.equal((await open({ client: guests.id })).status, 200, "a guest's id is any guest's: entropy alone protects it");
    });
});

test("identify is asked as the request's context, and its answer is the owner as a string", async () => {
    const asked = [];
    await withDriver({ q: () => 1 }, {
        context: (req) => ({ session: req.headers.cookie }),
        live: {
            queries: ["q"],
            identify(info) { asked.push({ kind: callKind(this), session: this.session, url: info.req.url }); return 7; },
            authorize: (name, args, info) => !info.recheck,
        },
    }, async ({ handler, d }) => {
        const stream = await d.open({ headers: { cookie: "sid=1" } });
        assert.equal(stream.handled, true);
        assert.deepEqual(asked, [{ kind: "direct", session: "sid=1", url: "/api/events" }]);
        await d.subscribe(stream.id, "q");
        assert.equal(await handler.invalidateAccess(7), 0, "the number is not the owner");
        assert.equal(await handler.invalidateAccess("7"), 1, "the string is");
    });
});

test("an identify that throws or answers nothing leaves a guest, and onError hears a throw", async () => {
    const errors = [];
    let mode = "throw";
    const failure = new Error("session store down");
    await withDriver({ q: () => 1 }, {
        live: { queries: ["q"], public: true, identify: () => { if (mode === "throw") throw failure; return mode === "null" ? null : undefined; } },
        onError: (error, where, args) => errors.push([error, where, args]),
    }, async ({ d }) => {
        const thrown = await d.open();
        assert.ok(thrown.id);
        mode = "null";
        const guest = await d.open();
        mode = "undefined";
        assert.equal((await d.open({ client: thrown.id })).res.statusCode, 200, "the same guest as before");
        assert.equal((await d.open({ client: guest.id })).res.statusCode, 200);
    });
    assert.deepEqual(errors, [[failure, "live.identify", []]]);
});

test("a context that throws while identifying leaves a guest, without asking identify, and onError hears it", async () => {
    const errors = [];
    let asked = 0;
    const failure = new Error("bad cookie");
    await withDriver({ q: () => 1 }, {
        context: () => { throw failure; },
        live: { queries: ["q"], public: true, identify: () => { asked += 1; return "owner"; } },
        onError: (error, where, args) => errors.push([error, where, args]),
    }, async ({ d }) => {
        const stream = await d.open();
        assert.ok(stream.id);
        const again = await d.open({ client: stream.id });
        assert.equal(again.id, stream.id, "a guest's id, reopened by a guest");
    });
    assert.equal(asked, 0);
    assert.deepEqual(errors, [[failure, "live.context", []], [failure, "live.context", []]]);
});

// ---- per-caller stream ceiling ---------------------------------------------------------------------------

test("one address may hold at most maxStreamsPerCaller open streams; a closed one frees its place", async () => {
    await withServer({ q: () => 1 }, { live: { queries: ["q"], public: true, maxStreamsPerCaller: 2 } }, async ({ open, handler }) => {
        const first = await open();
        await open();
        const third = await open();
        assert.equal(third.status, 429);
        assert.deepEqual(third.json, { error: "at most 2 live streams at a time" });
        const again = await open({ client: first.id });
        assert.equal(again.status, 200, "reopening an id is not a new stream");
        again.close();
        assert.ok(await until(() => handler.stats().connected === 1));
        assert.equal((await open()).status, 200);
    });
});

test("maxStreamsPerCaller: 0 is no ceiling", async () => {
    await withDriver({ q: () => 1 }, { live: { queries: ["q"], public: true, maxStreamsPerCaller: 0 } }, async ({ handler, d }) => {
        for (let i = 0; i < 15; i++) assert.ok((await d.open()).id);
        assert.equal(handler.stats().connected, 15);
    });
});

test("a signed-in caller's ceiling is their own, not their address's", async () => {
    await withDriver({ q: () => 1 }, { live: { queries: ["q"], public: true, maxStreamsPerCaller: 1, identify: ({ req }) => req.headers["x-who"] ?? null } }, async ({ d }) => {
        assert.ok((await d.open({ headers: { "x-who": "alice" } })).id);
        assert.ok((await d.open({ headers: { "x-who": "bob" } })).id, "the same address, another owner");
        assert.equal((await d.open({ headers: { "x-who": "alice" } })).res.statusCode, 429);
        assert.ok((await d.open()).id, "the address's guests are a caller of their own");
    });
});

test("clientKey says who a request is for, given the request and the owner", async () => {
    const asked = [];
    await withDriver({ q: () => 1 }, {
        live: {
            queries: ["q"], public: true, maxStreamsPerCaller: 1,
            identify: ({ req }) => req.headers["x-who"] ?? null,
            clientKey: (req, owner) => { asked.push(owner); return req.headers["x-forwarded-for"]; },
        },
    }, async ({ d }) => {
        assert.ok((await d.open({ headers: { "x-forwarded-for": "198.51.100.7", "x-who": "ada" } })).id);
        assert.ok((await d.open({ headers: { "x-forwarded-for": "203.0.113.1" } })).id);
        assert.ok((await d.open({ headers: { "x-forwarded-for": "203.0.113.2" } })).id);
        assert.equal((await d.open({ headers: { "x-forwarded-for": "203.0.113.1" } })).res.statusCode, 429);
        // A key that is no string is made one: undefined from two requests is the same caller.
        assert.ok((await d.open()).id);
        assert.equal((await d.open()).res.statusCode, 429);
    });
    assert.deepEqual(asked, ["ada", null, null, null, null, null]);
});

test("requests with no socket address count as one caller", async () => {
    await withDriver({ q: () => 1 }, { live: { queries: ["q"], public: true, maxStreamsPerCaller: 1 } }, async ({ d }) => {
        assert.ok((await d.open({ socket: null })).id);
        assert.equal((await d.open({ socket: {} })).res.statusCode, 429);
        assert.ok((await d.open({ socket: { remoteAddress: "10.0.0.9" } })).id);
    });
});

// ---- the subscribe endpoint's own refusals --------------------------------------------------------------

// RFC 9110, 9.1 and 15.5.6: a method the stream does not take is a 405 naming, in Allow, the ones it
// does; 9.3.7: a successful OPTIONS sends Allow; 9.3.2: a HEAD gets the headers a GET would.
// A stream opened by mistake never ends: bounded, so that fails rather than hangs.
const BOUNDED = { timeout: 5000 };

test("the event stream takes GET and HEAD: OPTIONS is a 204, another method a 405, no stream", BOUNDED, async () => {
    await withServer({ q: () => 1 }, { live: { queries: ["q"], public: true } }, async ({ host, handler }) => {
        for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
            const json = { "content-type": "application/json", "content-length": "2" };
            const answer = await request(host.port, { method, path: "/api/events", headers: json, body: "[]" });
            assert.equal(answer.status, 405, method);
            assert.equal(answer.headers.allow, "GET, HEAD", method);
            assert.equal(answer.text, "This address takes GET, HEAD.", method);
        }
        const options = await request(host.port, { method: "OPTIONS", path: "/api/events" });
        assert.deepEqual([options.status, options.headers.allow, options.text], [204, "GET, HEAD", ""]);
        assert.equal(handler.stats().clients, 0, "a client was minted for a method the stream does not take");
    });
});

test("a HEAD of the event stream gets its headers alone, mints no client, and ends", BOUNDED, async () => {
    await withServer({ q: () => 1 }, { live: { queries: ["q"], public: true } }, async ({ host, handler }) => {
        const head = await request(host.port, { method: "HEAD", path: "/api/events" });
        assert.equal(head.status, 200);
        assert.equal(head.headers["content-type"], "text/event-stream");
        assert.equal(head.headers["cache-control"], "no-cache, no-transform");
        assert.equal(head.text, "");
        assert.equal(handler.stats().clients, 0);
        assert.equal(handler.stats().connected, 0);
    });
});

test("_live takes POST only, and its 405 says so in Allow", async () => {
    await withServer({ q: () => 1 }, { live: { queries: ["q"], public: true } }, async ({ host }) => {
        for (const method of ["GET", "PUT", "OPTIONS"]) {
            const answer = await request(host.port, { method, path: "/api/_live" });
            assert.equal(answer.status, 405, method);
            assert.equal(answer.headers.allow, "POST", method);
            assert.deepEqual(answer.json, { error: "POST" });
        }
        const head = await request(host.port, { method: "HEAD", path: "/api/_live" });
        assert.deepEqual([head.status, head.headers.allow, head.text], [405, "POST", ""]);
    });
});

test("_live takes JSON within maxBody, like a service call", async () => {
    await withServer({ q: () => 1 }, { maxBody: 64, live: { queries: ["q"], public: true } }, async ({ host }) => {
        const typed = await request(host.port, { path: "/api/_live", headers: { "content-type": "text/plain" }, body: "{}" });
        assert.equal(typed.status, 415);
        assert.deepEqual(typed.json, { error: "bad request: content-type must be application/json" });
        const broken = await request(host.port, { path: "/api/_live", headers: { "content-type": "application/json" }, body: "{" });
        assert.equal(broken.status, 400);
        assert.match(broken.json.error, /^bad request: /);
        const large = await live(host.port, { client: "x".repeat(100) });
        assert.equal(large.status, 413);
        assert.deepEqual(large.json, { error: "bad request: body larger than 64 bytes" });
    });
});

test("a _live body with no client id, an empty one or one that is no string is a 400", async () => {
    await withDriver({ q: () => 1 }, { live: { queries: ["q"], public: true } }, async ({ d }) => {
        for (const body of [{}, { client: "" }, { client: 5 }, null, undefined, []]) {
            const answer = await d.post("_live", body);
            assert.equal(answer.status, 400, JSON.stringify(body));
            assert.deepEqual(answer.body, { error: "client id required" });
        }
    });
});

test("a subscribe with an id this server never minted, or minted for another owner, is refused 403 live.client-unknown", async () => {
    let asked = 0;
    await withDriver({ q: () => 1 }, {
        live: { queries: ["q"], authorize: () => { asked += 1; return true; }, identify: ({ req }) => req.headers["x-who"] ?? null },
    }, async ({ d }) => {
        const unknown = await d.subscribe("never-minted", "q");
        assert.equal(unknown.status, 403);
        assert.deepEqual(unknown.body, STALE);
        const alices = await d.open({ headers: { "x-who": "alice" } });
        const foreign = await d.subscribe(alices.id, "q", [], { headers: { "x-who": "mallory" } });
        assert.equal(foreign.status, 403);
        assert.deepEqual(foreign.body, STALE);
        const unsubscribe = await d.post("_live", { client: alices.id, unsubscribe: "q:[]" }, { headers: { "x-who": "mallory" } });
        assert.equal(unsubscribe.status, 403);
        assert.deepEqual(unsubscribe.body, STALE);
    });
    assert.equal(asked, 0, "authorize is not asked for a client that is not the caller's");
});

test("subscribing to a name no service has is a 404; to a service that is no live query, a 403 live.not-a-query before authorize", async () => {
    let asked = 0;
    await withDriver({ q: () => 1, m: () => 2 }, { live: { queries: ["q"], authorize: () => { asked += 1; return true; } } }, async ({ d }) => {
        const stream = await d.open();
        const unknown = await d.subscribe(stream.id, "nope");
        assert.equal(unknown.status, 404);
        assert.deepEqual(unknown.body, { error: 'unknown service "nope"' });
        const mutation = await d.subscribe(stream.id, "m");
        assert.equal(mutation.status, 403);
        assert.deepEqual(mutation.body, { error: '"m" is not a live query', code: LIVE_CODES.NOT_A_QUERY });
        assert.equal(asked, 0);
        const garbled = await d.post("_live", { client: stream.id, subscribe: true });
        assert.equal(garbled.status, 404, "a subscribe that names nothing names no service");
    });
});

test("a subscribe naming what cannot be made a string is a 404 that does not quote it, not a throw", async () => {
    await withServer({ q: () => 1 }, { live: { queries: ["q"], public: true } }, async ({ host, open }) => {
        const stream = await open();
        const answer = await live(host.port, { client: stream.id, subscribe: { key: "q:[]", name: { toString: 0 }, args: [] } });
        assert.equal(answer.status, 404);
        assert.deepEqual(answer.json, { error: "unknown service" });
    });
});

test("by default a name an array-valued touches entry lists is subscribable; with strictQueries it is not", async () => {
    const services = { q: () => 1, profile: () => "p", follow: () => 1 };
    const touches = { follow: ["profile"] };
    await withDriver(services, { live: { queries: ["q"], public: true, touches } }, async ({ d }) => {
        const stream = await d.open();
        assert.equal((await d.subscribe(stream.id, "profile")).status, 200);
        assert.deepEqual(stream.res.patches, [{ key: "profile:[]", full: "p" }]);
    });
    await withDriver(services, { live: { queries: ["q"], public: true, touches, strictQueries: true } }, async ({ d }) => {
        const stream = await d.open();
        const refused = await d.subscribe(stream.id, "profile");
        assert.equal(refused.status, 403);
        assert.equal(refused.body.code, LIVE_CODES.NOT_A_QUERY);
        assert.equal((await d.subscribe(stream.id, "q")).status, 200);
    });
});

test("a subscribe's key must be the query's own name:JSON(args)", async () => {
    let ran = 0;
    await withDriver({ q: () => { ran += 1; return 1; } }, { live: { queries: ["q"], public: true } }, async ({ handler, d }) => {
        const stream = await d.open();
        for (const key of ["q:[2]", "other", "q:[ 1]", undefined]) {
            const answer = await d.post("_live", { client: stream.id, subscribe: { key, name: "q", args: [1] } });
            assert.equal(answer.status, 400, String(key));
            assert.deepEqual(answer.body, { error: "key must be the query's own name:JSON(args)" });
        }
        assert.equal(handler.stats().groups, 0);
        assert.equal(ran, 0);
        // Arguments that are no list are no arguments, and the key is computed over that.
        assert.equal((await d.post("_live", { client: stream.id, subscribe: { key: liveKey("q", []), name: "q", args: "x" } })).status, 200);
    });
});

test("a subscribe whose arguments are nested too deep to be written as JSON again has no key of its own: 400, not a throw", async () => {
    let ran = 0;
    await withServer({ q: () => { ran += 1; return 1; } }, { live: { queries: ["q"], public: true } }, async ({ host, handler, open }) => {
        const stream = await open();
        const deep = "[".repeat(100_000) + "]".repeat(100_000);
        const answer = await request(host.port, {
            path: "/api/_live",
            headers: { "content-type": "application/json" },
            body: `{"client":${JSON.stringify(stream.id)},"subscribe":{"key":"q:[]","name":"q","args":[${deep}]}}`,
        });
        assert.equal(answer.status, 400);
        assert.deepEqual(answer.json, { error: "key must be the query's own name:JSON(args)" });
        assert.equal(handler.stats().groups, 0);
    });
    assert.equal(ran, 0);
});

// ---- authorize at subscribe -----------------------------------------------------------------------------

test("authorize is asked at subscribe as the request's context, with the arguments, the client id and the request", async () => {
    const asked = [];
    await withDriver({ q: (id) => ({ id }) }, {
        context: (req) => ({ session: req.headers.cookie }),
        live: { queries: ["q"], authorize(name, args, info) { asked.push({ kind: callKind(this), session: this.session, name, args, clientId: info.clientId, url: info.req.url, recheck: info.recheck }); return true; } },
    }, async ({ d }) => {
        const stream = await d.open();
        const answer = await d.subscribe(stream.id, "q", [3], { headers: { cookie: "sid=9" } });
        assert.equal(answer.status, 200);
        assert.deepEqual(answer.body, { ok: true });
        assert.deepEqual(asked, [{ kind: "direct", session: "sid=9", name: "q", args: [3], clientId: stream.id, url: "/api/_live", recheck: undefined }]);
        assert.deepEqual(stream.res.patches, [{ key: "q:[3]", full: { id: 3 } }]);
    });
});

test("authorize answering false refuses the subscribe 403 and runs nothing", async () => {
    let ran = 0;
    await withDriver({ q: () => { ran += 1; } }, { live: { queries: ["q"], authorize: (name, args) => args[0] === "mine" } }, async ({ handler, d }) => {
        const stream = await d.open();
        const refused = await d.subscribe(stream.id, "q", ["theirs"]);
        assert.equal(refused.status, 403);
        assert.deepEqual(refused.body, { error: 'not allowed to subscribe to "q"' });
        assert.equal(handler.stats().groups, 0);
        assert.equal(ran, 0);
    });
});

test("authorize that throws is a 500 'authorisation failed', and onError hears it", async () => {
    const errors = [];
    const failure = new Error("rules table missing");
    await withDriver({ q: () => 1 }, { live: { queries: ["q"], authorize: () => { throw failure; } }, onError: (...args) => errors.push(args) }, async ({ handler, d }) => {
        const stream = await d.open();
        const answer = await d.subscribe(stream.id, "q", [1]);
        assert.equal(answer.status, 500);
        assert.deepEqual(answer.body, { error: "authorisation failed" });
        assert.equal(handler.stats().groups, 0);
    });
    assert.deepEqual(errors, [[failure, "live.authorize", [1]]]);
});

test("a context that throws at subscribe refuses it 403 without asking authorize, and onError hears it", async () => {
    const errors = [];
    let asked = 0;
    let fail = false;
    const failure = new Error("bad cookie");
    await withDriver({ q: () => 1 }, {
        context: () => { if (fail) throw failure; return {}; },
        live: { queries: ["q"], authorize: () => { asked += 1; return true; } },
        onError: (...args) => errors.push(args),
    }, async ({ d }) => {
        const stream = await d.open();
        fail = true;
        const answer = await d.subscribe(stream.id, "q", [2]);
        assert.equal(answer.status, 403);
        assert.deepEqual(answer.body, { error: 'not allowed to subscribe to "q"' });
    });
    assert.equal(asked, 0);
    assert.deepEqual(errors, [[failure, "live.context", [2]]]);
});

// ---- the first value, and the cache --------------------------------------------------------------------

test("a live query runs as the live layer's own call: frozen, of kind live, naming nobody", async () => {
    let seen;
    await withDriver({ q() { seen = this; return 1; } }, { context: () => ({ user: "ada" }), live: { queries: ["q"], authorize: () => true } }, async ({ d }) => {
        const stream = await d.open();
        await d.subscribe(stream.id, "q");
    });
    assert.equal(callKind(seen), "live");
    assert.ok(Object.isFrozen(seen));
    assert.deepEqual(Reflect.ownKeys(seen), [CALL_KIND]);
});

test("a query with no subscribers is run once at subscribe; joining it is answered from the cached value", async () => {
    let runs = 0;
    await withDriver({ q: (room) => ({ room, runs: ++runs }) }, { live: { queries: ["q"], public: true } }, async ({ handler, d }) => {
        const a = await d.open();
        const b = await d.open();
        await d.subscribe(a.id, "q", [1]);
        await d.subscribe(b.id, "q", [1]);
        assert.equal(runs, 1, "no new DB call for the second subscriber");
        assert.deepEqual(b.res.patches, [{ key: "q:[1]", full: { room: 1, runs: 1 } }]);
        await d.subscribe(a.id, "q", [1]);
        assert.equal(runs, 1);
        assert.deepEqual(handler.stats(), { clients: 2, groups: 1, subscriptions: 2, connected: 2, droppedForLag: 0, bus: null });
        await d.subscribe(a.id, "q", [2]);
        assert.equal(runs, 2, "other arguments are another group");
        assert.equal(handler.stats().groups, 2);
    });
});

test("a cached value of null is still a value: a joiner is answered from it", async () => {
    let runs = 0;
    await withDriver({ q: () => { runs += 1; return null; } }, { live: { queries: ["q"], public: true } }, async ({ d }) => {
        const a = await d.open();
        const b = await d.open();
        await d.subscribe(a.id, "q");
        await d.subscribe(b.id, "q");
        assert.equal(runs, 1);
        assert.deepEqual(b.res.patches, [{ key: "q:[]", full: null }]);
    });
});

test("a subscriber that joins while the first run is still going gets the full value too", async () => {
    const gate = deferred();
    let runs = 0;
    await withDriver({ q: async () => { runs += 1; await gate.promise; return { v: runs }; } }, { live: { queries: ["q"], public: true } }, async ({ d }) => {
        const a = await d.open();
        const b = await d.open();
        const first = d.subscribe(a.id, "q");
        await flush();
        const second = d.subscribe(b.id, "q");
        await flush();
        gate.resolve();
        await Promise.all([first, second]);
        assert.equal(runs, 2, "the running one, then once more for the joiner");
        assert.deepEqual(b.res.patches.at(-1), { key: "q:[]", full: { v: 2 } });
        assert.deepEqual(a.res.patches.at(-1), { key: "q:[]", full: { v: 2 } });
    });
});

// ---- re-runs and patches -------------------------------------------------------------------------------------

test("an invalidation re-runs a group once, sends only what changed to every subscriber, and nothing when nothing did", async () => {
    let value = { title: "a", count: 1, gone: true };
    let runs = 0;
    await withServer({ q: () => { runs += 1; return value; } }, { live: { queries: ["q"], public: true } }, async ({ host, handler, open }) => {
        const a = await open();
        const b = await open();
        assert.equal((await subscribe(host.port, a.id, "q")).status, 200);
        assert.equal((await subscribe(host.port, b.id, "q")).status, 200);
        assert.ok(await until(() => a.events.length === 1 && b.events.length === 1));
        assert.deepEqual(a.events[0], { event: "patch", data: { key: "q:[]", full: { title: "a", count: 1, gone: true } } });
        value = { title: "a", count: 2 };
        await handler.invalidate("q");
        assert.equal(runs, 2, "one run for both subscribers");
        assert.ok(await until(() => a.events.length === 2 && b.events.length === 2));
        for (const stream of [a, b]) assert.deepEqual(stream.events[1].data, { key: "q:[]", set: [["count", 2]], del: ["gone"] });
        await handler.invalidate("q");
        assert.equal(runs, 3);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(a.events.length, 2, "an unchanged re-run sends nothing");
    });
});

test("invalidations that arrive while a re-run is going coalesce into one more run, never an overlap", async () => {
    let gate = null;
    let runs = 0;
    let running = 0;
    let most = 0;
    let value = 1;
    const q = async () => {
        const seen = value;
        runs += 1;
        running += 1;
        most = Math.max(most, running);
        await gate?.promise;
        running -= 1;
        return seen;
    };
    await withDriver({ q }, { live: { queries: ["q"], public: true } }, async ({ d, handler }) => {
        const stream = await d.open();
        await d.subscribe(stream.id, "q");
        gate = deferred();
        value = 2;
        const first = handler.invalidate("q");
        await flush();
        value = 3;
        const second = handler.invalidate("q");
        const third = handler.invalidate("q");
        gate.resolve();
        gate = null;
        await Promise.all([first, second, third]);
        assert.equal(runs, 3, "the subscribe's run, the running one, and one more");
        assert.equal(most, 1);
        assert.deepEqual(stream.res.patches, [
            { key: "q:[]", full: 1 },
            { key: "q:[]", set: [["", 2]], del: [] },
            { key: "q:[]", set: [["", 3]], del: [] },
        ], "in order, the last value last: no revert");
    });
});

test("a re-run that fails tells every subscriber 'live query failed', and onError the error, name and arguments", async () => {
    const errors = [];
    let fail = false;
    const failure = new Error("connection reset by 10.0.0.5");
    await withDriver({ q: (id) => { if (fail) throw failure; return id; } }, { live: { queries: ["q"], public: true }, onError: (...args) => errors.push(args) }, async ({ d, handler }) => {
        const a = await d.open();
        const b = await d.open();
        await d.subscribe(a.id, "q", [1]);
        await d.subscribe(b.id, "q", [1]);
        fail = true;
        await handler.invalidate("q");
        for (const stream of [a, b]) assert.deepEqual(stream.res.patches.at(-1), { key: "q:[1]", error: "live query failed" });
    });
    assert.deepEqual(errors, [[failure, "q", [1]]]);
});

test("a failed re-run's words reach subscribers when exposeError lets them, and without onError still do", async () => {
    let fail = false;
    await withDriver({ q: () => { if (fail) throw new ServiceError("The board is closed."); return 1; } }, { live: { queries: ["q"], public: true } }, async ({ d, handler }) => {
        const stream = await d.open();
        await d.subscribe(stream.id, "q");
        fail = true;
        await handler.invalidate("q");
        assert.deepEqual(stream.res.patches.at(-1), { key: "q:[]", error: "The board is closed." });
    });
});

test("a first run that fails is not cached: the next subscriber runs it again", async () => {
    let runs = 0;
    await withDriver({ q: () => { runs += 1; if (runs === 1) throw new Error("cold start"); return "warm"; } }, { live: { queries: ["q"], public: true }, onError: () => { } }, async ({ d }) => {
        const a = await d.open();
        const b = await d.open();
        await d.subscribe(a.id, "q");
        assert.deepEqual(a.res.patches, [{ key: "q:[]", error: "live query failed" }]);
        await d.subscribe(b.id, "q");
        assert.equal(runs, 2);
        assert.deepEqual(b.res.patches, [{ key: "q:[]", full: "warm" }]);
    });
});

test("a result JSON cannot carry fails as a re-run, is not cached, and the next good one is sent whole", async () => {
    const errors = [];
    let value = { n: 1n };
    let runs = 0;
    await withDriver({ q: () => { runs += 1; return value; } }, { live: { queries: ["q"], public: true }, onError: (error, where) => errors.push({ error, where }) }, async ({ d, handler }) => {
        const a = await d.open();
        await d.subscribe(a.id, "q");
        assert.deepEqual(a.res.patches, [{ key: "q:[]", error: "live query failed" }]);
        const b = await d.open();
        await d.subscribe(b.id, "q");
        assert.equal(runs, 2, "a value that failed to go out is not answered from the cache");
        value = { n: 2 };
        await handler.invalidate("q");
        assert.deepEqual(a.res.patches.at(-1), { key: "q:[]", set: [["", { n: 2 }]], del: [] });
        value = { n: 3n };
        await handler.invalidate("q");
        assert.deepEqual(a.res.patches.at(-1), { key: "q:[]", error: "live query failed" }, "a diff that cannot go out fails too");
        value = { n: 4 };
        await handler.invalidate("q");
        assert.deepEqual(a.res.patches.at(-1), { key: "q:[]", set: [["", { n: 4 }]], del: [] });
    });
    assert.equal(errors.length, 3);
    assert.ok(errors.every(({ error, where }) => error instanceof TypeError && where === "q"));
});

// ---- unsubscribe ---------------------------------------------------------------------------------------------

test("unsubscribe leaves a group, which goes once nobody is left; an unknown key or an empty body is answered ok", async () => {
    let runs = 0;
    await withServer({ q: () => ++runs }, { live: { queries: ["q"], public: true } }, async ({ host, handler, open }) => {
        const a = await open();
        const b = await open();
        await subscribe(host.port, a.id, "q");
        await subscribe(host.port, b.id, "q");
        const left = await live(host.port, { client: a.id, unsubscribe: liveKey("q", []) });
        assert.equal(left.status, 200);
        assert.deepEqual(left.json, { ok: true });
        assert.deepEqual([handler.stats().groups, handler.stats().subscriptions], [1, 1]);
        await live(host.port, { client: b.id, unsubscribe: liveKey("q", []) });
        assert.deepEqual([handler.stats().groups, handler.stats().subscriptions], [0, 0]);
        await handler.invalidate("q");
        assert.equal(runs, 1, "nobody watches, so nothing re-runs");
        assert.deepEqual((await live(host.port, { client: a.id, unsubscribe: "q:[99]" })).json, { ok: true });
        assert.deepEqual((await live(host.port, { client: a.id })).json, { ok: true });
        assert.deepEqual((await live(host.port, { client: a.id, subscribe: null })).json, { ok: true });
    });
});

// ---- ceilings on subscriptions ---------------------------------------------------------------------------------

test("a client may hold at most maxKeysPerClient keys; one it holds may be subscribed again", async () => {
    await withDriver({ q: (n) => n }, { live: { queries: ["q"], public: true, maxKeysPerClient: 2 } }, async ({ d, handler }) => {
        const stream = await d.open();
        await d.subscribe(stream.id, "q", [1]);
        await d.subscribe(stream.id, "q", [2]);
        const third = await d.subscribe(stream.id, "q", [3]);
        assert.equal(third.status, 429);
        assert.deepEqual(third.body, { error: "at most 2 live subscriptions per client" });
        assert.equal((await d.subscribe(stream.id, "q", [2])).status, 200);
        assert.equal(handler.stats().groups, 2);
    });
});

test("one caller may hold at most maxGroupsPerCaller distinct queries across all its client ids", async () => {
    await withDriver({ q: (n) => n }, { live: { queries: ["q"], public: true, maxGroupsPerCaller: 2 } }, async ({ d }) => {
        const a = await d.open();
        const b = await d.open();
        await d.subscribe(a.id, "q", [1]);
        await d.subscribe(b.id, "q", [2]);
        const third = await d.subscribe(b.id, "q", [3]);
        assert.equal(third.status, 429);
        assert.deepEqual(third.body, { error: "at most 2 live queries at a time" });
        assert.equal((await d.subscribe(b.id, "q", [1])).status, 200, "a query the caller holds already is not a new one");
        const elsewhere = await d.open({ socket: { remoteAddress: "10.0.0.2" } });
        assert.equal((await d.subscribe(elsewhere.id, "q", [3], { socket: { remoteAddress: "10.0.0.2" } })).status, 200, "another caller has its own");
    });
});

test("maxGroupsPerCaller: 0 is no ceiling", async () => {
    await withDriver({ q: (n) => n }, { live: { queries: ["q"], public: true, maxGroupsPerCaller: 0, maxKeysPerClient: Infinity, maxPostsPerMinute: 0 } }, async ({ d, handler }) => {
        const stream = await d.open();
        for (let i = 0; i < 300; i++) assert.equal((await d.subscribe(stream.id, "q", [i])).status, 200);
        assert.equal(handler.stats().groups, 300);
    });
});

test("the server holds at most maxGroups distinct queries; joining one it holds is still allowed", async () => {
    await withDriver({ q: (n) => n }, { live: { queries: ["q"], public: true, maxGroups: 1 } }, async ({ d }) => {
        const a = await d.open();
        const b = await d.open({ socket: { remoteAddress: "10.0.0.2" } });
        await d.subscribe(a.id, "q", [1]);
        const full = await d.subscribe(b.id, "q", [2], { socket: { remoteAddress: "10.0.0.2" } });
        assert.equal(full.status, 503);
        assert.deepEqual(full.body, { error: "too many live queries on this server" });
        assert.equal((await d.subscribe(b.id, "q", [1], { socket: { remoteAddress: "10.0.0.2" } })).status, 200);
    });
});

test("one caller may make at most maxPostsPerMinute subscription changes; 0 is no limit", async () => {
    await withDriver({ q: (n) => n }, { live: { queries: ["q"], public: true, maxPostsPerMinute: 2 } }, async ({ d }) => {
        const stream = await d.open();
        assert.equal((await d.subscribe(stream.id, "q", [1])).status, 200);
        assert.equal((await d.unsubscribe(stream.id, "q", [1])).status, 200);
        const third = await d.subscribe(stream.id, "q", [1]);
        assert.equal(third.status, 429);
        assert.deepEqual(third.body, { error: "too many subscription changes" });
        const other = await d.open({ socket: { remoteAddress: "10.0.0.2" } });
        assert.equal((await d.subscribe(other.id, "q", [1], { socket: { remoteAddress: "10.0.0.2" } })).status, 200, "another caller has its own budget");
    });
    await withDriver({ q: (n) => n }, { live: { queries: ["q"], public: true, maxPostsPerMinute: 0 } }, async ({ d }) => {
        const stream = await d.open();
        for (let i = 0; i < 300; i++) assert.equal((await d.subscribe(stream.id, "q", [1])).status, 200);
    });
});

// ---- invalidateAccess -----------------------------------------------------------------------------------------

test("invalidateAccess re-asks authorize now for an owner's subscriptions and drops those it refuses", async () => {
    const access = new Set(["alice:1", "alice:2", "bob:1"]);
    const asked = [];
    await withDriver({ q: (room) => ({ room }) }, {
        context: (req) => ({ who: req.headers["x-who"] }),
        live: {
            queries: ["q"],
            identify: ({ req }) => req.headers["x-who"],
            authorize(name, args, info) { asked.push({ who: this.who, room: args[0], recheck: info.recheck === true }); return access.has(`${this.who}:${args[0]}`); },
        },
    }, async ({ d, handler }) => {
        const alice = await d.open({ headers: { "x-who": "alice" } });
        const bob = await d.open({ headers: { "x-who": "bob" } });
        await d.subscribe(alice.id, "q", [1], { headers: { "x-who": "alice" } });
        await d.subscribe(alice.id, "q", [2], { headers: { "x-who": "alice" } });
        await d.subscribe(bob.id, "q", [1], { headers: { "x-who": "bob" } });
        asked.length = 0;
        access.delete("alice:2");
        assert.equal(await handler.invalidateAccess("alice"), 1);
        assert.deepEqual(asked, [{ who: "alice", room: 1, recheck: true }, { who: "alice", room: 2, recheck: true }], "bob is not asked about");
        assert.deepEqual(alice.res.patches.at(-1), { key: "q:[2]", error: "not allowed" });
        assert.equal(handler.stats().subscriptions, 2);
        assert.equal(handler.stats().groups, 1, "the group nobody is left in is gone");
        access.clear();
        assert.equal(await handler.invalidateAccess((owner) => owner === "bob" || owner === "alice"), 2);
        assert.equal(handler.stats().subscriptions, 0);
    });
});

test("invalidateAccess without authorize drops nothing: there is no rule to re-ask", async () => {
    await withDriver({ q: () => 1 }, { live: { queries: ["q"], public: true } }, async ({ d, handler }) => {
        const stream = await d.open();
        await d.subscribe(stream.id, "q");
        assert.equal(await handler.invalidateAccess(() => true), 0);
        assert.equal(handler.stats().subscriptions, 1);
    });
});

test("an authorize that throws on a re-check is a refusal, told to onError", async () => {
    const errors = [];
    let fail = false;
    const failure = new Error("rules table missing");
    await withDriver({ q: () => 1 }, {
        live: { queries: ["q"], authorize: () => { if (fail) throw failure; return true; } },
        onError: (...args) => errors.push(args),
    }, async ({ d, handler }) => {
        const stream = await d.open();
        await d.subscribe(stream.id, "q", [5]);
        fail = true;
        assert.equal(await handler.invalidateAccess(null), 1, "a guest's owner is null");
        assert.deepEqual(stream.res.patches.at(-1), { key: "q:[5]", error: "not allowed" });
    });
    assert.deepEqual(errors, [[failure, "live.authorize", [5]]]);
});

// ---- close -----------------------------------------------------------------------------------------------------

test("close ends every open stream and forgets every client and group", async () => {
    await withServer({ q: () => 1 }, { live: { queries: ["q"], public: true } }, async ({ host, handler, open }) => {
        const a = await open();
        const b = await open();
        await subscribe(host.port, a.id, "q");
        handler.close();
        assert.ok(await until(() => a.ended && b.ended, 500), "both streams ended");
        assert.deepEqual(handler.stats(), { clients: 0, groups: 0, subscriptions: 0, connected: 0, droppedForLag: 0, bus: null });
        assert.equal((await openStream(host.port, { client: a.id })).status, 403, "its ids are forgotten");
    });
});

// ---- a query that keeps the objects it answers -----------------------------------------------------

test("a query that changes in place the objects it answered still sends the change", async () => {
    const rows = [{ id: 1, qty: 1 }];
    const q = () => rows;
    await withServer({ q }, { live: { queries: ["q"], public: true } }, async ({ host, handler, open }) => {
        const stream = await open();
        assert.equal((await subscribe(host.port, stream.id, "q")).status, 200);
        assert.ok(await until(() => stream.events.length === 1));

        rows[0].qty = 2;
        await handler.invalidate("q");

        assert.ok(await until(() => stream.events.length === 2));
        assert.deepEqual(stream.events[1].data, { key: "q:[]", set: [["0.qty", 2]], del: [] });
    });
});

test("a client joining is sent the last answer, not what the query's object has become since", async () => {
    const rows = [{ id: 1, qty: 1 }];
    const q = () => rows;
    await withServer({ q }, { live: { queries: ["q"], public: true } }, async ({ host, handler, open }) => {
        const first = await open();
        await subscribe(host.port, first.id, "q");
        assert.ok(await until(() => first.events.length === 1));

        rows[0].qty = 2;
        const second = await open();
        await subscribe(host.port, second.id, "q");
        assert.ok(await until(() => second.events.length === 1));
        assert.deepEqual(second.events[0].data, { key: "q:[]", full: [{ id: 1, qty: 1 }] });

        await handler.invalidate("q");

        assert.ok(await until(() => second.events.length === 2));
        assert.deepEqual(second.events[1].data, { key: "q:[]", set: [["0.qty", 2]], del: [] });
    });
});

test("a re-run whose answer only looks new on the wire sends nothing", async () => {
    let runs = 0;
    const q = () => {
        runs += 1;
        return { at: new Date(0), gone: undefined };
    };
    await withServer({ q }, { live: { queries: ["q"], public: true } }, async ({ host, handler, open }) => {
        const stream = await open();
        await subscribe(host.port, stream.id, "q");
        assert.ok(await until(() => stream.events.length === 1));

        await handler.invalidate("q");
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.equal(runs, 2);
        assert.equal(stream.events.length, 1);
    });
});
