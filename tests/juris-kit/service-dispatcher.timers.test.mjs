// serviceDispatcher's live layer over time, with mock.timers and made requests (no socket): the
// keep-alive, the grace period of a client with no stream, the re-check of `authorize` before a
// patch (recheckMs), the subscribe budget refilling (maxPostsPerMinute), a stream dropped for
// falling behind (maxBufferBytes), and what happens when a request or a client goes away while
// `identify`, `authorize` or a delivery is still being waited on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { serviceDispatcher } from "juris-kit/server/service-dispatcher.js";
import { LIVE_CODES } from "juris/live-protocol.js";
import { flush, deferred, driver, fakeStreamRequest, FakeResponse } from "../support/service-dispatcher-harness.mjs";

const STALE = { error: "unknown or foreign client id", code: LIVE_CODES.CLIENT_UNKNOWN };
const NOW = 1_700_000_000_000;
const clock = (t) => t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW });

async function withDriver(services, options, run) {
    const handler = serviceDispatcher(services, "/api", options);
    try {
        await run({ handler, d: driver(handler) });
    } finally {
        handler.close();
    }
}
const comments = (res) => res.events.filter((item) => item.comment !== undefined).map((item) => item.comment);

// ---- keep-alive ------------------------------------------------------------------------------------

test("an open stream is sent a keep-alive comment every keepAlive ms, until it closes", async (t) => {
    clock(t);
    await withDriver({ q: () => 1 }, { live: { queries: ["q"], public: true, keepAlive: 1000 } }, async ({ d }) => {
        const stream = await d.open();
        t.mock.timers.tick(999);
        assert.deepEqual(comments(stream.res), []);
        t.mock.timers.tick(1);
        assert.deepEqual(comments(stream.res), ["keep-alive"]);
        t.mock.timers.tick(2000);
        assert.deepEqual(comments(stream.res), ["keep-alive", "keep-alive", "keep-alive"]);
        stream.leave();
        t.mock.timers.tick(5000);
        assert.equal(comments(stream.res).length, 3, "no keep-alive after the stream closed");
    });
});

test("keepAlive is 25 seconds unless told", async (t) => {
    clock(t);
    await withDriver({ q: () => 1 }, { live: { queries: ["q"], public: true } }, async ({ d }) => {
        const stream = await d.open();
        t.mock.timers.tick(24_999);
        assert.equal(comments(stream.res).length, 0);
        t.mock.timers.tick(1);
        assert.equal(comments(stream.res).length, 1);
    });
});

test("a stream replaced by a reopen with its id is ended, and only the new one is kept alive", async (t) => {
    clock(t);
    await withDriver({ q: () => 1 }, { live: { queries: ["q"], public: true, keepAlive: 1000 } }, async ({ d, handler }) => {
        const first = await d.open();
        const second = await d.open({ client: first.id });
        assert.equal(first.res.writableEnded, true);
        assert.equal(second.res.writableEnded, false);
        t.mock.timers.tick(1000);
        assert.equal(comments(first.res).length, 0);
        assert.equal(comments(second.res).length, 1);
        first.leave();
        t.mock.timers.tick(60_000);
        assert.equal(handler.stats().connected, 1, "the old stream's close does not drop the client");
        assert.equal(handler.stats().clients, 1);
        assert.equal(comments(second.res).length, 61, "nor does it stop the new stream's keep-alive");
    });
});

// ---- the grace period ---------------------------------------------------------------------------------

test("a client whose stream closed is kept graceMs, with its subscriptions, then forgotten", async (t) => {
    clock(t);
    let value = 1;
    await withDriver({ q: () => value }, { live: { queries: ["q"], public: true } }, async ({ d, handler }) => {
        const stream = await d.open();
        await d.subscribe(stream.id, "q");
        stream.leave();
        assert.deepEqual([handler.stats().clients, handler.stats().connected, handler.stats().groups], [1, 0, 1]);
        value = 2;
        await handler.invalidate("q");
        assert.equal(stream.res.patches.length, 1, "nothing is written to a stream that has closed");
        t.mock.timers.tick(29_999);
        assert.equal(handler.stats().clients, 1);
        t.mock.timers.tick(1);
        assert.deepEqual(handler.stats(), { clients: 0, groups: 0, subscriptions: 0, connected: 0, droppedForLag: 0, bus: null });
        const reopened = await d.open({ client: stream.id });
        assert.equal(reopened.res.statusCode, 403);
        assert.deepEqual(reopened.res.json, STALE);
    });
});

test("a client that reopens its stream within graceMs keeps its id and subscriptions", async (t) => {
    clock(t);
    let value = { n: 1 };
    await withDriver({ q: () => value }, { live: { queries: ["q"], public: true, graceMs: 1000 } }, async ({ d, handler }) => {
        const stream = await d.open();
        await d.subscribe(stream.id, "q");
        stream.leave();
        t.mock.timers.tick(999);
        const back = await d.open({ client: stream.id });
        assert.equal(back.id, stream.id);
        t.mock.timers.tick(5000);
        assert.equal(handler.stats().clients, 1, "the reopen cancelled the drop");
        value = { n: 2 };
        await handler.invalidate("q");
        assert.deepEqual(back.res.patches, [{ key: "q:[]", set: [["n", 2]], del: [] }]);
    });
});

test("graceMs: 0 forgets a closed stream's client at the next turn of the timers", async (t) => {
    clock(t);
    await withDriver({ q: () => 1 }, { live: { queries: ["q"], public: true, graceMs: 0 } }, async ({ d, handler }) => {
        const stream = await d.open();
        await d.subscribe(stream.id, "q");
        stream.leave();
        t.mock.timers.tick(0);
        assert.equal(handler.stats().clients, 0);
        assert.equal(handler.stats().groups, 0);
    });
});

test("a client whose grace period ends while authorize runs is refused 403 live.client-unknown and joins no group", async (t) => {
    clock(t);
    const answer = deferred();
    let runs = 0;
    await withDriver({ q: () => { runs += 1; } }, { live: { queries: ["q"], graceMs: 50, authorize: () => answer.promise } }, async ({ d, handler }) => {
        const stream = await d.open();
        const pending = d.subscribe(stream.id, "q");
        await flush();
        stream.leave();
        t.mock.timers.tick(50);
        assert.equal(handler.stats().clients, 0);
        answer.resolve(true);
        const refused = await pending;
        assert.equal(refused.status, 403);
        assert.deepEqual(refused.body, STALE);
        assert.deepEqual([handler.stats().groups, handler.stats().subscriptions], [0, 0]);
        assert.equal(runs, 0);
    });
});

// ---- the re-check before a patch -------------------------------------------------------------------------

test("authorize is re-asked before a patch once recheckMs has passed, as the subscribe's context, with recheck: true", async (t) => {
    clock(t);
    const made = [];
    const asked = [];
    let value = 1;
    await withDriver({ q: () => value }, {
        context: () => { const ctx = { n: made.length }; made.push(ctx); return ctx; },
        live: { queries: ["q"], recheckMs: 1000, authorize(name, args, info) { asked.push({ self: this, info }); return true; } },
    }, async ({ d, handler }) => {
        const stream = await d.open();
        await d.subscribe(stream.id, "q");
        const subscribeContext = asked[0].self;
        assert.equal(subscribeContext, made.at(-1));
        t.mock.timers.tick(999);
        value = 2;
        await handler.invalidate("q");
        assert.equal(asked.length, 1, "trusted within recheckMs");
        assert.equal(stream.res.patches.length, 2);
        t.mock.timers.tick(1);
        value = 3;
        await handler.invalidate("q");
        assert.equal(asked.length, 2);
        assert.equal(asked[1].self, subscribeContext, "the context kept from the subscribe");
        assert.deepEqual(asked[1].info, { clientId: stream.id, recheck: true });
        assert.equal(stream.res.patches.length, 3, "allowed: the patch went");
        value = 4;
        await handler.invalidate("q");
        assert.equal(asked.length, 2, "the next re-check is recheckMs after the last one");
    });
});

test("a re-check that refuses withholds the patch, tells the client 'not allowed' and drops the subscription", async (t) => {
    clock(t);
    let allowed = true;
    let value = 1;
    await withDriver({ q: () => value }, { live: { queries: ["q"], authorize: () => allowed } }, async ({ d, handler }) => {
        const a = await d.open();
        const b = await d.open();
        await d.subscribe(a.id, "q");
        await d.subscribe(b.id, "q");
        t.mock.timers.tick(30_000);
        allowed = false;
        value = 2;
        await handler.invalidate("q");
        for (const stream of [a, b]) assert.deepEqual(stream.res.patches, [{ key: "q:[]", full: 1 }, { key: "q:[]", error: "not allowed" }]);
        assert.deepEqual([handler.stats().groups, handler.stats().subscriptions, handler.stats().clients], [0, 0, 2]);
    });
});

test("recheckMs: 0 trusts the subscribe's answer for every patch", async (t) => {
    clock(t);
    let asked = 0;
    let value = 1;
    await withDriver({ q: () => value }, { live: { queries: ["q"], recheckMs: 0, authorize: () => { asked += 1; return true; } } }, async ({ d, handler }) => {
        const stream = await d.open();
        await d.subscribe(stream.id, "q");
        t.mock.timers.tick(10 * 60_000);
        value = 2;
        await handler.invalidate("q");
        assert.equal(asked, 1);
        assert.equal(stream.res.patches.length, 2);
        assert.equal(await handler.invalidateAccess(null), 0, "a forced re-check still asks");
        assert.equal(asked, 2);
    });
});

test("a forced re-check that allows restarts the recheckMs clock", async (t) => {
    clock(t);
    let asked = 0;
    let value = 1;
    await withDriver({ q: () => value }, { live: { queries: ["q"], recheckMs: 1000, authorize: () => { asked += 1; return true; } } }, async ({ d, handler }) => {
        const stream = await d.open();
        await d.subscribe(stream.id, "q");
        t.mock.timers.tick(5000);
        await handler.invalidateAccess(null);
        assert.equal(asked, 2);
        value = 2;
        await handler.invalidate("q");
        assert.equal(asked, 2, "just re-checked");
        assert.equal(stream.res.patches.length, 2);
    });
});

// ---- the subscribe budget -------------------------------------------------------------------------------

test("the subscribe budget refills at maxPostsPerMinute per minute, up to maxPostsPerMinute", async (t) => {
    clock(t);
    await withDriver({ q: (n) => n }, { live: { queries: ["q"], public: true, maxPostsPerMinute: 2 } }, async ({ d }) => {
        const stream = await d.open();
        const post = () => d.unsubscribe(stream.id, "q", [1]).then((answer) => answer.status);
        assert.deepEqual([await post(), await post(), await post()], [200, 200, 429]);
        t.mock.timers.tick(30_000);
        assert.deepEqual([await post(), await post()], [200, 429], "half a minute is half the budget");
        t.mock.timers.tick(10 * 60_000);
        assert.deepEqual([await post(), await post(), await post()], [200, 200, 429], "never more than the whole budget");
    });
});

test("refusals before the client is known spend none of the budget", async (t) => {
    clock(t);
    await withDriver({ q: (n) => n }, { live: { queries: ["q"], public: true, maxPostsPerMinute: 1 } }, async ({ d }) => {
        const stream = await d.open();
        for (let i = 0; i < 5; i++) assert.equal((await d.unsubscribe("not-minted", "q")).status, 403);
        assert.equal((await d.post("_live", {})).status, 400);
        assert.equal((await d.unsubscribe(stream.id, "q")).status, 200);
        assert.equal((await d.unsubscribe(stream.id, "q")).status, 429);
    });
});

// ---- a stream that falls behind --------------------------------------------------------------------------

test("a stream more than maxBufferBytes behind is ended and counted, onError is told, and the client can come back", async (t) => {
    clock(t);
    const errors = [];
    let value = 1;
    await withDriver({ q: () => value }, { live: { queries: ["q"], public: true, keepAlive: 1000, maxBufferBytes: 100 }, onError: (...args) => errors.push(args) }, async ({ d, handler }) => {
        const stream = await d.open();
        await d.subscribe(stream.id, "q");
        stream.res.writableLength = 100;
        value = 2;
        await handler.invalidate("q");
        assert.equal(stream.res.writableEnded, false, "at the limit is not behind it");
        stream.res.writableLength = 101;
        value = 3;
        await handler.invalidate("q");
        assert.equal(stream.res.writableEnded, true);
        assert.deepEqual([handler.stats().droppedForLag, handler.stats().connected, handler.stats().clients], [1, 0, 1]);
        assert.equal(errors.length, 1);
        assert.equal(errors[0][0].message, `live client ${stream.id} is 101 bytes behind; dropping the stream`);
        assert.deepEqual(errors[0].slice(1), ["live.backpressure", []]);
        const written = stream.res.chunks.length;
        t.mock.timers.tick(5000);
        assert.equal(stream.res.chunks.length, written, "its keep-alive stopped");
        stream.leave();
        const back = await d.open({ client: stream.id });
        assert.equal(back.id, stream.id, "within graceMs the client is still there");
        await d.subscribe(stream.id, "q");
        assert.deepEqual(back.res.patches, [{ key: "q:[]", full: 3 }], "re-announced, it is sent the current value");
    });
});

test("a stream dropped for lag with no stream back is forgotten after graceMs, and no onError is needed", async (t) => {
    clock(t);
    await withDriver({ q: () => ({ at: Date.now() }) }, { live: { queries: ["q"], public: true, graceMs: 100, maxBufferBytes: 1 } }, async ({ d, handler }) => {
        const stream = await d.open();
        stream.res.writableLength = 2;
        await d.subscribe(stream.id, "q");
        assert.equal(stream.res.writableEnded, true, "the first value put it behind");
        assert.equal(handler.stats().droppedForLag, 1);
        t.mock.timers.tick(100);
        assert.deepEqual([handler.stats().clients, handler.stats().groups], [0, 0]);
    });
});

test("a response that reports no write buffer is taken as caught up", async (t) => {
    clock(t);
    let value = 1;
    await withDriver({ q: () => value }, { live: { queries: ["q"], public: true, maxBufferBytes: 1 } }, async ({ d, handler }) => {
        const stream = await d.open();
        stream.res.writableLength = undefined;
        await d.subscribe(stream.id, "q");
        value = 2;
        await handler.invalidate("q");
        assert.equal(stream.res.writableEnded, false);
        assert.equal(stream.res.patches.length, 2);
        assert.equal(handler.stats().droppedForLag, 0);
    });
});

// ---- requests that go away while they are waited on ----------------------------------------------------------

test("a stream request that goes away while identify runs is answered nothing and makes no client", async (t) => {
    clock(t);
    for (const leave of [
        (req) => req.emit("close"),
        (req, res) => res.emit("close"),
        (req) => { req.destroyed = true; },
        (req, res) => { res.destroyed = true; },
        (req, res) => { res.writableEnded = true; },
        (req) => { req.socket.destroyed = true; },
    ]) {
        const answer = deferred();
        await withDriver({ q: () => 1 }, { live: { queries: ["q"], public: true, keepAlive: 1000, maxStreamsPerCaller: 1, identify: () => answer.promise } }, async ({ handler, d }) => {
            const req = fakeStreamRequest();
            const res = new FakeResponse();
            const handled = handler(req, res);
            await flush();
            leave(req, res);
            answer.resolve("owner");
            assert.equal(await handled, true);
            assert.deepEqual(res.chunks, [], String(leave));
            assert.equal(res.headersSent, false);
            assert.deepEqual([handler.stats().clients, handler.stats().connected], [0, 0]);
            t.mock.timers.tick(5000);
            assert.deepEqual(res.chunks, [], "no keep-alive either");
        });
        // The next stream of that caller is not held back by a place the gone one took.
        const handler = serviceDispatcher({ q: () => 1 }, "/api", { live: { queries: ["q"], public: true, maxStreamsPerCaller: 1, identify: () => "owner" } });
        assert.ok((await driver(handler).open()).id);
        handler.close();
    }
});

test("a stream request whose response has already ended is answered nothing, with no identify at all", async (t) => {
    clock(t);
    await withDriver({ q: () => 1 }, { live: { queries: ["q"], public: true } }, async ({ handler }) => {
        const res = new FakeResponse();
        res.writableEnded = true;
        assert.equal(await handler(fakeStreamRequest(), res), true);
        assert.deepEqual(res.chunks, []);
        assert.equal(handler.stats().clients, 0);
    });
});

test("an error on a stream's response (a socket that died mid-write) is absorbed, and the close after it cleans up", async (t) => {
    clock(t);
    await withDriver({ q: () => 1 }, { live: { queries: ["q"], public: true, graceMs: 100 } }, async ({ d, handler }) => {
        const stream = await d.open();
        await d.subscribe(stream.id, "q");
        assert.doesNotThrow(() => stream.res.emit("error", new Error("write EPIPE")), "an 'error' with no listener would be thrown");
        stream.leave();
        assert.equal(handler.stats().connected, 0);
        t.mock.timers.tick(100);
        assert.deepEqual([handler.stats().clients, handler.stats().groups], [0, 0]);
    });
});

test("a stream that closes after close() leaves nothing behind once its grace period ends", async (t) => {
    clock(t);
    await withDriver({ q: () => 1 }, { live: { queries: ["q"], public: true, graceMs: 100 } }, async ({ d, handler }) => {
        const stream = await d.open();
        await d.subscribe(stream.id, "q");
        handler.close();
        assert.equal(stream.res.writableEnded, true, "close ended the stream");
        stream.leave();
        t.mock.timers.tick(100);
        assert.deepEqual(handler.stats(), { clients: 0, groups: 0, subscriptions: 0, connected: 0, droppedForLag: 0, bus: null });
        assert.equal((await d.open()).res.statusCode, 200, "and the dispatcher still serves");
    });
});

test("a client that leaves while a patch is being delivered to another is skipped", async (t) => {
    clock(t);
    const held = deferred();
    const asked = [];
    let value = 1;
    await withDriver({ q: () => value }, {
        context: (req) => ({ who: req.headers["x-who"] }),
        live: {
            queries: ["q"], graceMs: 0, recheckMs: 1000,
            authorize(name, args, info) { if (info.recheck) { asked.push(this.who); if (this.who === "a") return held.promise; } return true; },
        },
    }, async ({ d, handler }) => {
        const a = await d.open();
        const b = await d.open();
        await d.subscribe(a.id, "q", [], { headers: { "x-who": "a" } });
        await d.subscribe(b.id, "q", [], { headers: { "x-who": "b" } });
        t.mock.timers.tick(1000);
        value = 2;
        const delivering = handler.invalidate("q");
        await flush();
        assert.deepEqual(asked, ["a"], "the re-check for a is being waited on");
        b.leave();
        t.mock.timers.tick(0);
        assert.equal(handler.stats().clients, 1, "b is gone");
        held.resolve(true);
        await delivering;
        assert.deepEqual(asked, ["a"], "nobody asked about a client that is no longer there");
        assert.deepEqual(a.res.patches.at(-1), { key: "q:[]", set: [["", 2]], del: [] });
        assert.equal(b.res.patches.length, 1);
    });
});

test("a subscription dropped while invalidateAccess asks about another is not asked about", async (t) => {
    clock(t);
    const held = deferred();
    const asked = [];
    await withDriver({ q: (n) => n }, {
        live: { queries: ["q"], authorize: (name, args, info) => { if (info.recheck) { asked.push(args[0]); if (args[0] === 1) return held.promise; } return true; } },
    }, async ({ d, handler }) => {
        const stream = await d.open();
        await d.subscribe(stream.id, "q", [1]);
        await d.subscribe(stream.id, "q", [2]);
        const access = handler.invalidateAccess(null);
        await flush();
        await d.unsubscribe(stream.id, "q", [2]);
        held.resolve(true);
        assert.equal(await access, 0);
        assert.deepEqual(asked, [1]);
        assert.equal(handler.stats().subscriptions, 1);
    });
});

test("while invalidateAccess is asking, a patch for another of the client's subscriptions is re-checked too", async (t) => {
    clock(t);
    const held = deferred();
    const asked = [];
    let value = 1;
    await withDriver({ q: (n) => n * value }, {
        live: { queries: ["q"], authorize: (name, args, info) => { if (info.recheck) { asked.push(args[0]); if (args[0] === 1) return held.promise; } return true; } },
    }, async ({ d, handler }) => {
        const stream = await d.open();
        await d.subscribe(stream.id, "q", [1]);
        await d.subscribe(stream.id, "q", [2]);
        const access = handler.invalidateAccess(null);
        await flush();
        value = 10;
        await handler.invalidate({ name: "q", args: [2] });
        assert.deepEqual(asked, [1, 2], "the cleared check is not trusted");
        assert.deepEqual(stream.res.patches.at(-1), { key: "q:[2]", set: [["", 20]], del: [] });
        held.resolve(true);
        assert.equal(await access, 0);
    });
});
