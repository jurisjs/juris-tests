// remote-services.js, the service stubs: remoteServices(names, options), what each stub sends, what
// it answers, how a refusal, an answer that is not JSON and a call that takes too long reject, and
// the options it refuses. Also the module's re-export of diff. The live client, sseClient, is in
// remote-services.sse*.test.mjs. Held to REFERENCE.md ("remote-services.js").
import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteServices, diff as reexported } from "juris/remote-services.js";
import { diff } from "juris/live-protocol.js";
import { ServiceError } from "juris/errors.js";
import { withGlobals, flush } from "../support/remote-services-fakes.mjs";

const TIMEOUT_WORDS = "The request took too long; it may or may not have been applied.";

// A fetch that records each request and answers what `answer()` builds: { status, statusText, body },
// or `json: false` for a body that is not JSON.
function server(answer = () => ({ body: {} })) {
    const requests = [];
    const fetch = async (url, init) => {
        requests.push({ url, init });
        const { status = 200, statusText = "OK", body, json = true } = answer(url, init) ?? {};
        return {
            ok: status >= 200 && status < 300,
            status,
            statusText,
            json: async () => {
                if (!json) throw new SyntaxError("Unexpected token < in JSON");
                return body;
            },
        };
    };
    return { fetch, requests };
}

const rejection = async (promise) => {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    assert.fail("expected the call to reject");
};

// ---- what a stub sends -------------------------------------------------------------------------

test("remoteServices answers one stub per name, and nothing else", () => {
    const services = remoteServices(["a", "b"], { fetch: server().fetch });
    assert.deepEqual(Object.keys(services), ["a", "b"]);
    for (const stub of Object.values(services)) assert.equal(typeof stub, "function");
    assert.deepEqual(remoteServices([]), {});
});

test("a stub POSTs its arguments as JSON to /api/<name> by default", async () => {
    const { fetch, requests } = server(() => ({ body: { saved: true } }));
    const services = remoteServices(["save"], { fetch });
    assert.deepEqual(await services.save({ title: "Hi" }, 2), { saved: true });
    assert.equal(requests.length, 1);
    const [{ url, init }] = requests;
    assert.equal(url, "/api/save");
    assert.equal(init.method, "POST");
    assert.deepEqual(init.headers, { "content-type": "application/json" });
    assert.equal(init.body, '[{"title":"Hi"},2]');
});

test("a stub called with no arguments sends an empty list", async () => {
    const { fetch, requests } = server();
    await remoteServices(["ping"], { fetch }).ping();
    assert.equal(requests[0].init.body, "[]");
});

test("a stub posts under the base it is given", async () => {
    const { fetch, requests } = server();
    await remoteServices(["save"], { base: "/v2/svc", fetch }).save();
    assert.equal(requests[0].url, "/v2/svc/save");
});

test("a string second argument is the base", async () => {
    const { fetch, requests } = server();
    await withGlobals({ fetch }, () => remoteServices(["save"], "/legacy").save());
    assert.equal(requests[0].url, "/legacy/save");
});

test("options omitted or null take every default", async () => {
    const { fetch, requests } = server();
    await withGlobals({ fetch }, async () => {
        await remoteServices(["a"]).a();
        await remoteServices(["b"], null).b();
    });
    assert.deepEqual(requests.map((request) => request.url), ["/api/a", "/api/b"]);
});

test("a stub encodes its name as one path segment", async () => {
    const { fetch, requests } = server();
    await remoteServices(["a b/c?d"], { fetch })["a b/c?d"]();
    assert.equal(requests[0].url, "/api/a%20b%2Fc%3Fd");
});

test("a stub reads the global fetch at each call, unless options.fetch replaces it", async () => {
    const first = server(() => ({ body: "first" }));
    const second = server(() => ({ body: "second" }));
    const own = server(() => ({ body: "own" }));
    const unpinned = remoteServices(["q"]);
    const pinned = remoteServices(["q"], { fetch: own.fetch });
    await withGlobals({ fetch: first.fetch }, async () => {
        assert.equal(await unpinned.q(), "first");
        assert.equal(await pinned.q(), "own");
    });
    await withGlobals({ fetch: second.fetch }, async () => {
        assert.equal(await unpinned.q(), "second", "the global as it is at the call");
        assert.equal(await pinned.q(), "own");
    });
    assert.equal(first.requests.length + second.requests.length, 2);
});

test("a stub resolves with whatever JSON a 2xx answer carries, null included", async () => {
    const answers = [[201, { id: 7 }], [200, null], [204, 0], [200, ["a"]]];
    for (const [status, body] of answers) {
        const services = remoteServices(["s"], { fetch: server(() => ({ status, body })).fetch });
        assert.deepEqual(await services.s(), body, `${status} ${JSON.stringify(body)}`);
    }
});

// ---- refusals ----------------------------------------------------------------------------------

test("a refusal rejects with a ServiceError carrying the answer's words, status, fields, field and code", async () => {
    const body = { error: "Give the post a title.", fields: { title: "Required.", body: "Too short." }, field: "title", code: "form.invalid" };
    const services = remoteServices(["save"], { fetch: server(() => ({ status: 422, statusText: "Unprocessable Entity", body })).fetch });
    const error = await rejection(services.save({}));
    assert.ok(error instanceof ServiceError);
    assert.equal(error.message, "Give the post a title.");
    assert.equal(error.status, 422);
    assert.deepEqual(error.fields, { title: "Required.", body: "Too short." });
    assert.equal(error.field, "title");
    assert.equal(error.code, "form.invalid");
});

test("a refusal with fields alone, from an older server, guesses no field", async () => {
    const body = { error: "Check the form.", fields: { email: "Taken." } };
    const services = remoteServices(["join"], { fetch: server(() => ({ status: 400, body })).fetch });
    const error = await rejection(services.join());
    assert.deepEqual(error.fields, { email: "Taken." });
    assert.equal("field" in error, false);
    assert.equal("code" in error, false);
});

test("a refusal whose answer carries no fields and no code has neither", async () => {
    const services = remoteServices(["x"], { fetch: server(() => ({ status: 409, body: { error: "Conflict.", fields: null, code: null } })).fetch });
    const error = await rejection(services.x());
    assert.equal(error.message, "Conflict.");
    assert.equal(error.status, 409);
    assert.equal("fields" in error, false);
    assert.equal("code" in error, false);
});

test("a refusal whose answer has no words takes the status line by default", async () => {
    const json = remoteServices(["x"], { fetch: server(() => ({ status: 502, statusText: "Bad Gateway", body: {} })).fetch });
    const error = await rejection(json.x());
    assert.ok(error instanceof ServiceError);
    assert.equal(error.message, "502 Bad Gateway");
    assert.equal(error.status, 502);
    const page = remoteServices(["x"], { fetch: server(() => ({ status: 503, statusText: "Service Unavailable", json: false })).fetch });
    const fromPage = await rejection(page.x());
    assert.equal(fromPage.message, "503 Service Unavailable", "a proxy's error page has no words either");
    assert.equal(fromPage.status, 503);
});

test("fallback gives the words when the answer has none, told the name, the response and whether it was JSON", async () => {
    const asked = [];
    const fallback = (info) => { asked.push(info); return `no words for ${info.name} (${info.json ? "json" : "not json"})`; };
    const json = remoteServices(["save"], { fallback, fetch: server(() => ({ status: 500, statusText: "Internal Server Error", body: { detail: 1 } })).fetch });
    assert.equal((await rejection(json.save())).message, "no words for save (json)");
    const page = remoteServices(["save"], { fallback, fetch: server(() => ({ status: 502, statusText: "Bad Gateway", json: false })).fetch });
    assert.equal((await rejection(page.save())).message, "no words for save (not json)");
    assert.deepEqual(asked.map(({ name, json: was, response }) => [name, was, response.status]), [["save", true, 500], ["save", false, 502]]);
});

test("fallback is not asked when the refusal has words of its own", async () => {
    let asked = 0;
    const services = remoteServices(["x"], { fallback: () => { asked += 1; return "fallback"; }, fetch: server(() => ({ status: 403, body: { error: "Not yours." } })).fetch });
    assert.equal((await rejection(services.x())).message, "Not yours.");
    assert.equal(asked, 0);
});

// ---- a 2xx that is not JSON --------------------------------------------------------------------

test("a 2xx whose body is not JSON rejects with a ServiceError of status 502, code response.not-json", async () => {
    const services = remoteServices(["save"], { fetch: server(() => ({ status: 200, statusText: "OK", json: false })).fetch });
    const error = await rejection(services.save({}));
    assert.ok(error instanceof ServiceError);
    assert.equal(error.status, 502);
    assert.equal(error.code, "response.not-json");
    assert.equal(error.message, "200 OK", "the fallback's words, the status line by default");
});

test("a 2xx whose body is not JSON rejects with the fallback's words", async () => {
    const asked = [];
    const services = remoteServices(["save"], {
        fallback: (info) => { asked.push(info.json); return "Sign in to the network first."; },
        fetch: server(() => ({ status: 200, json: false })).fetch,
    });
    const error = await rejection(services.save());
    assert.equal(error.message, "Sign in to the network first.");
    assert.equal(error.code, "response.not-json");
    assert.deepEqual(asked, [false]);
});

// ---- timeouts ----------------------------------------------------------------------------------

// A fetch that never answers, and rejects as a browser's does once its signal aborts.
function hanging(seen) {
    return (url, init) => new Promise((resolve, reject) => {
        seen.push(init);
        init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    });
}

test("a call that takes longer than timeoutMs is aborted and rejects with a 408 ServiceError of code request.timeout", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const seen = [];
    const services = remoteServices(["slow"], { fetch: hanging(seen), timeoutMs: 50 });
    const call = rejection(services.slow());
    await flush();
    t.mock.timers.tick(49);
    await flush();
    assert.equal(seen[0].signal.aborted, false, "not before its time");
    t.mock.timers.tick(1);
    const error = await call;
    assert.ok(error instanceof ServiceError, "the timeout's words, not the abort's");
    assert.equal(error.status, 408);
    assert.equal(error.code, "request.timeout");
    assert.equal(error.message, TIMEOUT_WORDS);
    assert.equal(seen[0].signal.aborted, true, "the request is aborted");
});

test("a call whose body never arrives times out too", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal;
    const fetch = async (url, init) => { signal = init.signal; return { ok: true, status: 200, json: () => new Promise(() => { }) }; };
    const call = rejection(remoteServices(["slow"], { fetch, timeoutMs: 20 }).slow());
    await flush();
    t.mock.timers.tick(20);
    const error = await call;
    assert.equal(error.status, 408);
    assert.equal(error.message, TIMEOUT_WORDS);
    assert.equal(signal.aborted, true);
});

test("timeoutMs is 30 seconds unless given", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const seen = [];
    let settled = false;
    const call = rejection(remoteServices(["slow"], { fetch: hanging(seen) }).slow()).finally(() => { settled = true; });
    await flush();
    t.mock.timers.tick(29_999);
    await flush();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    assert.equal((await call).code, "request.timeout");
});

test("an answer in time cancels the timeout: the request is never aborted afterwards", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal;
    const fetch = async (url, init) => { signal = init.signal; return { ok: true, status: 200, json: async () => ({ ok: 1 }) }; };
    assert.deepEqual(await remoteServices(["fast"], { fetch, timeoutMs: 100 }).fast(), { ok: 1 });
    t.mock.timers.tick(1000);
    assert.equal(signal.aborted, false);
});

test("a call that fails on the network rejects with fetch's own error, and cancels its timeout", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal;
    const failure = new TypeError("Failed to fetch");
    const fetch = async (url, init) => { signal = init.signal; throw failure; };
    assert.equal(await rejection(remoteServices(["x"], { fetch, timeoutMs: 100 }).x()), failure);
    t.mock.timers.tick(1000);
    assert.equal(signal.aborted, false, "no timer was left to fire");
});

test("timeoutMs 0 sets no limit and sends no signal", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let release;
    let init;
    const fetch = (url, given) => { init = given; return new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: async () => "late" }); }); };
    const call = remoteServices(["late"], { fetch, timeoutMs: 0 }).late();
    await flush();
    t.mock.timers.tick(2 ** 31 - 1);
    await flush();
    assert.equal("signal" in init, false);
    release();
    assert.equal(await call, "late");
});

test("without AbortController a call still times out, and sends no signal", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const seen = [];
    await withGlobals({ AbortController: undefined }, async () => {
        const call = rejection(remoteServices(["slow"], { fetch: hanging(seen), timeoutMs: 10 }).slow());
        await flush();
        t.mock.timers.tick(10);
        const error = await call;
        assert.equal(error.status, 408);
        assert.equal(error.code, "request.timeout");
    });
    assert.equal("signal" in seen[0], false);
});

test("timeoutMs is refused with a TypeError unless a whole number of milliseconds from 0 to 2^31 - 1", () => {
    const shown = [[-1, "-1"], [1.5, "1.5"], ["10", '"10"'], [NaN, "NaN"], [2 ** 31, "2147483648"], [null, "null"], [Infinity, "Infinity"], [{}, "[object Object]"]];
    for (const [wrong, words] of shown) {
        assert.throws(() => remoteServices(["a"], { timeoutMs: wrong }), (error) => error instanceof TypeError
            && error.message === `remoteServices: timeoutMs is a whole number of milliseconds from 0 (no limit) to 2147483647, not ${words}`, String(wrong));
    }
    for (const right of [0, 1, 2 ** 31 - 1]) assert.doesNotThrow(() => remoteServices(["a"], { timeoutMs: right }));
});

// ---- diff --------------------------------------------------------------------------------------

test("remote-services re-exports live-protocol's diff, the one function", () => {
    assert.equal(reexported, diff);
    assert.deepEqual(reexported({ a: 1 }, { a: 2 }), { set: [["a", 2]], del: [] });
});
