// remote-services.js, the live client (sseClient), part one: the options it refuses, how it installs
// on an instance (one at a time), the stream and its hello, what it posts to /_live and in what
// order, how each patch is written, and each live path's status. Refusals, a lost stream, the idle
// close, a hidden tab and dispose() are in remote-services.sse-recovery.test.mjs. Every stream is a
// stand-in EventSource and every request a stand-in fetch (tests/support/remote-services-fakes.mjs).
// Held to REFERENCE.md ("remote-services.js", "Reserved state roots": $live).
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import { sseClient } from "juris/remote-services.js";
import { liveKey } from "juris/live-protocol.js";
import { pathSegment } from "juris/state-manager.js";
import { withGlobals, quiet, flush, deferred, eventSources, liveEndpoint } from "../support/remote-services-fakes.mjs";

const MAX = 2 ** 31 - 1;

// An instance with a live client, its streams and its /_live endpoint. Disposed when `fn` ends.
async function withLive({ options = {}, answer, juris: jurisOptions = {} } = {}, fn) {
    const sources = eventSources();
    const endpoint = liveEndpoint(answer);
    return withGlobals({ fetch: endpoint.fetch }, async () => {
        const juris = new Juris({ isServer: false, ...jurisOptions });
        const plugin = sseClient({ EventSourceImpl: sources.FakeEventSource, ...options });
        juris.use(plugin);
        try {
            await fn({ juris, plugin, sources, endpoint, transport: juris.liveTransport });
        } finally {
            plugin.dispose();
        }
    });
}

const raw = (juris, path) => juris.toRaw(juris.peek(path));

// ---- construction ------------------------------------------------------------------------------

test("sseClient refuses options that are not an object", () => {
    for (const options of [null, [], "base", 1, true]) {
        assert.throws(() => sseClient(options), (error) => error instanceof TypeError && error.message === "sseClient: options is an object", String(options));
    }
});

test("sseClient refuses a key that is none of its options, naming them all", () => {
    assert.throws(() => sseClient({ idleMS: 0 }), (error) => error instanceof TypeError
        && error.message === 'sseClient: "idleMS" is not an option (base, EventSourceImpl, idleMs, hiddenMs, statePath, onHello, onReconnect, onError, backoff)');
});

test("sseClient refuses a key in backoff other than minMs and maxMs", () => {
    assert.throws(() => sseClient({ backoff: { minMs: 5, max: 10 } }), (error) => error instanceof TypeError && error.message === "sseClient: backoff.max is not an option (minMs, maxMs)");
});

test("sseClient refuses a backoff whose bounds are not whole milliseconds with 1 <= minMs <= maxMs <= 2^31 - 1", () => {
    const wrong = [null, 5, "fast", { minMs: 0 }, { minMs: 1.5 }, { minMs: "5" }, { minMs: 10, maxMs: 5 }, { maxMs: 500 }, { minMs: 1, maxMs: MAX + 1 }, { minMs: NaN }];
    for (const backoff of wrong) {
        assert.throws(() => sseClient({ backoff }), (error) => error instanceof TypeError
            && error.message.startsWith(`sseClient: backoff is { minMs, maxMs }, whole milliseconds with 1 <= minMs <= maxMs <= ${MAX}, not `), JSON.stringify(backoff));
    }
    for (const backoff of [{}, { minMs: 1, maxMs: 1 }, { minMs: 1, maxMs: MAX }, { minMs: 5 }, { maxMs: 1000 }]) {
        assert.doesNotThrow(() => sseClient({ backoff }), JSON.stringify(backoff));
    }
});

test("sseClient refuses an idleMs that is not a whole number of milliseconds from 0 to 2^31 - 1", () => {
    for (const [idleMs, shown] of [[-1, "-1"], [1.5, "1.5"], ["10", '"10"'], [NaN, "NaN"], [MAX + 1, String(MAX + 1)], [null, "null"]]) {
        assert.throws(() => sseClient({ idleMs }), (error) => error instanceof TypeError
            && error.message === `sseClient: idleMs is a whole number of milliseconds from 0 to ${MAX}, not ${shown}`, String(idleMs));
    }
    for (const idleMs of [0, MAX]) assert.doesNotThrow(() => sseClient({ idleMs }));
});

test("sseClient refuses a hiddenMs other than null that is not a whole number of milliseconds from 0 to 2^31 - 1", () => {
    for (const [hiddenMs, shown] of [[-1, "-1"], ["60000", '"60000"'], [0.5, "0.5"], [MAX + 1, String(MAX + 1)], [false, "false"]]) {
        assert.throws(() => sseClient({ hiddenMs }), (error) => error instanceof TypeError
            && error.message === `sseClient: hiddenMs is null or a whole number of milliseconds from 0 to ${MAX}, not ${shown}`, String(hiddenMs));
    }
    for (const hiddenMs of [null, undefined, 0, MAX]) assert.doesNotThrow(() => sseClient({ hiddenMs }));
});

test("sseClient refuses an empty statePath, or one that is not a string", () => {
    for (const statePath of ["", 5, null]) {
        assert.throws(() => sseClient({ statePath }), (error) => error instanceof TypeError
            && error.message === `sseClient: statePath is a state path, such as "$live", not ${JSON.stringify(statePath)}`);
    }
});

test("sseClient refuses a hook that is not a function", () => {
    for (const name of ["onHello", "onReconnect", "onError"]) {
        assert.throws(() => sseClient({ [name]: "log" }), (error) => error instanceof TypeError && error.message === `sseClient: ${name} is a function`);
    }
});

test("sseClient answers a plugin with dispose(), and installs nothing until juris.use", () => {
    const sources = eventSources();
    const plugin = sseClient({ EventSourceImpl: sources.FakeEventSource });
    assert.equal(typeof plugin, "function");
    assert.equal(typeof plugin.dispose, "function");
    assert.equal(sources.opened.length, 0);
    assert.doesNotThrow(() => plugin.dispose(), "nothing to dispose yet");
});

// ---- installing --------------------------------------------------------------------------------

test("installing adds juris.liveTransport and api.liveStatus, false until a hello, and opens no stream", async () => {
    await withLive({}, async ({ juris, sources, transport }) => {
        assert.equal(typeof transport.subscribe, "function");
        assert.equal(juris.api.liveStatus(), false);
        assert.equal(sources.opened.length, 0, "nothing is watched yet");
        assert.equal(transport.clientId, null);
        assert.deepEqual(transport.keys, []);
    });
});

test("a second live client on an instance with one live is refused, and installs nothing", async () => {
    await withLive({}, async ({ juris, transport }) => {
        const other = eventSources();
        const api = juris.api;
        assert.throws(() => juris.use(sseClient({ EventSourceImpl: other.FakeEventSource })), (error) => error instanceof Error
            && error.message === "sseClient: this Juris instance has a live client already; dispose() it before installing another");
        assert.equal(juris.liveTransport, transport, "the first one's transport stays");
        assert.equal(juris.api, api);
        juris.live("rows", "rows");
        assert.equal(other.opened.length, 0, "the refused one opens nothing");
    });
});

test("a live client on an api whose liveStatus is no live client's is refused, and installs nothing", () => {
    const juris = new Juris({ isServer: false });
    juris.use(() => ({ liveStatus: () => "mine" }));
    assert.throws(() => juris.use(sseClient({ EventSourceImpl: eventSources().FakeEventSource })), (error) => error instanceof Error
        && error.message === 'sseClient: the api already has a "liveStatus" that is no live client\'s');
    assert.equal(juris.liveTransport ?? null, null);
    assert.equal(juris.api.liveStatus(), "mine");
});

test("once a live client is disposed another may be installed, and liveStatus reads where the new one writes", async () => {
    const sources = eventSources();
    await withGlobals({ fetch: liveEndpoint().fetch }, async () => {
        const juris = new Juris({ isServer: false });
        const first = sseClient({ EventSourceImpl: sources.FakeEventSource, statePath: "$a" });
        juris.use(first);
        const liveStatus = juris.api.liveStatus;
        first.dispose();
        assert.equal(juris.liveTransport, null, "taken off the instance");
        const second = sseClient({ EventSourceImpl: sources.FakeEventSource, statePath: "$b" });
        juris.use(second);
        try {
            assert.equal(juris.api.liveStatus, liveStatus, "the api keeps the first client's liveStatus");
            juris.live("rows", "rows");
            sources.last.hello("c1");
            assert.equal(juris.peek("$b.connected"), true);
            assert.equal(juris.peek("$a.connected"), false);
            assert.equal(juris.api.liveStatus(), true, "and it reads the second client's connection");
        } finally {
            second.dispose();
        }
    });
});

test("one plugin installed on two instances serves each, and dispose() takes it off both", async () => {
    const sources = eventSources();
    await withGlobals({ fetch: liveEndpoint().fetch }, async () => {
        const plugin = sseClient({ EventSourceImpl: sources.FakeEventSource });
        const one = new Juris({ isServer: false });
        const two = new Juris({ isServer: false });
        one.use(plugin);
        two.use(plugin);
        assert.notEqual(one.liveTransport, two.liveTransport);
        one.live("a", "rows");
        two.live("b", "rows");
        assert.equal(sources.opened.length, 2, "a stream per instance");
        plugin.dispose();
        assert.equal(one.liveTransport, null);
        assert.equal(two.liveTransport, null);
        assert.ok(sources.opened.every((stream) => stream.closed));
        assert.doesNotThrow(() => plugin.dispose(), "a second dispose does nothing");
    });
});

test("without EventSourceImpl the browser's own EventSource is used", async () => {
    const sources = eventSources();
    await withGlobals({ EventSource: sources.FakeEventSource, fetch: liveEndpoint().fetch }, async () => {
        const juris = new Juris({ isServer: false });
        const plugin = sseClient();
        juris.use(plugin);
        try {
            juris.live("rows", "rows");
            assert.equal(sources.opened.length, 1);
            assert.equal(sources.last.url, "/api/events");
        } finally {
            plugin.dispose();
        }
    });
});

test("with no EventSource anywhere a subscribe opens nothing, and its path waits as pending", async () => {
    await withGlobals({ EventSource: undefined, fetch: liveEndpoint().fetch }, async () => {
        const juris = new Juris({ isServer: false });
        const plugin = sseClient();
        juris.use(plugin);
        try {
            assert.doesNotThrow(() => juris.live("rows", "rows"));
            assert.equal(juris.api.liveState("rows"), "pending");
            assert.equal(juris.api.liveStatus(), false);
        } finally {
            plugin.dispose();
        }
    });
});

// ---- the stream and its hello ------------------------------------------------------------------

test("a subscribe opens the stream at <base>/events and posts nothing before the server's hello names the client", async () => {
    await withLive({ options: { base: "/svc" } }, async ({ juris, sources, endpoint, transport }) => {
        juris.live("rows.list", "rows", 1);
        assert.equal(sources.opened.length, 1);
        assert.equal(sources.last.url, "/svc/events", "no client id chosen in the URL");
        await flush();
        assert.equal(endpoint.requests.length, 0);
        sources.last.hello("c1");
        await flush();
        assert.equal(transport.clientId, "c1");
        assert.equal(endpoint.requests.length, 1);
        const [{ url, init, body }] = endpoint.requests;
        assert.equal(url, "/svc/_live");
        assert.equal(init.method, "POST");
        assert.deepEqual(init.headers, { "content-type": "application/json" });
        assert.deepEqual(body, { client: "c1", subscribe: { key: liveKey("rows", [1]), name: "rows", args: [1] } });
    });
});

test("a subscribe after the hello is posted at once, and every subscription shares the one stream", async () => {
    await withLive({}, async ({ juris, sources, endpoint, transport }) => {
        juris.live("a", "rows", 1);
        sources.last.hello("c1");
        juris.live("b", "rows", 2);
        juris.live("c", "other");
        await flush();
        assert.equal(sources.opened.length, 1);
        assert.deepEqual(endpoint.subscribes().map((body) => body.subscribe.key), [liveKey("rows", [1]), liveKey("rows", [2]), liveKey("other", [])]);
        assert.deepEqual(transport.keys, [liveKey("rows", [1]), liveKey("rows", [2]), liveKey("other", [])]);
    });
});

test("a key subscribed at two paths is announced once", async () => {
    await withLive({}, async ({ juris, sources, endpoint }) => {
        juris.live("left", "rows", 1);
        juris.live("right", "rows", 1);
        sources.last.hello("c1");
        await flush();
        assert.equal(endpoint.subscribes().length, 1);
    });
});

test("each hello marks the stream connected and counts one more generation, from what the state holds", async () => {
    await withLive({}, async ({ juris, sources }) => {
        juris.live("rows", "rows");
        assert.equal(juris.peek("$live.generation"), undefined, "absent before the first");
        sources.last.hello("c1");
        assert.equal(juris.peek("$live.connected"), true);
        assert.equal(juris.api.liveStatus(), true);
        assert.equal(juris.peek("$live.generation"), 1);
        assert.equal(juris.peek("$live.reconnects"), undefined, "a first open is no reconnect");
        juris.setValue("$live.generation", 41);
        sources.last.hello("c2");
        assert.equal(juris.peek("$live.generation"), 42);
    });
});

test("the generation keeps rising across a dispose and a second install, whose own first hello is no reconnect for it", async () => {
    const sources = eventSources();
    const heard = [];
    await withGlobals({ fetch: liveEndpoint().fetch }, async () => {
        const juris = new Juris({ isServer: false });
        const first = sseClient({ EventSourceImpl: sources.FakeEventSource });
        juris.use(first);
        juris.live("rows", "rows");
        sources.last.hello("c1");
        first.dispose();
        assert.equal(juris.api.liveStatus(), false);
        const second = sseClient({ EventSourceImpl: sources.FakeEventSource, onReconnect: (info) => heard.push(info) });
        juris.use(second);
        try {
            juris.live("rows", "rows");
            sources.last.hello("c2");
            assert.equal(juris.peek("$live.generation"), 2, "one more than the state says");
            assert.deepEqual(heard, [], "the second install's first hello");
        } finally {
            second.dispose();
        }
    });
});

test("the connection is written under statePath", async () => {
    await withLive({ options: { statePath: "conn" } }, async ({ juris, sources, transport }) => {
        juris.live("rows.list", "rows");
        sources.last.hello("c1");
        assert.equal(juris.peek("conn.connected"), true);
        assert.equal(juris.peek("conn.generation"), 1);
        assert.equal(juris.peek("$live"), undefined);
        assert.equal(transport.statusAt("rows.list"), `conn.paths.${pathSegment("rows.list")}`);
        assert.equal(juris.peek(`conn.paths.${pathSegment("rows.list")}.status`), "pending");
    });
});

test("a hello that names no client, or is not JSON, leaves the stream unconnected and announces nothing", async () => {
    const hellos = [];
    await withLive({ options: { onHello: (info) => hellos.push(info) } }, async ({ juris, sources, endpoint }) => {
        juris.live("rows", "rows");
        sources.last.emit("hello", "not json");
        sources.last.emit("hello", {});
        sources.last.emit("hello", { client: "" });
        await flush();
        assert.equal(juris.api.liveStatus(), false);
        assert.equal(juris.peek("$live.generation"), undefined);
        assert.equal(endpoint.requests.length, 0);
        assert.deepEqual(hellos, []);
    });
});

test("onHello hears of every hello and onReconnect of every one after the install's first", async () => {
    const heard = [];
    const options = { onHello: (info) => heard.push(["hello", info]), onReconnect: (info) => heard.push(["reconnect", info]) };
    await withLive({ options }, async ({ juris, sources }) => {
        juris.live("rows", "rows");
        sources.last.hello("c1");
        sources.last.fail(0);
        sources.last.hello("c2");
        assert.deepEqual(heard, [
            ["hello", { clientId: "c1", generation: 1 }],
            ["hello", { clientId: "c2", generation: 2 }],
            ["reconnect", { clientId: "c2", generation: 2 }],
        ]);
    });
});

test("a hook that throws or rejects is told to the console and stops nothing", async () => {
    const reached = [];
    const options = {
        onHello: () => { throw new Error("hello hook broke"); },
        onReconnect: async () => { reached.push("reconnect"); throw new Error("reconnect hook broke"); },
    };
    await withLive({ options }, async ({ juris, sources, endpoint }) => {
        juris.live("rows", "rows");
        const said = await quiet("error", async () => {
            sources.last.hello("c1");
            sources.last.hello("c2");
            await flush();
        });
        assert.deepEqual(said.map(([words, error]) => [words, error.message]), [
            ["Juris live: onHello failed", "hello hook broke"],
            ["Juris live: onHello failed", "hello hook broke"],
            ["Juris live: onReconnect failed", "reconnect hook broke"],
        ]);
        assert.deepEqual(reached, ["reconnect"]);
        assert.equal(endpoint.subscribes().length, 2, "each hello still announced the subscription");
        assert.equal(juris.api.liveStatus(), true);
    });
});

// ---- statuses ----------------------------------------------------------------------------------

test("a live path is pending from its subscribe until its first full answer, then live", async () => {
    await withLive({}, async ({ juris, sources }) => {
        juris.live("rows.list", "rows", 1);
        assert.equal(juris.api.liveState("rows.list"), "pending");
        sources.last.hello("c1");
        await flush();
        assert.equal(juris.api.liveState("rows.list"), "pending");
        sources.last.patch({ key: liveKey("rows", [1]), full: [{ id: 1 }] });
        assert.equal(juris.api.liveState("rows.list"), "live");
        assert.equal(juris.api.liveMessage("rows.list"), null);
        assert.deepEqual(raw(juris, "rows.list"), [{ id: 1 }]);
    });
});

test("a path whose preloaded answer is on screen starts live, and a preload that failed starts pending", async () => {
    await withLive({ juris: { services: { rows: async () => [] } } }, async ({ juris, transport }) => {
        juris.setValue("$ssr", { calls: { [liveKey("rows", [1])]: [{ id: 1 }], [liveKey("rows", [2])]: { $error: "request failed" } } });
        juris.live("good", "rows", 1);
        juris.live("bad", "rows", 2);
        assert.equal(juris.api.liveState("good"), "live");
        assert.deepEqual(raw(juris, "good"), [{ id: 1 }], "the preload's answer, assigned at once");
        assert.equal(juris.api.liveState("bad"), "pending");
        transport.subscribe("k", "rows", [3], "direct", { seeded: true });
        assert.equal(juris.api.liveState("direct"), "live");
    });
});

test("each path's status is kept under statePath.paths as one escaped segment", async () => {
    await withLive({}, async ({ juris, transport }) => {
        juris.live("rows.list", "rows");
        juris.live("a*b%c", "other");
        assert.equal(transport.statusAt("rows.list"), `$live.paths.${pathSegment("rows.list")}`);
        const paths = juris.peek("$live.paths");
        assert.deepEqual(Object.keys(paths).sort(), [pathSegment("rows.list"), pathSegment("a*b%c")].sort());
        for (const key of Object.keys(paths)) assert.doesNotMatch(key, /[.*]/);
        assert.equal(juris.api.liveState("a*b%c"), "pending");
    });
});

test("a path's status goes once nothing is subscribed there", async () => {
    await withLive({}, async ({ juris, sources }) => {
        const seen = [];
        juris.bindState(() => juris.api.liveState("rows.list"), (value) => seen.push(value));
        const stop = juris.live("rows.list", "rows", 1);
        sources.last.hello("c1");
        await flush();
        sources.last.patch({ key: liveKey("rows", [1]), full: [] });
        stop();
        assert.deepEqual(seen, [null, "pending", "live", null]);
        assert.deepEqual(juris.peek("$live.paths"), {});
    });
});

test("a reader of a path's status is not woken by its message alone", async () => {
    await withLive({}, async ({ juris, sources }) => {
        const key = liveKey("rows", [1]);
        juris.live("rows.list", "rows", 1);
        sources.last.hello("c1");
        await flush();
        const statuses = [];
        const messages = [];
        juris.bindState(() => juris.api.liveState("rows.list"), (value) => statuses.push(value));
        juris.bindState(() => juris.api.liveMessage("rows.list"), (value) => messages.push(value));
        await quiet("error", () => {
            sources.last.patch({ key, error: "first failure" });
            sources.last.patch({ key, error: "second failure" });
        });
        assert.deepEqual(statuses, ["pending", "failed"]);
        assert.deepEqual(messages, [null, "first failure", "second failure"]);
    });
});

test("two subscribers at one path share its status until the last one stops, and a stop counts once", async () => {
    await withLive({}, async ({ juris, sources, endpoint }) => {
        const key = liveKey("rows", [1]);
        const first = juris.live("rows.list", "rows", 1);
        juris.live("rows.list", "rows", 1);
        sources.last.hello("c1");
        await flush();
        first();
        first();
        await flush();
        assert.equal(juris.api.liveState("rows.list"), "pending", "the second subscriber still holds it");
        assert.equal(endpoint.unsubscribes().length, 0);
        sources.last.patch({ key, full: [1] });
        assert.deepEqual(raw(juris, "rows.list"), [1], "and still hears its patches");
        assert.equal(juris.api.liveState("rows.list"), "live");
    });
});

test("the last stop of a key posts its unsubscribe", async () => {
    await withLive({}, async ({ juris, sources, endpoint, transport }) => {
        const key = liveKey("rows", [1]);
        const left = juris.live("left", "rows", 1);
        const right = juris.live("right", "rows", 1);
        sources.last.hello("c1");
        await flush();
        left();
        await flush();
        assert.equal(endpoint.unsubscribes().length, 0, "the key is still watched at another path");
        sources.last.patch({ key, full: ["r"] });
        assert.deepEqual(raw(juris, "right"), ["r"]);
        right();
        await flush();
        assert.deepEqual(endpoint.unsubscribes(), [{ client: "c1", unsubscribe: key }]);
        assert.deepEqual(transport.keys, []);
    });
});

test("a path whose arguments moved belongs to the new key: the old key's stop, late patch and refusal leave it alone", async () => {
    const held = deferred();
    const answer = (body) => (body.subscribe?.args[0] === 1 ? held.promise : {});
    await withLive({ answer }, async ({ juris, sources }) => {
        const oldKey = liveKey("rows", [1]);
        const newKey = liveKey("rows", [2]);
        const stopOld = juris.live("rows.list", "rows", 1);
        sources.last.hello("c1");
        await flush();
        juris.live("rows.list", "rows", 2);   // the new subscription first, as useLiveData makes it
        await flush();
        held.resolve({ status: 403, body: { error: "Not yours.", code: "live.forbidden" } });
        const said = await quiet("error", () => flush());
        assert.equal(said.length, 1, "the refusal of the old arguments is still heard");
        assert.equal(juris.api.liveState("rows.list"), "pending", "but it does not mark the path the new key owns");
        stopOld();
        assert.equal(juris.api.liveState("rows.list"), "pending", "the old key's stop leaves the new key's status");
        sources.last.patch({ key: oldKey, full: ["old"] });
        assert.equal(juris.peek("rows.list"), undefined, "a late patch for the old key is dropped");
        sources.last.patch({ key: newKey, full: ["new"] });
        assert.equal(juris.api.liveState("rows.list"), "live");
        assert.deepEqual(raw(juris, "rows.list"), ["new"]);
    });
});

// ---- the order of requests ---------------------------------------------------------------------

test("a key's subscribe and unsubscribe reach the server in the order they were made, each after the last was answered", async () => {
    const held = [];
    const answer = () => { const d = deferred(); held.push(d); return d.promise; };
    await withLive({ answer }, async ({ juris, sources, endpoint }) => {
        const key = liveKey("rows", [1]);
        const stop = juris.live("rows.list", "rows", 1);
        sources.last.hello("c1");
        await flush();
        stop();                                  // the view goes...
        juris.live("rows.list", "rows", 1);      // ...and is made again on the same stream
        await flush();
        assert.deepEqual(endpoint.bodies(), [{ client: "c1", subscribe: { key, name: "rows", args: [1] } }], "nothing sent beside the one in flight");
        held[0].resolve({});
        await flush();
        assert.equal(endpoint.requests.length, 2);
        assert.deepEqual(endpoint.bodies()[1], { client: "c1", unsubscribe: key });
        held[1].resolve({});
        await flush();
        assert.equal(endpoint.requests.length, 3);
        assert.deepEqual(endpoint.bodies()[2], { client: "c1", subscribe: { key, name: "rows", args: [1] } });
        held[2].resolve({});
        await flush();
    });
});

test("requests for different keys do not wait for each other", async () => {
    const held = deferred();
    await withLive({ answer: (body) => (body.subscribe?.name === "slow" ? held.promise : {}) }, async ({ juris, sources, endpoint }) => {
        juris.live("a", "slow");
        sources.last.hello("c1");
        juris.live("b", "fast");
        await flush();
        assert.deepEqual(endpoint.subscribes().map((body) => body.subscribe.name), ["slow", "fast"]);
        held.resolve({});
        await flush();
    });
});

// ---- patches -----------------------------------------------------------------------------------

test("a full answer is written at every path its key is subscribed at", async () => {
    await withLive({}, async ({ juris, sources }) => {
        juris.live("left", "rows", 1);
        juris.live("right.side", "rows", 1);
        sources.last.hello("c1");
        sources.last.patch({ key: liveKey("rows", [1]), full: { total: 2, rows: [1, 2] } });
        assert.deepEqual(raw(juris, "left"), { total: 2, rows: [1, 2] });
        assert.deepEqual(raw(juris, "right.side"), { total: 2, rows: [1, 2] });
        assert.equal(juris.api.liveState("left"), "live");
        assert.equal(juris.api.liveState("right.side"), "live");
    });
});

test("a change sets each leaf under the path, deletes each removed one, and replaces the whole at the path \"\"", async () => {
    await withLive({}, async ({ juris, sources }) => {
        const key = liveKey("rows", [1]);
        juris.live("page", "rows", 1);
        sources.last.hello("c1");
        sources.last.patch({ key, full: { a: { b: 1, c: 2 }, d: 3 } });
        sources.last.patch({ key, set: [["a.b", 9]], del: ["a.c", "d"] });
        assert.deepEqual(raw(juris, "page"), { a: { b: 9 } });
        sources.last.patch({ key, set: [["", { fresh: true }]] });
        assert.deepEqual(raw(juris, "page"), { fresh: true });
        sources.last.patch({ key, del: [""] });
        assert.equal(juris.peek("page"), undefined, "a delete at \"\" removes the path itself");
    });
});

test("a change follows the diff the server computes", async () => {
    const { diff } = await import("juris/live-protocol.js");
    await withLive({}, async ({ juris, sources }) => {
        const key = liveKey("rows", [1]);
        const before = { list: [{ id: 1, name: "a" }, { id: 2, name: "b" }], meta: { "x.y": 1 }, gone: true };
        const after = { list: [{ id: 2, name: "b" }, { id: 1, name: "a" }], meta: { "x.y": 2 }, added: [1] };
        juris.live("result", "rows", 1);
        sources.last.hello("c1");
        sources.last.patch({ key, full: before });
        sources.last.patch({ key, ...diff(before, after) });
        assert.deepEqual(raw(juris, "result"), after);
    });
});

test("a change to a path still waiting for its first answer leaves it pending", async () => {
    await withLive({}, async ({ juris, sources }) => {
        const key = liveKey("rows", [1]);
        juris.live("rows.list", "rows", 1);
        sources.last.hello("c1");
        sources.last.patch({ key, set: [["0", "x"]] });
        assert.equal(juris.api.liveState("rows.list"), "pending");
        sources.last.patch({ key, full: ["y"] });
        sources.last.patch({ key, set: [["0", "z"]] });
        assert.equal(juris.api.liveState("rows.list"), "live");
        assert.deepEqual(raw(juris, "rows.list"), ["z"]);
    });
});

test("a re-run the server could not make marks the path failed with its words, and the next answer makes it live", async () => {
    await withLive({}, async ({ juris, sources }) => {
        const key = liveKey("rows", [1]);
        juris.live("rows.list", "rows", 1);
        sources.last.hello("c1");
        sources.last.patch({ key, full: [{ id: 1 }] });
        const said = await quiet("error", () => sources.last.patch({ key, error: "request failed" }));
        assert.equal(juris.api.liveState("rows.list"), "failed");
        assert.equal(juris.api.liveMessage("rows.list"), "request failed");
        assert.deepEqual(raw(juris, "rows.list"), [{ id: 1 }], "the last answer stays on screen");
        assert.deepEqual(said, [['Juris live query "rows" failed on the server:', "request failed"]]);
        sources.last.patch({ key, set: [["0.id", 2]] });
        assert.equal(juris.api.liveState("rows.list"), "live", "a change to the answer it had is current again");
        assert.equal(juris.api.liveMessage("rows.list"), null);
    });
});

test("a failed re-run's error is read for its message, or written as text", async () => {
    await withLive({}, async ({ juris, sources }) => {
        const key = liveKey("rows", []);
        juris.live("rows", "rows");
        sources.last.hello("c1");
        await quiet("error", () => {
            sources.last.patch({ key, error: { message: "timeout" } });
            assert.equal(juris.api.liveMessage("rows"), "timeout");
            sources.last.patch({ key, error: 503 });
            assert.equal(juris.api.liveMessage("rows"), "503");
            sources.last.patch({ key, error: null });
            assert.equal(juris.api.liveMessage("rows"), "null");
        });
        assert.equal(juris.api.liveState("rows"), "failed");
    });
});

test("a patch for a key nothing is subscribed to is dropped", async () => {
    await withLive({}, async ({ juris, sources }) => {
        juris.live("rows.list", "rows", 1);
        sources.last.hello("c1");
        const said = await quiet("error", () => {
            sources.last.patch({ key: liveKey("rows", [99]), full: ["stranger"] });
            sources.last.patch({ key: liveKey("rows", [99]), error: "x" });
        });
        assert.equal(juris.peek("rows.list"), undefined);
        assert.equal(juris.api.liveState("rows.list"), "pending");
        assert.deepEqual(said, []);
    });
});

test("a pushed answer keeps a TTL call cache entry truthful", async () => {
    let ran = 0;
    const jurisOptions = { callCache: { ttl: 60_000 }, services: { rows: async (n) => { ran += 1; return [`ran ${n}`]; } } };
    await withLive({ juris: jurisOptions }, async ({ juris, sources }) => {
        assert.deepEqual(await juris.call("rows", 1), ["ran 1"]);
        juris.live("rows.list", "rows", 1);
        sources.last.hello("c1");
        sources.last.patch({ key: liveKey("rows", [1]), full: ["pushed"] });
        assert.deepEqual(juris.toRaw(await juris.call("rows", 1)), ["pushed"]);
        sources.last.patch({ key: liveKey("rows", [1]), set: [["0", "changed"]] });
        assert.deepEqual(juris.toRaw(await juris.call("rows", 1)), ["changed"]);
        assert.equal(ran, 1, "answered from the cache the push keeps");
    });
});

// ---- a path joining a query that has answered ----------------------------------------------------

test("a path that joins a query already answered takes its answer at once, and is live", async () => {
    await withLive({}, async ({ juris, sources, endpoint }) => {
        juris.live("left", "rows", 1);
        sources.last.hello("c1");
        await flush();
        sources.last.patch({ key: liveKey("rows", [1]), full: { id: 1, qty: 2 } });

        juris.live("right", "rows", 1);

        assert.equal(juris.api.liveState("right"), "live");
        assert.deepEqual(raw(juris, "right"), { id: 1, qty: 2 });
        await flush();
        assert.equal(endpoint.subscribes().length, 1, "no new subscribe: the answer was already here");
    });
});

test("a joined path holds the whole answer after a change, not the changed field alone", async () => {
    await withLive({}, async ({ juris, sources }) => {
        juris.live("left", "rows", 1);
        sources.last.hello("c1");
        await flush();
        sources.last.patch({ key: liveKey("rows", [1]), full: { id: 1, qty: 2 } });
        juris.live("right", "rows", 1);

        sources.last.patch({ key: liveKey("rows", [1]), set: [["qty", 3]] });

        assert.deepEqual(raw(juris, "left"), { id: 1, qty: 3 });
        assert.deepEqual(raw(juris, "right"), { id: 1, qty: 3 });
    });
});

test("a joined path is a copy: a write at one path does not reach the other", async () => {
    await withLive({}, async ({ juris, sources }) => {
        juris.live("left", "rows", 1);
        sources.last.hello("c1");
        await flush();
        sources.last.patch({ key: liveKey("rows", [1]), full: { id: 1, tags: ["a"] } });
        juris.live("right", "rows", 1);

        assert.notEqual(raw(juris, "left"), raw(juris, "right"));
        assert.notEqual(raw(juris, "left").tags, raw(juris, "right").tags);
    });
});

test("the same path subscribed again keeps the status it has", async () => {
    await withLive({}, async ({ juris, sources }) => {
        juris.live("rows.list", "rows", 1);
        sources.last.hello("c1");
        await flush();
        sources.last.patch({ key: liveKey("rows", [1]), full: [{ id: 1 }] });
        assert.equal(juris.api.liveState("rows.list"), "live");

        juris.live("rows.list", "rows", 1);

        assert.equal(juris.api.liveState("rows.list"), "live");
    });
});

test("a path that joins before the first answer waits with the others, and both get it", async () => {
    await withLive({}, async ({ juris, sources }) => {
        juris.live("left", "rows", 1);
        juris.live("right", "rows", 1);
        assert.equal(juris.api.liveState("right"), "pending");
        sources.last.hello("c1");
        await flush();

        sources.last.patch({ key: liveKey("rows", [1]), full: { id: 1 } });

        assert.equal(juris.api.liveState("left"), "live");
        assert.equal(juris.api.liveState("right"), "live");
        assert.deepEqual(raw(juris, "right"), { id: 1 });
    });
});

test("a path that joins a failed query takes its last answer, and is failed with its message", async () => {
    await withLive({}, async ({ juris, sources }) => {
        juris.live("left", "rows", 1);
        sources.last.hello("c1");
        await flush();
        sources.last.patch({ key: liveKey("rows", [1]), full: { id: 1 } });
        await quiet("error", async () => sources.last.patch({ key: liveKey("rows", [1]), error: "no database" }));

        juris.live("right", "rows", 1);

        assert.deepEqual(raw(juris, "right"), { id: 1 });
        assert.equal(juris.api.liveState("right"), "failed");
        assert.equal(juris.api.liveMessage("right"), "no database");
    });
});

test("a path that joins while the stream is down takes the last answer, and is offline", async () => {
    await withLive({}, async ({ juris, sources }) => {
        juris.live("left", "rows", 1);
        sources.last.hello("c1");
        await flush();
        sources.last.patch({ key: liveKey("rows", [1]), full: { id: 1 } });
        sources.last.fail();

        juris.live("right", "rows", 1);

        assert.deepEqual(raw(juris, "right"), { id: 1 });
        assert.equal(juris.api.liveState("right"), "offline");
    });
});

test("a path with a preloaded answer that joins an answered query keeps its own, and is live", async () => {
    await withLive({}, async ({ juris, sources, transport }) => {
        juris.live("left", "rows", 1);
        sources.last.hello("c1");
        await flush();
        sources.last.patch({ key: liveKey("rows", [1]), full: { id: 1, qty: 1 } });
        juris.setValue("right", { id: 1, qty: 9 });

        transport.subscribe(liveKey("rows", [1]), "rows", [1], "right", { seeded: true });

        assert.deepEqual(raw(juris, "right"), { id: 1, qty: 9 });
        assert.equal(juris.api.liveState("right"), "live");
    });
});

test("a path that joins a query whose paths were all taken over asks the server again", async () => {
    await withLive({}, async ({ juris, sources, endpoint }) => {
        juris.live("spot", "rows", 1);
        sources.last.hello("c1");
        await flush();
        sources.last.patch({ key: liveKey("rows", [1]), full: { id: 1 } });
        juris.live("spot", "other", 2);
        await flush();
        const before = endpoint.subscribes().length;

        juris.live("fresh", "rows", 1);
        await flush();

        assert.equal(endpoint.subscribes().length, before + 1);
        assert.equal(juris.api.liveState("fresh"), "pending");
        sources.last.patch({ key: liveKey("rows", [1]), full: { id: 1 } });
        assert.equal(juris.api.liveState("fresh"), "live");
    });
});
