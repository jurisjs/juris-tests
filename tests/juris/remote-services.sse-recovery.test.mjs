// remote-services.js, the live client (sseClient), part two: what it does when things go wrong or go
// quiet. A refused subscribe (a stale client id, a busy server, a refusal for good), a lost stream
// and the backoff before it is reopened, the idle close of a stream nothing watches, a hidden tab's
// pause, a page put in the back/forward cache, an environment without timers, and dispose(). Timers are node:test's mock timers, enabled
// before the client is installed (it keeps the setTimeout it finds then). Held to REFERENCE.md
// ("remote-services.js", "Reserved state roots": $live).
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import { sseClient } from "juris/remote-services.js";
import { liveKey, LIVE_CODES } from "juris/live-protocol.js";
import { ServiceError } from "juris/errors.js";
import {
    withGlobals,
    quiet,
    flush,
    deferred,
    eventSources,
    liveEndpoint,
    visibilityDocument,
    pageWindow,
} from "../support/remote-services-fakes.mjs";

// An instance with a live client (backoff 100..400 ms and idleMs 1000 unless told), its streams and
// its /_live endpoint, and `document` and `window` when given. Mock timers first, when `t` is given.
async function withLive(t, { options = {}, answer, document, window, services } = {}, fn) {
    if (t) t.mock.timers.enable({ apis: ["setTimeout"] });
    const sources = eventSources();
    const endpoint = liveEndpoint(answer);
    const globals = {
        fetch: endpoint.fetch,
        ...(document ? { document } : {}),
        ...(window ? { window } : {}),
    };
    return withGlobals(globals, async () => {
        const juris = new Juris({ isServer: false, services });
        const plugin = sseClient({ EventSourceImpl: sources.FakeEventSource, idleMs: 1000, backoff: { minMs: 100, maxMs: 400 }, ...options });
        juris.use(plugin);
        try {
            await fn({ juris, plugin, sources, endpoint, transport: juris.liveTransport, tick: (ms) => t.mock.timers.tick(ms) });
        } finally {
            plugin.dispose();
        }
    });
}

const raw = (juris, path) => juris.toRaw(juris.peek(path));
const refusal = (status, body = {}, statusText) => ({ status, body, statusText });

// ---- a stale client id -------------------------------------------------------------------------

test("a subscribe refused for a stale client id (live.client-unknown) closes the stream and opens a new one after the backoff", async (t) => {
    let refuse = true;
    const answer = (body) => (body.subscribe && refuse ? refusal(403, { error: "Unknown stream.", code: LIVE_CODES.CLIENT_UNKNOWN }) : {});
    const errors = [];
    await withLive(t, { answer, options: { onError: (error) => errors.push(error) } }, async ({ juris, sources, endpoint, tick }) => {
        juris.live("rows.list", "rows", 1);
        const first = sources.last;
        first.hello("c1");
        const said = await quiet("error", () => flush());
        assert.deepEqual(said, [], "no error for the console");
        assert.deepEqual(errors, [], "nor for onError");
        assert.ok(first.closed, "the stale stream is given back");
        assert.equal(juris.api.liveStatus(), false);
        assert.equal(juris.api.liveState("rows.list"), "offline");
        tick(99);
        assert.equal(sources.opened.length, 1);
        tick(1);
        assert.equal(sources.opened.length, 2, "a new stream, which the server will name anew");
        refuse = false;
        sources.last.hello("c2");
        await flush();
        assert.deepEqual(endpoint.subscribes().map((body) => body.client), ["c1", "c2"], "its hello announces the subscription again");
        assert.equal(juris.api.liveState("rows.list"), "pending");
        assert.equal(juris.api.liveStatus(), true);
    });
});

test("a refusal with no code that speaks of a client id, from a server before the codes, is a stale id too", async (t) => {
    let refuse = true;
    const answer = (body) => (body.subscribe && refuse ? refusal(403, { error: "Unknown Client ID." }) : {});
    await withLive(t, { answer }, async ({ juris, sources, tick }) => {
        juris.live("rows", "rows");
        sources.last.hello("c1");
        const said = await quiet("error", () => flush());
        assert.deepEqual(said, []);
        assert.ok(sources.last.closed);
        refuse = false;
        tick(100);
        assert.equal(sources.opened.length, 2);
    });
});

test("a refusal with another code is never taken for a stale id, whatever its words", async (t) => {
    const answer = (body) => (body.subscribe ? refusal(403, { error: "This client id may not read it.", code: "live.forbidden" }) : {});
    const errors = [];
    await withLive(t, { answer, options: { onError: (error) => errors.push(error) } }, async ({ juris, sources, tick }) => {
        juris.live("rows", "rows");
        sources.last.hello("c1");
        await flush();
        tick(1000);
        assert.equal(sources.opened.length, 1);
        assert.equal(sources.last.closed, false);
        assert.equal(juris.api.liveState("rows"), "failed");
        assert.equal(errors.length, 1);
    });
});

test("a stale-id refusal about a stream already replaced closes nothing", async (t) => {
    const first = deferred();
    const answer = (body) => (body.client === "c1" && body.subscribe ? first.promise : {});
    await withLive(t, { answer }, async ({ juris, sources, endpoint, tick }) => {
        juris.live("rows", "rows");
        sources.last.hello("c1");
        await flush();
        sources.last.fail(2);                  // lost: a new stream after the backoff
        tick(100);
        const second = sources.last;
        second.hello("c2");
        await flush();
        first.resolve(refusal(403, { error: "Unknown stream.", code: LIVE_CODES.CLIENT_UNKNOWN }));
        await flush();
        assert.equal(sources.opened.length, 2);
        assert.equal(second.closed, false, "the stream that replaced it stays");
        assert.equal(juris.api.liveStatus(), true);
        assert.deepEqual(endpoint.subscribes().map((body) => body.client), ["c1", "c2"], "and its own announce went out");
    });
});

// ---- a busy server -----------------------------------------------------------------------------

test("a subscribe refused as busy (429, 503) is asked again after a backoff that doubles, and is no error", async (t) => {
    let busy = [429, 503, 429];
    const answer = (body) => (body.subscribe && busy.length ? refusal(busy.shift(), { error: "Too many." }) : {});
    const errors = [];
    await withLive(t, { answer, options: { onError: (error) => errors.push(error) } }, async ({ juris, sources, endpoint, tick }) => {
        juris.live("rows", "rows");
        sources.last.hello("c1");
        const said = await quiet("error", async () => {
            await flush();
            assert.equal(endpoint.subscribes().length, 1);
            tick(99);
            await flush();
            assert.equal(endpoint.subscribes().length, 1);
            tick(1);
            await flush();
            assert.equal(endpoint.subscribes().length, 2, "after minMs");
            tick(199);
            await flush();
            assert.equal(endpoint.subscribes().length, 2);
            tick(1);
            await flush();
            assert.equal(endpoint.subscribes().length, 3, "after twice that");
            tick(400);
            await flush();
            assert.equal(endpoint.subscribes().length, 4, "up to maxMs");
            tick(10_000);
            await flush();
        });
        assert.equal(endpoint.subscribes().length, 4, "answered at last, asked no more");
        assert.deepEqual(said, []);
        assert.deepEqual(errors, []);
        assert.equal(juris.api.liveState("rows"), "pending", "never failed");
        assert.equal(sources.opened.length, 1, "the stream is kept");
    });
});

test("a busy refusal for a key unsubscribed meanwhile is not asked again", async (t) => {
    const answer = (body) => (body.subscribe ? refusal(429) : {});
    await withLive(t, { answer }, async ({ juris, sources, endpoint, tick }) => {
        const stop = juris.live("rows", "rows");
        sources.last.hello("c1");
        await flush();
        stop();
        await flush();
        tick(100);
        await flush();
        assert.equal(endpoint.subscribes().length, 1);
    });
});

// ---- refused for good --------------------------------------------------------------------------

test("a subscribe refused for good marks its path failed with the words, and tells onError with a ServiceError, the name and the args", async (t) => {
    const answer = (body) => (body.subscribe ? refusal(403, { error: "Not yours.", code: "live.forbidden" }) : {});
    const told = [];
    await withLive(t, { answer, options: { onError: (...args) => told.push(args) } }, async ({ juris, sources, tick }) => {
        juris.live("secret", "account", 7, { tab: "a" });
        sources.last.hello("c1");
        const said = await quiet("error", () => flush());
        assert.deepEqual(said, [], "onError hears it instead of the console");
        assert.equal(juris.api.liveState("secret"), "failed");
        assert.equal(juris.api.liveMessage("secret"), "Not yours.");
        assert.equal(told.length, 1);
        const [error, name, args] = told[0];
        assert.ok(error instanceof ServiceError);
        assert.equal(error.message, "Not yours.");
        assert.equal(error.status, 403);
        assert.equal(error.code, "live.forbidden");
        assert.equal(name, "account");
        assert.deepEqual(args, [7, { tab: "a" }]);
        tick(10_000);
        await flush();
        assert.equal(sources.opened.length, 1, "neither a new stream nor a retry");
    });
});

test("a subscribe refused for good without onError is told to the console", async (t) => {
    const answer = (body) => (body.subscribe ? refusal(400, { error: "No such query.", code: LIVE_CODES.NOT_A_QUERY }) : {});
    await withLive(t, { answer }, async ({ juris, sources }) => {
        juris.live("rows", "rows");
        sources.last.hello("c1");
        const said = await quiet("error", () => flush());
        assert.deepEqual(said, [['Juris live query "rows" was refused (400): No such query.']]);
        assert.equal(juris.api.liveState("rows"), "failed");
        assert.equal(juris.api.liveMessage("rows"), "No such query.");
    });
});

test("a refusal with no words and no onError is told to the console with its status", async (t) => {
    const answer = (body) => (body.subscribe ? refusal(500, {}, "Internal Server Error") : {});
    await withLive(t, { answer }, async ({ juris, sources }) => {
        juris.live("rows", "rows");
        sources.last.hello("c1");
        const said = await quiet("error", () => flush());
        assert.deepEqual(said, [['Juris live query "rows" was refused (500): ']]);
        assert.equal(juris.api.liveMessage("rows"), "500 Internal Server Error");
    });
});

test("a refusal for a key unsubscribed while its request was in flight leaves no status behind", async (t) => {
    const held = deferred();
    await withLive(t, { answer: (body) => (body.subscribe ? held.promise : {}), options: { onError: () => { } } }, async ({ juris, sources }) => {
        const stop = juris.live("rows", "rows");
        sources.last.hello("c1");
        await flush();
        stop();
        held.resolve(refusal(403, { error: "Not yours." }));
        await flush();
        assert.equal(juris.api.liveState("rows"), null, "nothing is subscribed there");
        assert.deepEqual(juris.peek("$live.paths"), {});
    });
});

test("a refusal with no words of its own is named by its status line", async (t) => {
    const cases = [
        [refusal(500, {}, "Internal Server Error"), "500 Internal Server Error"],
        [refusal(500, { error: 42 }), "500"],
        [{ status: 502, statusText: "Bad Gateway", json: false }, "502 Bad Gateway"],
        [{ status: 404, statusText: "Not Found", badJson: true }, "404 Not Found"],
    ];
    const answers = cases.map(([said]) => said);
    const told = [];
    await withLive(t, { answer: (body) => (body.subscribe ? answers.shift() : {}), options: { onError: (error) => told.push(error) } }, async ({ juris, sources }) => {
        cases.forEach((_, i) => juris.live(`p${i}`, "rows", i));
        sources.last.hello("c1");
        await flush();
        assert.deepEqual(cases.map((_, i) => juris.api.liveMessage(`p${i}`)), cases.map(([, words]) => words));
        const byWords = (a, b) => a[0].localeCompare(b[0]);
        assert.deepEqual(told.map((error) => [error.message, error.status, "code" in error]).sort(byWords), cases.map(([said, words]) => [words, said.status, false]).sort(byWords));
    });
});

test("an onError that throws is told to the console, and the path is failed all the same", async (t) => {
    const answer = (body) => (body.subscribe ? refusal(403, { error: "Not yours." }) : {});
    await withLive(t, { answer, options: { onError: () => { throw new Error("hook broke"); } } }, async ({ juris, sources }) => {
        juris.live("rows", "rows");
        sources.last.hello("c1");
        const said = await quiet("error", () => flush());
        assert.deepEqual(said.map(([words, error]) => [words, error.message]), [["Juris live: onError failed", "hook broke"]]);
        assert.equal(juris.api.liveState("rows"), "failed");
    });
});

test("a failed path is pending again at the next hello, which asks again", async (t) => {
    let refuse = true;
    const answer = (body) => (body.subscribe && refuse ? refusal(403, { error: "Not yet." }) : {});
    await withLive(t, { answer }, async ({ juris, sources, endpoint }) => {
        juris.live("rows", "rows");
        sources.last.hello("c1");
        await quiet("error", () => flush());
        assert.equal(juris.api.liveState("rows"), "failed");
        refuse = false;
        sources.last.fail(0);
        sources.last.hello("c2");
        await flush();
        assert.equal(juris.api.liveState("rows"), "pending");
        assert.equal(juris.api.liveMessage("rows"), null);
        assert.equal(endpoint.subscribes().length, 2);
        sources.last.patch({ key: liveKey("rows", []), full: [1] });
        assert.equal(juris.api.liveState("rows"), "live");
    });
});

test("a subscribe whose request fails on the network leaves its path pending, and the next hello asks again", async (t) => {
    let down = true;
    const answer = (body) => (body.subscribe && down ? new TypeError("Failed to fetch") : {});
    await withLive(t, { answer }, async ({ juris, sources, endpoint }) => {
        juris.live("rows", "rows");
        sources.last.hello("c1");
        const said = await quiet("error", () => flush());
        assert.deepEqual(said, []);
        assert.equal(juris.api.liveState("rows"), "pending");
        down = false;
        sources.last.fail(0);
        sources.last.hello("c2");
        await flush();
        assert.deepEqual(endpoint.subscribes().map((body) => body.client), ["c1", "c2"]);
    });
});

test("a refusal that arrives after dispose() is dropped", async (t) => {
    const held = deferred();
    const told = [];
    await withLive(t, { answer: (body) => (body.subscribe ? held.promise : {}), options: { onError: (error) => told.push(error) } }, async ({ juris, sources, plugin }) => {
        juris.live("rows", "rows");
        sources.last.hello("c1");
        await flush();
        plugin.dispose();
        held.resolve(refusal(403, { error: "Not yours." }));
        const said = await quiet("error", () => flush());
        assert.deepEqual(said, []);
        assert.deepEqual(told, []);
    });
});

// ---- a lost stream -----------------------------------------------------------------------------

test("a stream the browser is retrying is offline until its hello, which counts a reconnect and opens no other", async (t) => {
    await withLive(t, {}, async ({ juris, sources, tick }) => {
        const key = liveKey("rows", [1]);
        juris.live("rows.list", "rows", 1);
        sources.last.hello("c1");
        sources.last.patch({ key, full: [1] });
        sources.last.fail(0);
        assert.equal(juris.api.liveStatus(), false);
        assert.equal(juris.api.liveState("rows.list"), "offline");
        assert.deepEqual(raw(juris, "rows.list"), [1], "the data stays on screen");
        tick(10_000);
        assert.equal(sources.opened.length, 1, "the browser reconnects by itself");
        sources.last.hello("c2");
        assert.equal(juris.api.liveStatus(), true);
        assert.equal(juris.peek("$live.reconnects"), 1);
        assert.equal(juris.peek("$live.generation"), 2);
        assert.equal(juris.api.liveState("rows.list"), "pending", "until the new full");
        sources.last.patch({ key, full: [2] });
        assert.equal(juris.api.liveState("rows.list"), "live");
    });
});

test("a stream the browser gave up on is reopened after a backoff that doubles up to maxMs, and starts again from minMs after a hello", async (t) => {
    await withLive(t, {}, async ({ juris, sources, tick }) => {
        juris.live("rows", "rows");
        const waits = [];
        const waitFor = () => {
            const before = sources.opened.length;
            let waited = 0;
            while (sources.opened.length === before && waited < 5000) { tick(1); waited += 1; }
            return waited;
        };
        for (let i = 0; i < 4; i += 1) {
            const stream = sources.last;
            stream.fail(2);
            assert.ok(stream.closed);
            waits.push(waitFor());
        }
        assert.deepEqual(waits, [100, 200, 400, 400]);
        sources.last.hello("c1");
        assert.equal(juris.peek("$live.reconnects"), 1, "a stream that was lost came back");
        sources.last.fail(2);
        assert.equal(waitFor(), 100, "minMs again after a hello");
    });
});

test("a reopen whose wait ends with nothing left subscribed opens nothing", async (t) => {
    await withLive(t, { options: { idleMs: 50 } }, async ({ juris, sources, endpoint, tick }) => {
        const stop = juris.live("rows", "rows");
        sources.last.hello("c1");
        await flush();
        sources.last.fail(2);
        stop();
        await flush();
        tick(1000);
        assert.equal(sources.opened.length, 1);
        assert.equal(endpoint.unsubscribes().length, 0, "with no stream there is no client to unsubscribe");
    });
});

test("a subscribe during a reopen's wait opens the stream at once, offline until its hello, and the wait goes", async (t) => {
    await withLive(t, {}, async ({ juris, sources, tick }) => {
        juris.live("a", "rows", 1);
        sources.last.hello("c1");
        sources.last.fail(2);
        juris.live("b", "rows", 2);
        assert.equal(sources.opened.length, 2, "opened at once");
        assert.equal(juris.api.liveState("b"), "offline", "the stream is down until its hello");
        tick(10_000);
        assert.equal(sources.opened.length, 2, "the wait opens no second one");
        sources.last.hello("c2");
        assert.equal(juris.api.liveState("a"), "pending");
        assert.equal(juris.api.liveState("b"), "pending");
    });
});

test("a refused stream that was reopened, and brought back, counts a reconnect for onReconnect and .reconnects", async (t) => {
    const reconnects = [];
    await withLive(t, { options: { onReconnect: (info) => reconnects.push(info) } }, async ({ juris, sources, tick }) => {
        juris.live("rows", "rows");
        sources.last.hello("c1");
        sources.last.fail(2);
        tick(100);
        sources.last.hello("c2");
        assert.equal(juris.peek("$live.reconnects"), 1);
        assert.deepEqual(reconnects, [{ clientId: "c2", generation: 2 }]);
    });
});

// ---- the idle close ----------------------------------------------------------------------------

test("a stream with nothing left to watch is kept for idleMs, so a navigation reuses it, then given back", async (t) => {
    await withLive(t, {}, async ({ juris, sources, endpoint, tick }) => {
        const stopA = juris.live("a", "rows", 1);
        const stream = sources.last;
        stream.hello("c1");
        await flush();
        stopA();
        await flush();
        assert.deepEqual(endpoint.unsubscribes(), [{ client: "c1", unsubscribe: liveKey("rows", [1]) }]);
        tick(999);
        assert.equal(stream.closed, false);
        const stopB = juris.live("b", "rows", 2);   // the next page subscribes in time
        tick(5000);
        assert.equal(stream.closed, false, "the close was cancelled");
        assert.equal(sources.opened.length, 1);
        await flush();
        assert.equal(endpoint.subscribes().at(-1).client, "c1", "announced on the stream it kept");
        stopB();
        tick(1000);
        assert.ok(stream.closed);
        assert.equal(juris.api.liveStatus(), false);
    });
});

test("idleMs 0 keeps the stream for a view re-made in the same turn only", async (t) => {
    await withLive(t, { options: { idleMs: 0 } }, async ({ juris, sources, tick }) => {
        const stop = juris.live("a", "rows", 1);
        const stream = sources.last;
        stream.hello("c1");
        stop();
        const again = juris.live("a", "rows", 1);
        tick(0);
        assert.equal(stream.closed, false);
        again();
        tick(0);
        assert.ok(stream.closed);
    });
});

test("a stop while another key is still watched closes nothing", async (t) => {
    await withLive(t, {}, async ({ juris, sources, tick }) => {
        const stop = juris.live("a", "rows", 1);
        juris.live("b", "rows", 2);
        sources.last.hello("c1");
        stop();
        tick(10_000);
        assert.equal(sources.last.closed, false);
    });
});

test("a stream opened after the idle close is a new one: onReconnect hears of it, .reconnects does not count it", async (t) => {
    const reconnects = [];
    await withLive(t, { options: { onReconnect: (info) => reconnects.push(info) } }, async ({ juris, sources, tick }) => {
        const stop = juris.live("a", "rows", 1);
        sources.last.hello("c1");
        stop();
        tick(1000);
        juris.live("b", "rows", 2);
        assert.equal(sources.opened.length, 2);
        assert.equal(juris.api.liveState("b"), "pending", "a stream given back on purpose is not down");
        sources.last.hello("c2");
        assert.equal(juris.peek("$live.generation"), 2);
        assert.equal(juris.peek("$live.reconnects"), undefined);
        assert.deepEqual(reconnects, [{ clientId: "c2", generation: 2 }]);
    });
});

// ---- close() and open() ------------------------------------------------------------------------

test("close() with paths subscribed gives the stream back and marks them offline; open() opens a new one that re-announces them", async (t) => {
    await withLive(t, {}, async ({ juris, sources, endpoint, transport }) => {
        const key = liveKey("rows", []);
        juris.live("rows", "rows");
        const first = sources.last;
        first.hello("c1");
        first.patch({ key, full: [1] });
        transport.close();
        assert.ok(first.closed);
        assert.equal(juris.api.liveStatus(), false);
        assert.equal(juris.api.liveState("rows"), "offline");
        assert.equal(transport.clientId, null, "the next stream gets a new id");
        juris.live("more", "other");
        assert.equal(juris.api.liveState("more"), "offline", "subscribed while paused");
        transport.open();
        assert.equal(sources.opened.length, 2);
        sources.last.hello("c2");
        await flush();
        assert.deepEqual(endpoint.subscribes().filter((body) => body.client === "c2").map((body) => body.subscribe.name).sort(), ["other", "rows"]);
        assert.equal(juris.api.liveState("rows"), "pending");
        assert.equal(juris.peek("$live.reconnects"), undefined, "a close on purpose is no reconnect");
        transport.open();
        assert.equal(sources.opened.length, 2, "open() with a stream open does nothing");
    });
});

test("open() with nothing subscribed opens nothing, and close() then leaves a later subscribe pending", async (t) => {
    await withLive(t, {}, async ({ juris, sources, transport }) => {
        transport.open();
        assert.equal(sources.opened.length, 0);
        const stop = juris.live("a", "rows");
        stop();
        transport.close();
        juris.live("b", "rows");
        assert.equal(juris.api.liveState("b"), "pending");
        assert.equal(sources.opened.length, 2);
    });
});

// ---- a hidden tab ------------------------------------------------------------------------------

test("a tab hidden for hiddenMs gives its stream back, its paths offline; shown again, a new stream, each path pending until its full", async (t) => {
    const doc = visibilityDocument("visible");
    await withLive(t, { document: doc, options: { hiddenMs: 500 } }, async ({ juris, sources, endpoint, tick }) => {
        const key = liveKey("rows", [1]);
        juris.live("rows.list", "rows", 1);
        const first = sources.last;
        first.hello("c1");
        await flush();
        first.patch({ key, full: [{ id: 1 }] });
        doc.show("hidden");
        tick(499);
        assert.equal(first.closed, false);
        tick(1);
        assert.ok(first.closed, "given back to the server");
        assert.equal(juris.api.liveState("rows.list"), "offline");
        assert.deepEqual(raw(juris, "rows.list"), [{ id: 1 }], "the data is left as it was");
        doc.show("visible");
        assert.equal(sources.opened.length, 2, "a new stream the moment it is shown");
        sources.last.hello("c2");
        await flush();
        assert.deepEqual(endpoint.subscribes().map((body) => body.client), ["c1", "c2"]);
        assert.equal(juris.api.liveState("rows.list"), "pending");
        sources.last.patch({ key, full: [{ id: 2 }] });
        assert.equal(juris.api.liveState("rows.list"), "live");
        assert.equal(juris.peek("$live.reconnects"), undefined, "a pause is no reconnect");
    });
});

test("a tab shown again before hiddenMs keeps its stream", async (t) => {
    const doc = visibilityDocument("visible");
    await withLive(t, { document: doc, options: { hiddenMs: 500 } }, async ({ juris, sources, tick }) => {
        juris.live("rows", "rows");
        sources.last.hello("c1");
        doc.show("hidden");
        tick(300);
        doc.show("visible");
        tick(10_000);
        assert.equal(sources.last.closed, false);
        assert.equal(sources.opened.length, 1);
        assert.equal(juris.api.liveStatus(), true);
    });
});

test("without hiddenMs a hidden tab keeps its stream however long", async (t) => {
    const doc = visibilityDocument("visible");
    await withLive(t, { document: doc }, async ({ juris, sources, tick }) => {
        juris.live("rows", "rows");
        sources.last.hello("c1");
        doc.show("hidden");
        tick(2 ** 31 - 1);
        assert.equal(sources.last.closed, false);
    });
});

test("a tab already hidden when its stream opens counts hiddenMs from that opening", async (t) => {
    const doc = visibilityDocument("hidden");
    await withLive(t, { document: doc, options: { hiddenMs: 200 } }, async ({ juris, sources, tick }) => {
        juris.live("rows", "rows");
        const opened = sources.last;
        opened.hello("c1");
        tick(200);
        assert.ok(opened.closed, "never shown, given back all the same");
        assert.equal(juris.api.liveState("rows"), "offline");
        doc.show("visible");
        assert.equal(sources.opened.length, 2);
    });
});

test("a tab shown while a reopen waits on its backoff connects now, and the wait goes", async (t) => {
    const doc = visibilityDocument("visible");
    await withLive(t, { document: doc, options: { backoff: { minMs: 5000, maxMs: 5000 } } }, async ({ juris, sources, tick }) => {
        juris.live("rows", "rows");
        sources.last.hello("c1");
        sources.last.fail(2);
        doc.show("hidden");
        assert.equal(sources.opened.length, 1);
        doc.show("visible");
        assert.equal(sources.opened.length, 2, "connected now rather than on the timer");
        tick(10_000);
        assert.equal(sources.opened.length, 2);
    });
});

test("only a tab that is shown opens a stream; one shown with a stream, or with nothing subscribed, opens none", async (t) => {
    const doc = visibilityDocument("visible");
    await withLive(t, { document: doc }, async ({ juris, sources, tick }) => {
        doc.show("visible");
        assert.equal(sources.opened.length, 0, "nothing subscribed");
        juris.live("rows", "rows");
        doc.show("visible");
        assert.equal(sources.opened.length, 1, "a stream open already");
        sources.last.hello("c1");
        sources.last.fail(2);
        doc.show("prerender");
        assert.equal(sources.opened.length, 1, "a state other than visible opens nothing");
        tick(100);
        assert.equal(sources.opened.length, 2, "the backoff's wait does");
    });
});

// ---- a page in the back/forward cache ------------------------------------------------------------

test("a pagehide gives the stream back, its paths offline; a pageshow from the cache opens a new one, each path pending until its full", async (t) => {
    const win = pageWindow();
    await withLive(t, { window: win }, async ({ juris, sources, endpoint }) => {
        const key = liveKey("rows", [1]);
        juris.live("rows.list", "rows", 1);
        const first = sources.last;
        first.hello("c1");
        await flush();
        first.patch({ key, full: [{ id: 1 }] });
        assert.equal(juris.api.liveState("rows.list"), "live");
        win.hide(true);
        assert.ok(first.closed, "given back as the page is put in the cache");
        assert.equal(juris.api.liveStatus(), false);
        assert.equal(juris.api.liveState("rows.list"), "offline");
        assert.deepEqual(raw(juris, "rows.list"), [{ id: 1 }], "the data is left as it was");
        win.show(true);
        assert.equal(sources.opened.length, 2, "a new stream the moment it is shown from the cache");
        assert.equal(juris.api.liveState("rows.list"), "offline", "until the server greets it");
        sources.last.hello("c2");
        await flush();
        assert.deepEqual(
            endpoint.subscribes().map((body) => [body.client, body.subscribe.key]),
            [["c1", key], ["c2", key]],
            "its hello announces the subscription again",
        );
        assert.equal(juris.api.liveState("rows.list"), "pending");
        sources.last.patch({ key, full: [{ id: 1 }, { id: 2 }] });
        assert.equal(juris.api.liveState("rows.list"), "live");
        assert.deepEqual(raw(juris, "rows.list"), [{ id: 1 }, { id: 2 }], "what came meanwhile");
        assert.equal(juris.peek("$live.generation"), 2);
        assert.equal(juris.peek("$live.reconnects"), undefined, "a page put away is no reconnect");
    });
});

test("every pagehide gives the stream back, and only a pageshow from the cache opens a new one", async (t) => {
    const win = pageWindow();
    await withLive(t, { window: win }, async ({ juris, sources }) => {
        juris.live("rows", "rows");
        sources.last.hello("c1");
        win.hide(false);
        assert.ok(sources.last.closed, "a page leaving for good gives it back too");
        win.show(false);
        assert.equal(sources.opened.length, 1, "a page shown for the first time opens nothing");
        assert.equal(juris.api.liveState("rows"), "offline");
        win.show(true);
        assert.equal(sources.opened.length, 2);
        win.show(true);
        assert.equal(sources.opened.length, 2, "a stream open already");
    });
});

test("while the page is put away nothing opens a stream, a subscribe nor the tab shown, and the pageshow announces them all", async (t) => {
    const doc = visibilityDocument("visible");
    const win = pageWindow();
    await withLive(t, { window: win, document: doc }, async ({ juris, sources, endpoint }) => {
        juris.live("a", "rows", 1);
        sources.last.hello("c1");
        await flush();
        win.hide(true);
        juris.live("b", "rows", 2);
        assert.equal(sources.opened.length, 1, "no stream for a subscribe made as the page is put away");
        assert.equal(juris.api.liveState("b"), "offline");
        doc.show("hidden");
        doc.show("visible");
        assert.equal(sources.opened.length, 1, "nor for the tab shown before the pageshow");
        win.show(true);
        assert.equal(sources.opened.length, 2);
        sources.last.hello("c2");
        await flush();
        const announced = endpoint.subscribes()
            .filter((body) => body.client === "c2")
            .map((body) => body.subscribe.args[0]);
        assert.deepEqual(announced.sort(), [1, 2]);
        assert.equal(juris.api.liveState("a"), "pending");
        assert.equal(juris.api.liveState("b"), "pending");
    });
});

test("a reopen's wait that ends while the page is put away opens nothing, and the pageshow's stream is the only one", async (t) => {
    const win = pageWindow();
    await withLive(t, { window: win }, async ({ juris, sources, tick }) => {
        juris.live("rows", "rows");
        sources.last.hello("c1");
        sources.last.fail(2);
        win.hide(true);
        tick(10_000);
        assert.equal(sources.opened.length, 1, "nothing reopens in the cache");
        win.show(true);
        assert.equal(sources.opened.length, 2);
        tick(10_000);
        assert.equal(sources.opened.length, 2, "the wait is gone");
    });
});

test("a pagehide gives back a stream kept for idleMs, and the pageshow opens none for nothing subscribed", async (t) => {
    const win = pageWindow();
    await withLive(t, { window: win }, async ({ juris, sources }) => {
        const stop = juris.live("rows", "rows");
        sources.last.hello("c1");
        stop();
        assert.equal(sources.last.closed, false, "kept for idleMs");
        win.hide(true);
        assert.ok(sources.last.closed);
        win.show(true);
        assert.equal(sources.opened.length, 1);
        juris.live("more", "rows");
        assert.equal(sources.opened.length, 2, "the next subscribe opens one");
        assert.equal(juris.api.liveState("more"), "pending");
    });
});

test("dispose() removes the pagehide and pageshow listeners", async (t) => {
    const win = pageWindow();
    await withLive(t, { window: win }, async ({ juris, plugin, sources }) => {
        assert.equal(win.count("pagehide"), 1);
        assert.equal(win.count("pageshow"), 1);
        juris.live("rows", "rows");
        sources.last.hello("c1");
        plugin.dispose();
        assert.equal(win.count("pagehide"), 0);
        assert.equal(win.count("pageshow"), 0);
    });
});

test("after dispose() a window that cannot remove its listeners wakes nothing", async (t) => {
    const win = pageWindow({ removable: false });
    await withLive(t, { window: win }, async ({ juris, plugin, sources }) => {
        assert.equal(win.count("pageshow"), 1);
        juris.live("rows", "rows");
        sources.last.hello("c1");
        plugin.dispose();
        win.hide(true);
        win.show(true);
        assert.equal(sources.opened.length, 1);
        assert.equal(juris.peek("$live.connected"), false);
    });
});

// ---- no timers ---------------------------------------------------------------------------------

// Installs a live client where there is no setTimeout (it looks for one once, at install).
async function withoutTimers(fn) {
    const sources = eventSources();
    const endpoint = liveEndpoint();
    const doc = visibilityDocument("visible");
    await withGlobals({ fetch: endpoint.fetch, document: doc }, async () => {
        const juris = new Juris({ isServer: false });
        const plugin = sseClient({ EventSourceImpl: sources.FakeEventSource, hiddenMs: 0 });
        await withGlobals({ setTimeout: undefined, clearTimeout: undefined }, () => juris.use(plugin));
        try {
            await fn({ juris, sources, doc });
        } finally {
            plugin.dispose();
        }
    });
}

test("installed where there are no timers, the last stop gives the stream back at once, and the next subscribe opens another", async () => {
    await withoutTimers(async ({ juris, sources, doc }) => {
        const stop = juris.live("a", "rows");
        sources.last.hello("c1");
        stop();
        assert.ok(sources.last.closed, "closed at once, with no timer to wait on");
        juris.live("b", "rows");
        assert.equal(sources.opened.length, 2);
        assert.equal(juris.api.liveState("b"), "pending");
        sources.last.hello("c2");
        doc.show("hidden");
        await flush();
        assert.equal(sources.last.closed, false, "no timer, so no hidden pause");
    });
});

test("installed where there are no timers, a stream the browser gave up on is dropped, so a tab shown again opens a new one", async () => {
    await withoutTimers(async ({ juris, sources, doc }) => {
        juris.live("a", "rows");
        sources.last.hello("c1");
        sources.last.fail(2);
        assert.equal(juris.api.liveState("a"), "offline");
        doc.show("hidden");
        doc.show("visible");
        assert.equal(sources.opened.length, 2, "the tab shown again opens a new stream");
    });
});

// ---- dispose -----------------------------------------------------------------------------------

test("dispose() closes the stream, cancels every timer, removes every status and the listener, and takes the transport off", async (t) => {
    const doc = visibilityDocument("visible");
    const answer = (body) => (body.subscribe?.name === "busy" ? refusal(429) : {});
    const called = [];
    const services = { rows: async () => { called.push("rows"); return ["by call"]; } };
    await withLive(t, { document: doc, answer, services, options: { hiddenMs: 300 } }, async ({ juris, plugin, sources, endpoint, transport, tick }) => {
        juris.live("a", "rows", 1);
        juris.live("b", "busy");
        sources.last.hello("c1");
        await flush();                          // the busy one waits on a retry
        doc.show("hidden");                     // and the hidden pause on its timer
        assert.equal(doc.listeners.size, 1);
        const requests = endpoint.requests.length;
        plugin.dispose();
        assert.ok(sources.last.closed);
        assert.equal(juris.api.liveStatus(), false);
        assert.deepEqual(juris.peek("$live.paths"), {}, "the statuses were the client's to keep");
        assert.equal(juris.api.liveState("a"), null);
        assert.equal(doc.listeners.size, 0, "the visibilitychange listener is removed");
        assert.equal(juris.liveTransport, null);
        assert.deepEqual(transport.keys, []);
        tick(100_000);
        await flush();
        assert.equal(endpoint.requests.length, requests, "no retry went out");
        assert.equal(sources.opened.length, 1, "nothing reopened");
        juris.live("c", "rows");
        await flush();
        assert.deepEqual(called, ["rows"], "api.live is a call again, as on a server");
        assert.deepEqual(raw(juris, "c"), ["by call"]);
    });
});

test("dispose() cancels a reopen's wait", async (t) => {
    await withLive(t, {}, async ({ juris, plugin, sources, tick }) => {
        juris.live("a", "rows");
        sources.last.hello("c1");
        sources.last.fail(2);
        plugin.dispose();
        tick(10_000);
        assert.equal(sources.opened.length, 1);
    });
});

test("dispose() closes a stream waiting on its idle close at once", async (t) => {
    await withLive(t, {}, async ({ juris, plugin, sources }) => {
        const stop = juris.live("a", "rows");
        sources.last.hello("c1");
        stop();
        assert.equal(sources.last.closed, false);
        plugin.dispose();
        assert.ok(sources.last.closed);
    });
});

test("after dispose() the old transport subscribes nothing, and a stop made before posts nothing", async (t) => {
    await withLive(t, {}, async ({ juris, plugin, sources, endpoint, transport }) => {
        const stop = juris.live("a", "rows");
        sources.last.hello("c1");
        await flush();
        plugin.dispose();
        const requests = endpoint.requests.length;
        stop();
        const late = transport.subscribe(liveKey("x", []), "x", [], "x");
        assert.equal(typeof late, "function");
        assert.doesNotThrow(late);
        await flush();
        assert.equal(endpoint.requests.length, requests);
        assert.equal(sources.opened.length, 1);
        assert.equal(juris.peek("$live.paths.x"), undefined);
    });
});

test("a request queued behind one in flight is not sent once disposed", async (t) => {
    const held = deferred();
    await withLive(t, { answer: (body) => (body.subscribe ? held.promise : {}) }, async ({ juris, plugin, sources, endpoint }) => {
        const stop = juris.live("a", "rows");
        sources.last.hello("c1");
        await flush();
        stop();                                 // its unsubscribe waits for the subscribe's answer
        plugin.dispose();
        held.resolve({});
        await flush();
        assert.equal(endpoint.unsubscribes().length, 0);
    });
});

test("after dispose() a document that cannot remove its listener wakes nothing", async (t) => {
    const doc = visibilityDocument("visible", { removable: false });
    await withLive(t, { document: doc }, async ({ juris, plugin, sources }) => {
        juris.live("a", "rows");
        sources.last.hello("c1");
        sources.last.fail(2);
        plugin.dispose();
        doc.show("visible");
        assert.equal(sources.opened.length, 1);
    });
});
