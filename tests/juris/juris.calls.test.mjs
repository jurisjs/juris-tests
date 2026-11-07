// juris.js, shared services (REFERENCE.md, "The component api" Services, "juris.js" Preloaded
// answers, "One server instance, every request"): api.call and the browser's call cache
// (dedupe, ttl, invalidate, refreshCached), preload, api.preloaded and releasePreloaded,
// renderRequest with its copies, result, trace and after, serializeState, renderTrace and
// markRender, and the words a rejection is recorded with on each side.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import { ServiceError } from "juris/errors.js";
import { callKind } from "juris/live-protocol.js";
import { tick } from "../support/juris-harness.mjs";
import { withSSR } from "../support/ssr-renderer.mjs";

const server = (options = {}) => new Juris(withSSR({ isServer: true, ...options }));
const browser = (options = {}) => new Juris({ isServer: false, ...options });

// A promise and the means to settle it from outside.
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

// A service that counts its calls and answers what `answer(...args)` gives.
function counted(answer = (...args) => args) {
    const service = async (...args) => {
        service.calls += 1;
        return answer(...args);
    };
    service.calls = 0;
    return service;
}

// Whether a call's answer runs its callbacks at once (a settled value) rather than later.
function answersAtOnce(value) {
    let ran = false;
    value.then(() => { ran = true; }, () => { ran = true; });
    return ran;
}

// ---- api.call ------------------------------------------------------------------------------------

test("a call to an unknown service is refused, and so is a name every object inherits", () => {
    const juris = browser({ services: { rows: () => [] } });
    for (const name of ["nope", "toString", "constructor", "hasOwnProperty"]) {
        assert.throws(() => juris.call(name), { message: `Juris.call: unknown service "${name}"` });
    }
});

test("in a browser without a call cache, a call reaches the service directly with its arguments", () => {
    const seen = [];
    const answer = Promise.resolve("ok");
    const juris = browser({ services: { rows: function (...args) { seen.push([callKind(this), args]); return answer; } } });
    assert.equal(juris.api.call("rows", 1, { q: "a" }), answer, "the service's own answer is handed back");
    assert.deepEqual(seen, [["direct", [1, { q: "a" }]]]);
});

test("on a server, a call nobody preloaded reaches the service as a render's call", async () => {
    const seen = [];
    const juris = server({ services: { rows: function (...args) { seen.push([callKind(this), args]); return "answer"; } } });
    const answer = juris.call("rows", 7);
    assert.ok(answersAtOnce(answer), "an answer given at once is answered as a settled value");
    assert.equal(await answer, "answer");
    assert.deepEqual(seen, [["render", [7]]]);
});

// "call answers a promise" ("The component api", Services): a local service that is not async (a
// test's, a server's own) answered its bare value, so `api.call(…).then(…)` threw a TypeError, and a
// service that threw threw out of the call, past its `catch`. Its answer is a settled value, as a
// preloaded call's is, so the callbacks still run at once and a server render draws it.
test("a local service that answers at once is answered as a settled value, in a browser and on a server", async () => {
    const price = (sku) => `${sku}: 3 €`;
    for (const juris of [browser({ services: { price } }), server({ services: { price } })]) {
        const answer = juris.api.call("price", "milk");
        let text = null;
        answer.then((value) => {
            text = value;
        });
        assert.equal(text, "milk: 3 €", "its callbacks run at once, as a preloaded call's do");
        assert.equal(await answer, "milk: 3 €");
    }
});

test("a local service that throws at once answers a settled rejection, which catch takes", async () => {
    const failure = new Error("The price list is down.");
    const price = () => {
        throw failure;
    };
    for (const juris of [browser({ services: { price } }), server({ services: { price } })]) {
        let caught = null;
        juris.api.call("price", "milk").catch((error) => {
            caught = error;
        });
        assert.equal(caught, failure, "the rejection is handed over at once");
        await assert.rejects(juris.api.call("price", "milk"), (error) => error === failure);
    }
});

test("a server render draws a local service's answer given at once, through then and in a binding", () => {
    const juris = server({ services: { price: () => 3 } });
    juris.registerComponent("Price", (props, api) => {
        let text = "…";
        api.call("price").then((price) => {
            text = `${price} €`;
        });
        return { p: { children: [{ span: text }, { b: () => api.call("price") }] } };
    });
    assert.equal(juris.renderToString({ Price: {} }), "<p><span>3 €</span><b>3</b></p>");
});

test("with requirePreload, a call nobody preloaded throws, naming its key, and reaches nothing", () => {
    const rows = counted();
    const juris = server({ requirePreload: true, services: { rows } });
    assert.throws(() => juris.call("rows", 1), { message: "Juris.call: rows:[1] was not preloaded for this request" });
    assert.equal(rows.calls, 0);
});

test("callKey is the live protocol's key: the name, then the arguments as JSON", () => {
    const juris = server();
    assert.equal(juris.callKey("rows", [1, { q: "a" }]), 'rows:[1,{"q":"a"}]');
    assert.equal(juris.callKey("rows", []), "rows:[]");
});

test("a preloaded call answers a settled value whose callbacks run at once, as often as it is called", async () => {
    const rows = counted(() => [{ id: 1 }]);
    const juris = server({ requirePreload: true, services: { rows } });
    juris.registerComponent("List", (props, api) => {
        let text = "";
        api.call("rows").then((list) => { text = list.map((row) => row.id).join(","); });
        api.call("rows").then((list) => { text += `|${list.length}`; });
        return { p: text };
    });
    const { html } = await juris.renderRequest({ preload: [["rows"]], layout: { List: {} } });
    assert.equal(html, "<p>1|1</p>");
    assert.equal(rows.calls, 1, "only the preload reached the service");
    assert.ok(answersAtOnce(juris.call("rows")), "the transfer is not consumed by the render");
});

test("a preloaded failure is reproduced: the call rejects at once, with the words the preload kept", async () => {
    const juris = server({ requirePreload: true, services: { save: async () => { throw new ServiceError("Not yours."); } } });
    await juris.renderRequest({ preload: [["save", 1]], layout: { p: "x" } });
    let caught = null;
    juris.call("save", 1).catch((error) => { caught = error; });
    assert.ok(caught instanceof Error);
    assert.equal(caught.message, "Not yours.");
});

test("a traced render records every call's key, and a call nobody preloaded marks it unresolved", async () => {
    const juris = server({ services: { a: async () => 1, b: async () => 2 } });
    juris.registerComponent("Page", (props, api) => {
        api.call("a");
        api.call("b", 2);
        return { p: "x" };
    });
    const { trace } = await juris.renderRequest({ preload: [["a"]], layout: { Page: {} }, trace: true });
    assert.deepEqual(trace.calls, ["a:[]", "b:[2]"]);
    assert.deepEqual(trace.services, ["a", "b"]);
    assert.ok(trace.flags.includes("unresolved"));
    assert.equal(trace.static, false);
});

test("a traced render whose calls were all preloaded is not marked unresolved", async () => {
    const juris = server({ services: { a: async () => 1 } });
    juris.registerComponent("Page", (props, api) => { api.call("a"); return { p: "x" }; });
    const { trace } = await juris.renderRequest({ preload: [["a"]], layout: { Page: {} }, trace: true });
    assert.deepEqual(trace.flags, []);
});

// ---- the browser's call cache ---------------------------------------------------------------------------

test("dedupe shares one promise between identical calls in flight, and calls again once it settles", async () => {
    const rows = counted();
    const juris = browser({ callCache: { dedupe: true }, services: { rows } });
    const first = juris.call("rows", 1);
    const second = juris.call("rows", 1);
    const other = juris.call("rows", 2);
    assert.equal(first, second);
    assert.notEqual(first, other);
    assert.deepEqual(await first, [1]);
    await other;
    assert.equal(rows.calls, 2);
    await juris.call("rows", 1);
    assert.equal(rows.calls, 3, "a settled call is not kept without a ttl");
});

test("ttl reuses a resolved result, answered at once, until its time is up", async (t) => {
    mock.timers.enable({ apis: ["Date"], now: 1_000 });
    t.after(() => mock.timers.reset());
    const rows = counted((n) => ({ n }));
    const juris = browser({ callCache: { ttl: 100 }, services: { rows } });
    assert.deepEqual(await juris.call("rows", 1), { n: 1 });
    const again = juris.call("rows", 1);
    assert.ok(answersAtOnce(again));
    let value;
    again.then((v) => { value = v; });
    assert.deepEqual(value, { n: 1 });
    assert.equal(rows.calls, 1);
    mock.timers.tick(99);
    assert.ok(answersAtOnce(juris.call("rows", 1)), "still fresh just before the ttl");
    mock.timers.tick(1);
    const expired = juris.call("rows", 1);
    assert.equal(answersAtOnce(expired), false);
    await expired;
    assert.equal(rows.calls, 2);
});

test("ttl without dedupe does not share a call in flight, and keeps the latest call's answer", async () => {
    const pending = [];
    const juris = browser({ callCache: { ttl: 1_000 }, services: { rows: () => { const d = deferred(); pending.push(d); return d.promise; } } });
    const first = juris.call("rows");
    const second = juris.call("rows");
    assert.notEqual(first, second);
    await tick();
    assert.equal(pending.length, 2, "each call reached the service");
    pending[1].resolve("second");
    await second;
    pending[0].resolve("first");
    assert.equal(await first, "first", "the older call still answers its caller");
    let kept;
    juris.call("rows").then((v) => { kept = v; });
    assert.equal(kept, "second", "the older answer, arriving late, was not stored");
});

test("dedupe with ttl shares the call in flight and keeps its answer", async () => {
    const rows = counted(() => "rows");
    const juris = browser({ callCache: { dedupe: true, ttl: 1_000 }, services: { rows } });
    const first = juris.call("rows");
    assert.equal(juris.call("rows"), first);
    await first;
    assert.ok(answersAtOnce(juris.call("rows")));
    assert.equal(rows.calls, 1);
});

test("a call invalidated while in flight finishes for its caller and is not stored", async () => {
    const rows = counted(() => "rows");
    const juris = browser({ callCache: { ttl: 1_000 }, services: { rows } });
    const call = juris.call("rows");
    juris.invalidate("rows");
    assert.equal(await call, "rows");
    assert.equal(answersAtOnce(juris.call("rows")), false);
});

test("a rejected call is not kept: the next one tries again", async () => {
    let fail = true;
    const rows = counted(() => { if (fail) throw new Error("down"); return "rows"; });
    const juris = browser({ callCache: { dedupe: true, ttl: 1_000 }, services: { rows } });
    await assert.rejects(juris.call("rows"), { message: "down" });
    fail = false;
    assert.equal(await juris.call("rows"), "rows");
    assert.equal(rows.calls, 2);
});

test("an older call that rejects after being invalidated leaves the newer call's entry alone", async () => {
    const pending = [];
    const juris = browser({ callCache: { dedupe: true }, services: { rows: () => { const d = deferred(); pending.push(d); return d.promise; } } });
    const older = juris.call("rows");
    juris.invalidate("rows");
    const newer = juris.call("rows");
    await tick();
    pending[0].reject(new Error("old failure"));
    await assert.rejects(older, { message: "old failure" });
    assert.equal(juris.call("rows"), newer, "the newer call is still the one shared");
    pending[1].resolve("fresh");
    assert.equal(await newer, "fresh");
});

test("writing a result drops every result whose time is up", async (t) => {
    mock.timers.enable({ apis: ["Date"], now: 0 });
    t.after(() => mock.timers.reset());
    const juris = browser({ callCache: { ttl: 10 }, services: { s: async (n) => n } });
    await juris.call("s", 1);
    await juris.call("s", 2);
    assert.equal(juris.callCache.size, 2);
    mock.timers.tick(10);
    await juris.call("s", 3);
    assert.deepEqual([...juris.callCache.keys()], [juris.callKey("s", [3])]);
});

test("invalidate drops one call, every call of a service, or everything", async () => {
    const s = counted();
    const s2 = counted();
    const juris = browser({ callCache: { ttl: 60_000 }, services: { s, s2 } });
    const warm = () => Promise.all([juris.call("s", 1), juris.call("s", 2), juris.call("s2", 1)]);
    await warm();
    assert.deepEqual([s.calls, s2.calls], [2, 1]);

    juris.api.invalidate("s", 1);
    await warm();
    assert.deepEqual([s.calls, s2.calls], [3, 1], "only s(1) was dropped");

    juris.invalidate("s");
    await warm();
    assert.deepEqual([s.calls, s2.calls], [5, 1], "every call of s, and none of s2, whose name starts alike");

    juris.invalidate();
    await warm();
    assert.deepEqual([s.calls, s2.calls], [7, 2]);
});

test("refreshCached replaces a kept result, so the next call answers the pushed value", async () => {
    const rows = counted(() => ["old"]);
    const juris = browser({ callCache: { ttl: 60_000 }, services: { rows } });
    await juris.call("rows");
    juris.refreshCached(juris.callKey("rows", []), ["new"]);
    let value;
    juris.call("rows").then((v) => { value = v; });
    assert.deepEqual(value, ["new"]);
    assert.equal(rows.calls, 1);
});

test("refreshCached keeps nothing for a call never made, one still in flight, or without a ttl", async () => {
    const rows = counted(() => ["served"]);
    const juris = browser({ callCache: { ttl: 60_000 }, services: { rows } });
    juris.refreshCached(juris.callKey("rows", []), ["pushed"]);
    assert.equal(juris.callCache.size, 0, "never called: nothing to refresh");
    const inFlight = juris.call("rows");
    juris.refreshCached(juris.callKey("rows", []), ["pushed"]);
    await inFlight;
    let value;
    juris.call("rows").then((v) => { value = v; });
    assert.deepEqual(value, ["served"], "the in-flight call's own answer is the one kept");

    const deduped = browser({ callCache: { dedupe: true }, services: { rows } });
    await deduped.call("rows");
    deduped.refreshCached(deduped.callKey("rows", []), ["pushed"]);
    assert.equal(deduped.callCache.size, 0);
});

test("clearState empties the call cache", async () => {
    const rows = counted();
    const juris = browser({ callCache: { ttl: 60_000 }, services: { rows } });
    await juris.call("rows");
    juris.clearState({});
    assert.equal(answersAtOnce(juris.call("rows")), false);
});

// ---- preload --------------------------------------------------------------------------------------------

test("preload runs its calls in parallel, each as a preload's, keyed by callKey", async () => {
    const started = [];
    const service = (name) => function (...args) { started.push([name, callKind(this), args]); return Promise.resolve(`${name}!`); };
    const juris = server({ services: { a: service("a"), b: service("b") } });
    const loading = juris.preload([["a", 1], ["b"]]);
    assert.deepEqual(started, [["a", "preload", [1]], ["b", "preload", []]], "both started before either was awaited");
    assert.deepEqual(await loading, { calls: { "a:[1]": "a!", "b:[]": "b!" } });
});

test("preload of nothing is no calls", async () => {
    assert.deepEqual(await server().preload([]), { calls: {} });
});

test("a preloaded answer is a JSON copy of what the service answered", async () => {
    const master = { units: ["kg"], when: new Date(0) };
    const juris = server({ services: { master: async () => master } });
    const { calls } = await juris.preload([["master"]]);
    const answer = calls["master:[]"];
    assert.notEqual(answer, master);
    assert.deepEqual(answer, { units: ["kg"], when: "1970-01-01T00:00:00.000Z" });
    master.units.push("g");
    assert.deepEqual(answer.units, ["kg"]);
});

test("an answer JSON cannot carry is recorded as that call's failure, and reported", async () => {
    const reported = [];
    const cyclic = {};
    cyclic.self = cyclic;
    const juris = server({
        services: { big: async () => 1n, loop: async () => cyclic },
        reportError: (error, name, args) => reported.push([error instanceof TypeError, name, args]),
    });
    const { calls } = await juris.preload([["big"], ["loop", 1]]);
    assert.deepEqual(calls, { "big:[]": { $error: "request failed" }, "loop:[1]": { $error: "request failed" } });
    assert.deepEqual(reported, [[true, "big", []], [true, "loop", [1]]]);
});

test("a failed preload keeps the words exposeError allows, and reportError sees the original", async () => {
    const driver = new Error('relation "users" does not exist');
    const reported = [];
    const services = { driver: async () => { throw driver; }, refusal: async () => { throw new ServiceError("Sign in first."); } };
    const juris = server({ services, reportError: (error, name, args) => reported.push([error, name, args]) });
    const { calls } = await juris.preload([["driver", 1], ["refusal"]]);
    assert.deepEqual(calls, { "driver:[1]": { $error: "request failed" }, "refusal:[]": { $error: "Sign in first." } });
    assert.equal(reported[0][0], driver);
    assert.deepEqual(reported[0].slice(1), ["driver", [1]]);

    const open = server({ services, exposeError: () => true });
    const opened = await open.preload([["driver"]]);
    assert.deepEqual(opened.calls, { "driver:[]": { $error: 'relation "users" does not exist' } });
});

test("a preloaded service that answers nothing has answered, and has not failed", async () => {
    const none = counted(() => undefined);
    const reported = [];
    const juris = server({ requirePreload: true, services: { none }, reportError: (error) => reported.push(error) });
    let answered = "not yet";
    juris.registerComponent("Page", (props, api) => {
        api.call("none").then((value) => { answered = value; });
        return { p: "x" };
    });
    const { result, trace } = await juris.renderRequest({ preload: [["none"]], layout: { Page: {} }, trace: true });
    assert.equal(answered, undefined, "the render was answered at once, from the preload");
    assert.equal(none.calls, 1);
    assert.equal(result("none"), undefined);
    assert.deepEqual(trace.failed, []);
    assert.deepEqual(reported, []);
});

test("without reportError a failed preload is still recorded", async () => {
    const juris = server({ services: { s: async () => { throw new Error("x"); } } });
    assert.deepEqual(await juris.preload([["s"]]), { calls: { "s:[]": { $error: "request failed" } } });
});

test("a preload of an unknown service rejects, naming it, an inherited name included", async () => {
    const juris = server({ services: {} });
    await assert.rejects(juris.preload([["nope"]]), { message: 'Juris.preload: unknown service "nope"' });
    await assert.rejects(juris.preload([["toString"]]), { message: 'Juris.preload: unknown service "toString"' });
});

// ---- api.preloaded and releasePreloaded ---------------------------------------------------------------------

test("api.preloaded reads a preloaded answer without reaching the service, even with requirePreload", async () => {
    const title = counted(() => "Hello");
    const juris = server({ requirePreload: true, services: { title } });
    juris.registerComponent("Head", (props, api) => ({ h1: api.preloaded("title", 1) }));
    const { html } = await juris.renderRequest({ preload: [["title", 1]], layout: { Head: {} } });
    assert.equal(html, "<h1>Hello</h1>");
    assert.equal(title.calls, 1);
});

test("api.preloaded answers undefined for a call not preloaded, one that failed, or with no transfer", async () => {
    const juris = server({ services: { ok: async () => 1, bad: async () => { throw new Error("x"); } } });
    assert.equal(juris.api.preloaded("ok"), undefined, "no transfer at all");
    await juris.renderRequest({ preload: [["ok"], ["bad"]], layout: { p: "x" } });
    assert.equal(juris.api.preloaded("ok"), 1);
    assert.equal(juris.api.preloaded("ok", 2), undefined, "other arguments");
    assert.equal(juris.api.preloaded("bad"), undefined);
});

test("api.preloaded answers null when the call answered null", async () => {
    const juris = server({ services: { none: async () => null } });
    await juris.renderRequest({ preload: [["none"]], layout: { p: "x" } });
    assert.equal(juris.api.preloaded("none"), null);
});

test("a traced render lists a preloaded call it read, and not a read of one never preloaded", async () => {
    const juris = server({ services: { a: async () => 1, b: async () => 2, bad: async () => { throw new Error("x"); } } });
    juris.registerComponent("Page", (props, api) => {
        api.preloaded("a");
        api.preloaded("b");
        api.preloaded("bad");
        return { p: "x" };
    });
    const { trace } = await juris.renderRequest({ preload: [["a"], ["bad"]], layout: { Page: {} }, trace: true });
    assert.deepEqual(trace.calls, ["a:[]", "bad:[]"], "a failed read counts: the markup depends on the failure");
    assert.deepEqual(trace.flags, [], "a read is not a call left unresolved");
});

test("releasePreloaded drops the transfer, and preloaded answers undefined from then on", async () => {
    const page = server({ services: { title: async () => "Hello" } });
    const { json } = await page.renderRequest({ preload: [["title"]], layout: { p: "x" } });
    const juris = browser({ services: { title: async () => "fresh" } });
    juris.clearState(JSON.parse(json));
    assert.equal(juris.api.preloaded("title"), "Hello");
    assert.ok(answersAtOnce(juris.call("title")));
    juris.releasePreloaded();
    assert.equal(juris.stateManager.peek("$ssr"), undefined);
    assert.equal(juris.api.preloaded("title"), undefined);
    assert.equal(await juris.call("title"), "fresh");
});

test("releasePreloaded with nothing transferred changes nothing", () => {
    const changes = [];
    const juris = browser({ state: { a: 1 }, onChange: (path) => changes.push(path) });
    juris.releasePreloaded();
    assert.deepEqual(changes, []);
    assert.deepEqual(JSON.parse(juris.serializeState()), { a: 1 });
});

test("ssrPath renames where the transfer travels", async () => {
    const juris = server({ ssrPath: "$pre", services: { a: async () => 1 } });
    const { json } = await juris.renderRequest({ preload: [["a"]], layout: { p: "x" } });
    assert.deepEqual(JSON.parse(json), { $pre: { calls: { "a:[]": 1 } } });
    assert.ok(answersAtOnce(juris.call("a")));
});

// ---- renderRequest ----------------------------------------------------------------------------------------

test("renderRequest needs a layout", async () => {
    await assert.rejects(server().renderRequest({}), { message: "Juris.renderRequest: layout is required" });
});

test("renderRequest answers html, json, result and cache, and no trace unless asked", async () => {
    const juris = server({ services: { title: async (id) => `Post ${id}` } });
    juris.registerComponent("Post", (props, api) => {
        let title = "";
        api.call("title", props.id).then((t) => { title = t; });
        return { h1: title };
    });
    const out = await juris.renderRequest({ preload: [["title", 7]], state: { user: "ada" }, layout: { Post: { id: 7 } } });
    assert.deepEqual(Object.keys(out).sort(), ["cache", "html", "json", "result"]);
    assert.equal(out.html, "<h1>Post 7</h1>");
    assert.deepEqual(JSON.parse(out.json), { user: "ada", $ssr: { calls: { "title:[7]": "Post 7" } } });
    assert.deepEqual(out.cache, { calls: { "title:[7]": "Post 7" } });
    assert.equal(out.result("title", 7), "Post 7");
});

test("result reads this render's calls whatever the instance renders next", async () => {
    const juris = server({ services: { title: async (id) => `Post ${id}`, gone: async () => { throw new Error("x"); }, none: async () => null } });
    const first = await juris.renderRequest({ preload: [["title", 1], ["gone"], ["none"]], layout: { p: "x" } });
    await juris.renderRequest({ preload: [["title", 2]], layout: { p: "y" } });
    assert.equal(first.result("title", 1), "Post 1");
    assert.equal(first.result("title", 2), undefined, "not preloaded in that render");
    assert.equal(first.result("gone"), undefined, "failed");
    assert.equal(first.result("none"), null, "null is an answer");
});

test("a traced renderRequest carries renderTrace's fields and failed, each failing service once, sorted", async () => {
    const services = { z: async () => { throw new Error("x"); }, a: async () => { throw new Error("y"); }, ok: async () => 1 };
    const juris = server({ services });
    const { trace } = await juris.renderRequest({ preload: [["z", 1], ["z", 2], ["a"], ["ok"]], layout: { p: "x" }, trace: true });
    assert.deepEqual(trace.failed, ["a", "z"]);
    assert.deepEqual(Object.keys(trace).sort(), ["calls", "failed", "flags", "live", "paths", "reactive", "roots", "services", "static", "unknown"]);
    const clean = await juris.renderRequest({ preload: [["ok"]], layout: { p: "x" }, trace: true });
    assert.deepEqual(clean.trace.failed, []);
});

test("after is asked with result once the render is done, and its answer comes back", async () => {
    const juris = server({ services: { title: async () => "Hello" } });
    juris.registerComponent("Page", (props, api) => { api.setValue("page.status", 404); return { p: "x" }; });
    const seen = [];
    const out = await juris.renderRequest({
        preload: [["title"]],
        layout: { Page: {} },
        after: (result) => {
            seen.push(juris.stateManager.peek("page.status"));
            return { title: result("title") };
        },
    });
    assert.deepEqual(seen, [404], "what the render set is still this request's");
    assert.deepEqual(out.after, { title: "Hello" });
    const traced = await juris.renderRequest({ layout: { p: "x" }, trace: true, after: () => "done" });
    assert.equal(traced.after, "done");
    assert.ok(traced.trace);
});

test("renderRequest draws in the namespace it is given", async () => {
    const juris = server();
    assert.equal((await juris.renderRequest({ layout: { br: {} } })).html, "<br>");
    assert.equal((await juris.renderRequest({ layout: { br: {} }, namespace: "http://www.w3.org/2000/svg" })).html, "<br></br>");
});

test("each request starts from its own state", async () => {
    const juris = server();
    await juris.renderRequest({ state: { user: "ada" }, layout: { p: "x" } });
    const second = await juris.renderRequest({ state: { other: 1 }, layout: { p: () => String(juris.getState("user", "nobody")) } });
    assert.equal(second.html, "<p>nobody</p>");
    assert.deepEqual(JSON.parse(second.json), { other: 1, $ssr: { calls: {} } });
});

test("renderRequest copies the plain objects and arrays of its state, so a render's write stays in it", async () => {
    const shared = { cfg: { mode: "a", list: [1, { deep: true }] } };
    const juris = server();
    juris.registerComponent("Page", (props, api) => {
        api.setValue("cfg.mode", "b");
        api.setValue("cfg.list.1.deep", false);
        return { p: () => api.getState("cfg.mode") };
    });
    const { html } = await juris.renderRequest({ state: shared, layout: { Page: {} } });
    assert.equal(html, "<p>b</p>");
    assert.deepEqual(shared, { cfg: { mode: "a", list: [1, { deep: true }] } });
});

test("renderRequest keeps other values as they are and a cycle as a cycle", async () => {
    class Connection { }
    const connection = new Connection();
    const when = new Date(0);
    const loop = { name: "loop" };
    loop.self = loop;
    const juris = server();
    const { after } = await juris.renderRequest({
        state: { $server: { connection, when, loop, pair: [loop, loop] } },
        layout: { p: "x" },
        after: () => juris.stateManager.peek("$server"),
    });
    assert.equal(after.connection, connection);
    assert.equal(after.when, when);
    assert.notEqual(after.loop, loop, "a plain object is copied");
    assert.equal(after.loop.self, after.loop, "its cycle is the copy's");
    assert.equal(after.pair[0], after.loop);
    assert.equal(after.pair[1], after.loop);
});

test("an own __proto__ key in the request's state stays data in the copy", async () => {
    const juris = server();
    const state = JSON.parse('{"cfg": {"__proto__": {"polluted": true}, "a": 1}}');
    const { after } = await juris.renderRequest({ state, layout: { p: "x" }, after: () => juris.stateManager.peek("cfg") });
    assert.equal(Object.getPrototypeOf(after), Object.prototype);
    assert.ok(Object.hasOwn(after, "__proto__"));
    assert.equal(after.polluted, undefined);
    assert.equal({}.polluted, undefined);
});

// ---- serializeState --------------------------------------------------------------------------------------

test("serializeState leaves out the private roots and escapes < so data cannot close the script", () => {
    const juris = server({ privatePaths: ["session"], state: { note: "</script><script>alert(1)</script>", session: { id: 1 }, $server: { db: 1 } } });
    juris.setValue("$async.pending", 1);
    const json = juris.serializeState();
    assert.doesNotMatch(json, /</);
    assert.match(json, /\\u003c\/script>/);
    assert.deepEqual(JSON.parse(json), { note: "</script><script>alert(1)</script>" });
});

// ---- renderTrace and markRender ----------------------------------------------------------------------------

test("renderTrace is null until a traced render has run", () => {
    const juris = server();
    assert.equal(juris.renderTrace(), null);
    juris.renderToString({ p: "x" });
    assert.equal(juris.renderTrace(), null);
});

test("renderTrace says what the last traced render read, called, subscribed and was marked with", () => {
    const juris = server({ services: { rows: async () => [] }, state: { user: { name: "Ada" }, theme: "dark" } });
    juris.registerComponent("Page", (props, api) => {
        api.live("list", "rows");
        api.markRender("random");
        api.markRender(42);
        return {
            div: {
                children: [
                    { p: () => api.getState("user.name") },
                    { p: () => String(api.peek("theme")) },
                    { Missing: {} },
                ],
            },
        };
    });
    juris.renderToString({ Page: {} }, null, { trace: true });
    const trace = juris.renderTrace();
    assert.equal(trace.reactive, 2);
    assert.ok(trace.paths.includes("user.name"));
    assert.ok(trace.paths.includes("theme"), "a peek is recorded like a getState");
    assert.ok(trace.roots.includes("user"));
    assert.ok(trace.roots.includes("theme"));
    assert.deepEqual(trace.calls, ["rows:[]"]);
    assert.deepEqual(trace.services, ["rows"]);
    assert.deepEqual(trace.live, ["rows"]);
    assert.deepEqual(trace.flags.sort(), ["42", "random", "unresolved"]);
    assert.deepEqual(trace.unknown, ["Missing"]);
    assert.equal(trace.static, false);
    assert.doesNotThrow(() => JSON.stringify(trace), "a plain serialisable shape");
});

test("a traced render with no reactive function and no call is static", () => {
    const juris = server();
    juris.renderToString({ div: { children: [{ p: "a" }, { p: "b" }] } }, null, { trace: true });
    const trace = juris.renderTrace();
    assert.equal(trace.static, true);
    assert.equal(trace.reactive, 0);
    assert.deepEqual(trace.paths, []);
});

test("markRender outside a traced render does nothing", () => {
    const juris = server();
    assert.doesNotThrow(() => juris.markRender("clock"));
    juris.renderToString({ p: "x" }, null, { trace: true });
    assert.deepEqual(juris.renderTrace().flags, []);
});

// ---- the words a rejection is kept with --------------------------------------------------------------------

test("on a server a group's recorded rejection passes exposeError", async () => {
    const juris = server();
    const group = juris.api.group("panel");
    await group.track(Promise.reject(new Error('column "ssn" does not exist'))).catch(() => { });
    await group.track(Promise.reject(new ServiceError("Try again later."))).catch(() => { });
    assert.deepEqual(group.errors().map((e) => e.message), ["request failed", "Try again later."]);
});

test("on a server the async error log passes exposeError too", async () => {
    const juris = server({ pendingDelay: 0 });
    juris.bindState(() => Promise.reject(new Error("driver words")), () => { });
    await tick();
    assert.deepEqual(juris.stateManager.peek("$async.errors").map((e) => e.message), ["request failed"]);
});

test("an app's exposeError opens a server's recorded words", async () => {
    const juris = server({ exposeError: () => true });
    const group = juris.api.group("panel");
    await group.track(Promise.reject(new Error("visible"))).catch(() => { });
    assert.deepEqual(group.errors().map((e) => e.message), ["visible"]);
});

test("in a browser a rejection is recorded with its own words, a thrown value that is not an Error included", async () => {
    const juris = browser();
    const group = juris.api.group("panel");
    await group.track(Promise.reject(new Error("driver words"))).catch(() => { });
    await group.track(Promise.reject("plain")).catch(() => { });
    assert.deepEqual(group.errors().map((e) => e.message), ["driver words", "plain"]);
});
