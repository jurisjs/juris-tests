// juris.js, live calls (REFERENCE.md, "The component api" Services, "juris.js" Live status):
// api.live with and without a live client, and api.liveState / api.liveMessage, the tracked status
// of what is at a live path. The live client is stood in for by an object on juris.liveTransport,
// where sseClient (remote-services.js) installs its own: subscribe(key, name, args, path, options)
// and statusAt(path).
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import { ServiceError } from "juris/errors.js";
import { tick } from "../support/juris-harness.mjs";
import { withSSR } from "../support/ssr-renderer.mjs";

const server = (options = {}) => new Juris(withSSR({ isServer: true, ...options }));
const browser = (options = {}) => new Juris({ isServer: false, ...options });

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

// A live client: records each subscription and whether it is still on.
function fakeTransport({ withStatusAt = true } = {}) {
    const subscriptions = [];
    const transport = {
        subscriptions,
        subscribe(key, name, args, path, options) {
            const entry = { key, name, args, path, options, on: true };
            subscriptions.push(entry);
            return () => { entry.on = false; };
        },
    };
    if (withStatusAt) transport.statusAt = (path) => `$live.paths.${path.replace(/\./g, "%2E")}`;
    return transport;
}

// ---- without a live client ------------------------------------------------------------------------

test("without a live client, live() calls once: pending until the answer, then live with it assigned", async () => {
    const rows = deferred();
    const juris = browser({ services: { rows: () => rows.promise } });
    juris.live("list", "rows");
    assert.equal(juris.api.liveState("list"), "pending");
    assert.equal(juris.api.liveMessage("list"), null);
    rows.resolve([{ id: 1 }]);
    await tick();
    assert.deepEqual(juris.getState("list"), [{ id: 1 }]);
    assert.equal(juris.api.liveState("list"), "live");
});

test("a rejected live call is failed with its words, and a later good answer makes it live again", async () => {
    let fail = true;
    const juris = browser({ services: { rows: async () => { if (fail) throw new Error("down"); return [1]; } } });
    juris.live("list", "rows");
    await tick();
    assert.equal(juris.api.liveState("list"), "failed");
    assert.equal(juris.api.liveMessage("list"), "down");
    fail = false;
    juris.live("list", "rows");
    assert.equal(juris.api.liveMessage("list"), null, "the words go once the path is no longer failed");
    await tick();
    assert.equal(juris.api.liveState("list"), "live");
    assert.deepEqual(juris.getState("list"), [1]);
});

test("on a server a failed live call's words pass exposeError", async () => {
    const juris = server({ services: { driver: async () => { throw new Error("relation does not exist"); }, refusal: async () => { throw new ServiceError("Sign in."); } } });
    juris.clearState({});
    juris.live("a", "driver");
    juris.live("b", "refusal");
    await tick();
    assert.equal(juris.api.liveMessage("a"), "request failed");
    assert.equal(juris.api.liveMessage("b"), "Sign in.");
});

test("a service that answers synchronously is live at once", () => {
    const juris = browser({ services: { now: () => ({ t: 42 }) } });
    const states = [];
    juris.bindState(() => juris.api.liveState("clock"), (s) => states.push(s));
    juris.live("clock", "now");
    assert.deepEqual(juris.getState("clock"), { t: 42 });
    assert.deepEqual(states, [null, "live"], "never pending");
});

// A service that throws at once answers a settled rejection (api.call), so the path fails with its
// words, at once, where the throw used to go out of live() and leave the path saying nothing.
test("a service that throws synchronously fails the path at once, with its words", () => {
    const juris = browser({
        services: {
            now: () => {
                throw new ServiceError("The clock is down.");
            },
        },
    });
    const states = [];
    juris.bindState(() => juris.api.liveState("clock"), (s) => states.push(s));
    juris.live("clock", "now");
    assert.equal(juris.api.liveMessage("clock"), "The clock is down.");
    assert.deepEqual(states, [null, "failed"], "never pending");
});

test("liveState is tracked: a binding that reads it follows the status", async () => {
    const rows = deferred();
    const juris = browser({ services: { rows: () => rows.promise } });
    const states = [];
    juris.bindState(() => juris.api.liveState("list"), (s) => states.push(s));
    juris.live("list", "rows");
    rows.resolve([]);
    await tick();
    assert.deepEqual(states, [null, "pending", "live"]);
});

test("on a server a preloaded live path is live in the render, and its status never reaches the page", async () => {
    const juris = server({ services: { rows: async () => [{ id: 1 }] } });
    juris.registerComponent("Page", (props, api) => {
        api.live("rows.list", "rows");
        return { p: () => `${api.liveState("rows.list")}:${api.getState("rows.list").length}` };
    });
    const { html, json } = await juris.renderRequest({ preload: [["rows"]], layout: { Page: {} }, trace: true });
    assert.equal(html, "<p>live:1</p>");
    assert.doesNotMatch(json, /"status"/);
    assert.deepEqual(JSON.parse(json).rows, { list: [{ id: 1 }] });
    assert.deepEqual(juris.renderTrace().live, ["rows"]);
});

test("only the latest call at a path writes it: an older answer arriving late is dropped", async () => {
    const answers = { 1: deferred(), 2: deferred() };
    const juris = browser({ services: { rows: (page) => answers[page].promise } });
    juris.live("list", "rows", 1);
    juris.live("list", "rows", 2);
    answers[2].resolve(["page 2"]);
    await tick();
    answers[1].resolve(["page 1"]);
    await tick();
    assert.deepEqual(juris.getState("list"), ["page 2"]);
    assert.equal(juris.api.liveState("list"), "live");
});

test("an older call that fails late does not mark the newer one failed", async () => {
    const answers = { 1: deferred(), 2: deferred() };
    const juris = browser({ services: { rows: (page) => answers[page].promise } });
    juris.live("list", "rows", 1);
    juris.live("list", "rows", 2);
    answers[2].resolve(["page 2"]);
    await tick();
    answers[1].reject(new Error("old"));
    await tick();
    assert.equal(juris.api.liveState("list"), "live");
    assert.equal(juris.api.liveMessage("list"), null);
});

test("unsubscribing drops the path's status, and an answer arriving after it is not assigned", async () => {
    const rows = deferred();
    const juris = browser({ services: { rows: () => rows.promise } });
    const unsubscribe = juris.live("list", "rows");
    assert.equal(juris.api.liveState("list"), "pending");
    unsubscribe();
    assert.equal(juris.api.liveState("list"), null);
    rows.resolve([1]);
    await tick();
    assert.equal(juris.getState("list"), undefined);
    assert.doesNotThrow(() => unsubscribe(), "a second unsubscribe is harmless");
});

test("unsubscribing an older call leaves the newer one at the path alone", async () => {
    const juris = browser({ services: { rows: async (n) => [n] } });
    const older = juris.live("list", "rows", 1);
    juris.live("list", "rows", 2);
    await tick();
    older();
    assert.equal(juris.api.liveState("list"), "live");
    assert.deepEqual(juris.getState("list"), [2]);
});

test("inside a component the live call ends with the instance", async () => {
    const juris = server({ services: { rows: async () => [1] } });
    juris.registerComponent("Page", (props, api) => {
        api.live("list", "rows");
        return { p: () => api.liveState("list") };
    });
    const { html } = await juris.renderRequest({ preload: [["rows"]], layout: { Page: {} } });
    assert.equal(html, "<p>live</p>");
    assert.equal(juris.api.liveState("list"), null, "the render's instances are cleaned up when it ends");
});

test("clearState forgets the live calls: an answer belonging to the last request is dropped", async () => {
    const rows = deferred();
    const juris = server({ services: { rows: () => rows.promise } });
    juris.clearState({});
    juris.live("list", "rows");
    juris.clearState({ fresh: true });
    rows.resolve([1]);
    await tick();
    assert.equal(juris.getState("list"), undefined);
    assert.equal(juris.api.liveState("list"), null);
});

test("each path keeps its own status, a dotted path included, under the private async root", async () => {
    const juris = browser({ services: { ok: async () => 1, bad: async () => { throw new Error("no"); } } });
    juris.live("a", "ok");
    juris.live("a.b", "bad");
    await tick();
    assert.equal(juris.api.liveState("a"), "live");
    assert.equal(juris.api.liveState("a.b"), "failed");
    assert.equal(juris.api.liveMessage("a"), null);
    assert.equal(juris.api.liveMessage("a.b"), "no");
    assert.doesNotMatch(juris.serializeState(), /failed|live/);
});

test("liveState and liveMessage are null where nothing is live", () => {
    const juris = browser();
    assert.equal(juris.api.liveState("nothing"), null);
    assert.equal(juris.api.liveMessage("nothing"), null);
});

// ---- with a live client ------------------------------------------------------------------------------

test("with a live client, a path nobody preloaded is subscribed unseeded and nothing is called", () => {
    const rows = { calls: 0 };
    const juris = browser({ services: { rows: () => { rows.calls += 1; return Promise.resolve([]); } } });
    const transport = fakeTransport();
    juris.liveTransport = transport;
    const unsubscribe = juris.live("list", "rows", 1, "a");
    assert.equal(rows.calls, 0, "the subscription's first full value seeds the path, not a call");
    assert.equal(transport.subscriptions.length, 1);
    const [entry] = transport.subscriptions;
    assert.deepEqual({ ...entry }, { key: 'rows:[1,"a"]', name: "rows", args: [1, "a"], path: "list", options: { seeded: false }, on: true });
    unsubscribe();
    assert.equal(entry.on, false, "live() hands back the live client's unsubscribe");
});

test("with a live client, a preloaded path is assigned at once from the transfer and subscribed seeded", () => {
    const rows = { calls: 0 };
    const juris = browser({ services: { rows: () => { rows.calls += 1; return Promise.resolve([]); } } });
    juris.clearState({ $ssr: { calls: { "rows:[]": [{ id: 1 }] } } });
    const transport = fakeTransport();
    juris.liveTransport = transport;
    juris.live("list", "rows");
    assert.deepEqual(juris.getState("list"), [{ id: 1 }]);
    assert.deepEqual(transport.subscriptions[0].options, { seeded: true });
    assert.equal(rows.calls, 0);
});

test("with a live client, a preloaded failure is subscribed unseeded and assigns nothing", async () => {
    const juris = browser({ services: { rows: async () => [] } });
    juris.clearState({ $ssr: { calls: { "rows:[]": { $error: "request failed" } } } });
    const transport = fakeTransport();
    juris.liveTransport = transport;
    juris.live("list", "rows");
    await tick();
    assert.equal(juris.getState("list"), undefined);
    assert.deepEqual(transport.subscriptions[0].options, { seeded: false });
});

test("with a live client, a subscription made inside a component ends with it", () => {
    const juris = browser(withSSR({ services: { rows: async () => [] } }));
    const transport = fakeTransport();
    juris.liveTransport = transport;
    juris.registerComponent("Page", (props, api) => {
        api.live("list", "rows");
        return { p: "x" };
    });
    juris.renderToString({ Page: {} });
    assert.equal(transport.subscriptions.length, 1);
    assert.equal(transport.subscriptions[0].on, false);
});

test("liveState and liveMessage read where the live client keeps a path's status", () => {
    const juris = browser();
    juris.liveTransport = fakeTransport();
    juris.setValue("$live.paths.list", { status: "failed", message: "refused" });
    juris.setValue("$live.paths.a%2Eb", { status: "offline" });
    assert.equal(juris.api.liveState("list"), "failed");
    assert.equal(juris.api.liveMessage("list"), "refused");
    assert.equal(juris.api.liveState("a.b"), "offline");
});

test("a live client that keeps no status of its own leaves liveState reading where the core keeps it", async () => {
    const rows = deferred();
    const juris = browser({ services: { rows: () => rows.promise } });
    juris.live("list", "rows"); // no live client yet: the core keeps this path's status
    juris.liveTransport = fakeTransport({ withStatusAt: false });
    assert.equal(juris.api.liveState("list"), "pending");
    rows.resolve([]);
    await tick();
    assert.equal(juris.api.liveState("list"), "live");
});
