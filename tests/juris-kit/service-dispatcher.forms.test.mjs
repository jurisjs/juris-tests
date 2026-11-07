// serviceDispatcher's forms option, the no-JavaScript path: which form posts it takes (a name in
// `allow`, from a page on the same host, within maxBody), what the service is called with (the
// fields as one object, the request's context), the 303 to forms.redirect with what the caller may
// read, a redirect that is not a path on this site, and an upload cut short.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import { serviceDispatcher } from "juris-kit/server/service-dispatcher.js";
import { callKind } from "juris/live-protocol.js";
import { ServiceError } from "juris/errors.js";
import { serve, request, until, flush, fakeRequest, FakeResponse } from "../support/service-dispatcher-harness.mjs";

const FORM = "application/x-www-form-urlencoded";

async function withServer(services, options, run) {
    const handler = serviceDispatcher(services, "/api", options);
    const host = await serve(handler);
    try {
        await run(host, handler);
    } finally {
        handler.close();
        await host.close();
    }
}
const postForm = (host, name, body, headers = { origin: host.origin }) =>
    request(host.port, { path: `/api/${name}`, headers: { "content-type": FORM, ...headers }, body });

// A form post made by hand, for a dispatcher with no server.
const formRequest = (name, body, headers = {}) =>
    fakeRequest({ url: `/api/${name}`, headers: { "content-type": FORM, host: "shop.example", origin: "https://shop.example", ...headers }, body });

// ---- what it takes ---------------------------------------------------------------------------------

test("a form posted from this site runs the service with its fields as one object, and answers 303 to redirect", async () => {
    const seen = [];
    const told = [];
    await withServer({ signup(fields) { seen.push({ fields, kind: callKind(this), user: this.user }); return { id: 1 }; } }, {
        context: (req) => ({ user: req.headers["x-user"] }),
        forms: { allow: ["signup"], redirect: (name, outcome) => { told.push({ name, ...outcome, req: outcome.req.url }); return "/welcome?ok=1"; } },
    }, async (host) => {
        const answer = await postForm(host, "signup", "email=ada%40example.com&name=Ada+L&empty=", { origin: host.origin, "x-user": "ada" });
        assert.equal(answer.status, 303);
        assert.equal(answer.headers.location, "/welcome?ok=1");
        assert.equal(answer.text, "");
        assert.deepEqual(host.failures, []);
    });
    assert.deepEqual(seen, [{ fields: { email: "ada@example.com", name: "Ada L", empty: "" }, kind: "direct", user: "ada" }]);
    assert.deepEqual(told, [{ name: "signup", ok: true, message: null, status: 200, result: { id: 1 }, req: "/api/signup" }]);
});

test("the Referer stands in for an Origin a browser did not send", async () => {
    let ran = 0;
    await withServer({ f: () => { ran += 1; } }, { forms: { allow: ["f"], redirect: () => "/done" } }, async (host) => {
        const answer = await postForm(host, "f", "a=1", { referer: `${host.origin}/signup/page?x=1` });
        assert.equal(answer.status, 303);
        assert.equal(answer.headers.location, "/done");
    });
    assert.equal(ran, 1);
});

test("a form from no page, another host, or an origin no URL can be made of is a 403 with nothing run", async () => {
    let ran = 0;
    await withServer({ f: () => { ran += 1; } }, { forms: { allow: ["f"], redirect: () => "/done" } }, async (host) => {
        for (const headers of [{}, { origin: "https://elsewhere.example" }, { origin: "null" }, { referer: "https://elsewhere.example/page" },
            { origin: "", referer: host.origin }, { origin: `http://127.0.0.1:${host.port + 1}` }]) {
            const answer = await postForm(host, "f", "a=1", headers);
            assert.equal(answer.status, 403, JSON.stringify(headers));
            assert.equal(answer.text, "");
            assert.equal(answer.headers.location, undefined);
        }
        assert.deepEqual(host.failures, []);
    });
    assert.equal(ran, 0);
});

test("a request with no Host header names no host a form could come from", async () => {
    let ran = 0;
    const handler = serviceDispatcher({ f: () => { ran += 1; } }, "/api", { forms: { allow: ["f"], redirect: () => "/" } });
    const res = new FakeResponse();
    await handler(fakeRequest({ url: "/api/f", headers: { "content-type": FORM, origin: "https://shop.example" }, body: "a=1" }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(ran, 0);
    handler.close();
});

test("a form post to a name not in allow, or with no forms option, is JSON-only: 415", async () => {
    let ran = 0;
    const services = { f: () => { ran += 1; }, g: () => { ran += 1; } };
    await withServer(services, { forms: { allow: ["f"], redirect: () => "/done" } }, async (host) => {
        const answer = await postForm(host, "g", "a=1");
        assert.equal(answer.status, 415);
        assert.deepEqual(answer.json, { error: "bad request: content-type must be application/json" });
    });
    await withServer(services, {}, async (host) => {
        assert.equal((await postForm(host, "f", "a=1")).status, 415);
    });
    assert.equal(ran, 0);
});

test("a post with no content type to a name forms allow is JSON-only: 415", async () => {
    let ran = 0;
    await withServer({ f: () => { ran += 1; } }, { forms: { allow: ["f"], redirect: () => "/done" } }, async (host) => {
        const answer = await request(host.port, { path: "/api/f", headers: { origin: host.origin }, body: "a=1" });
        assert.equal(answer.status, 415);
        assert.deepEqual(answer.json, { error: "bad request: content-type must be application/json" });
    });
    assert.equal(ran, 0);
});

test("the form type is read without its parameters, and an allowed name still takes JSON", async () => {
    const seen = [];
    await withServer({ f: (x) => { seen.push(x); return "json"; } }, { forms: { allow: ["f"], redirect: () => "/done" } }, async (host) => {
        const form = await postForm(host, "f", "a=1", { origin: host.origin, "content-type": "Application/X-WWW-Form-URLEncoded; charset=UTF-8" });
        assert.equal(form.status, 303);
        const json = await request(host.port, { path: "/api/f", headers: { "content-type": "application/json", origin: host.origin }, body: '["x"]' });
        assert.equal(json.status, 200);
        assert.equal(json.json, "json");
    });
    assert.deepEqual(seen, [{ a: "1" }, "x"]);
});

// ---- maxBody ------------------------------------------------------------------------------------------

test("a form over forms.maxBody is a 413 that closes the connection, with nothing run", async () => {
    let ran = 0;
    await withServer({ f: () => { ran += 1; } }, { forms: { allow: ["f"], maxBody: 8, redirect: () => "/done" } }, async (host) => {
        const answer = await postForm(host, "f", "a=12345678901234567890");
        assert.equal(answer.status, 413);
        assert.equal(answer.headers.connection, "close");
        assert.equal(answer.text, "");
        const at = await postForm(host, "f", "a=123456");
        assert.equal(at.status, 303);
    });
    assert.equal(ran, 1);
});

test("forms.maxBody is 16384 bytes unless told, and 0 takes only an empty form", async () => {
    const seen = [];
    const handler = serviceDispatcher({ f: (fields) => { seen.push(Object.keys(fields).length); } }, "/api", { forms: { allow: ["f"], redirect: () => "/" } });
    const at = new FakeResponse();
    await handler(formRequest("f", `a=${"x".repeat(16382)}`), at);
    assert.equal(at.statusCode, 303);
    const over = new FakeResponse();
    await handler(formRequest("f", `a=${"x".repeat(16383)}`), over);
    assert.equal(over.statusCode, 413);
    assert.equal(over.headers.connection, "close");
    handler.close();
    const none = serviceDispatcher({ f: (fields) => { seen.push(Object.keys(fields).length); } }, "/api", { forms: { allow: ["f"], maxBody: 0, redirect: () => "/" } });
    const empty = new FakeResponse();
    await none(formRequest("f", ""), empty);
    assert.equal(empty.statusCode, 303);
    const one = new FakeResponse();
    await none(formRequest("f", "a"), one);
    assert.equal(one.statusCode, 413);
    none.close();
    assert.deepEqual(seen, [1, 0]);
});

// ---- what redirect is told ---------------------------------------------------------------------------

test("a refusal the caller may read is told to redirect with its words, status and fields", async () => {
    const told = [];
    const errors = [];
    const handler = serviceDispatcher({ f: () => { throw new ServiceError("Give the post a title.", { status: 422, field: "title", code: "title.missing" }); } }, "/api", {
        forms: { allow: ["f"], redirect: (name, { req, ...outcome }) => { told.push(outcome); return "/edit?error=1"; } },
        onError: (error) => errors.push(error),
    });
    const res = new FakeResponse();
    await handler(formRequest("f", "title="), res);
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, "/edit?error=1");
    assert.deepEqual(told, [{ ok: false, message: "Give the post a title.", status: 422, fields: { title: "Give the post a title." } }]);
    assert.deepEqual(errors, []);
    handler.close();
});

test("a refusal the caller may not read is told with a null message, and its words go to onError", async () => {
    const told = [];
    const errors = [];
    const failure = new Error("relation \"posts\" does not exist");
    const handler = serviceDispatcher({ f: () => { throw failure; } }, "/api", {
        forms: { allow: ["f"], redirect: (name, { req, ...outcome }) => { told.push(outcome); return "/sorry"; } },
        onError: (error, name, args) => errors.push([error, name, args]),
    });
    const res = new FakeResponse();
    await handler(formRequest("f", "a=1"), res);
    assert.equal(res.headers.location, "/sorry");
    assert.deepEqual(told, [{ ok: false, message: null, status: 400 }]);
    assert.deepEqual(errors, [[failure, "f", [{ a: "1" }]]]);
    handler.close();
});

test("a context that throws on the form path is a refusal told to redirect, with nothing run", async () => {
    const told = [];
    let ran = 0;
    const handler = serviceDispatcher({ f: () => { ran += 1; } }, "/api", {
        context: () => { throw new ServiceError("Your session has ended.", { status: 401 }); },
        forms: { allow: ["f"], redirect: (name, { req, ...outcome }) => { told.push(outcome); return "/login"; } },
    });
    const res = new FakeResponse();
    await handler(formRequest("f", "a=1"), res);
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, "/login");
    assert.deepEqual(told, [{ ok: false, message: "Your session has ended.", status: 401 }]);
    assert.equal(ran, 0);
    handler.close();
});

test("a form call to a declared query asks authorize with the request, as a direct call", async () => {
    const asked = [];
    const told = [];
    const handler = serviceDispatcher({ q: (fields) => fields.id }, "/api", {
        live: { queries: ["q"], authorize: (name, args, info) => { asked.push({ name, args, url: info.req.url, direct: info.direct }); return args[0].id === "1"; } },
        forms: { allow: ["q"], redirect: (name, { req, ...outcome }) => { told.push(outcome); return "/"; } },
    });
    await handler(formRequest("q", "id=1"), new FakeResponse());
    await handler(formRequest("q", "id=2"), new FakeResponse());
    assert.deepEqual(asked, [
        { name: "q", args: [{ id: "1" }], url: "/api/q", direct: true },
        { name: "q", args: [{ id: "2" }], url: "/api/q", direct: true },
    ]);
    assert.deepEqual(told, [{ ok: true, message: null, status: 200, result: "1" }, { ok: false, message: "not allowed", status: 403 }]);
    handler.close();
});

test("a form call that succeeded runs its touches", async () => {
    const told = [];
    const handler = serviceDispatcher({ q: () => 1, f: () => 1 }, "/api", {
        live: { queries: ["q"], public: true, touches: { f: ["q"] }, onInvalidate: (targets) => told.push(targets) },
        forms: { allow: ["f"], redirect: () => "/" },
    });
    await handler(formRequest("f", "a=1"), new FakeResponse());
    await flush();
    assert.deepEqual(told, [["q"]]);
    handler.close();
});

// ---- a redirect that is not a path on this site -------------------------------------------------------

test("a redirect that is not a path on this site fails the request instead of sending the browser there", async () => {
    for (const location of ["https://elsewhere.example/", "//elsewhere.example/", "/\\elsewhere.example/", "/\t/elsewhere.example/", "relative", "", 5, undefined]) {
        let ran = 0;
        const handler = serviceDispatcher({ f: () => { ran += 1; } }, "/api", { forms: { allow: ["f"], redirect: () => location } });
        const res = new FakeResponse();
        await assert.rejects(handler(formRequest("f", "a=1"), res), {
            name: "TypeError",
            message: `serviceDispatcher: forms.redirect answered ${JSON.stringify(location)} for "f": it must be a path on this site`,
        }, JSON.stringify(location));
        assert.equal(res.headersSent, false, "no 303 went out");
        assert.equal(res.headers.location, undefined);
        assert.equal(ran, 1, "the service had run; only the answer failed");
        handler.close();
    }
});

// ---- an upload cut short ------------------------------------------------------------------------------

// A form request whose body breaks off: reading it fails.
const brokenRequest = () => {
    const req = new Readable({ read() { this.destroy(new Error("aborted")); } });
    return Object.assign(req, {
        method: "POST", url: "/api/f", complete: false, socket: {},
        headers: { "content-type": FORM, host: "shop.example", origin: "https://shop.example" },
    });
};

test("an upload that ends before its body is answered 400 if anyone is left to answer, with nothing run", async () => {
    let ran = 0;
    const handler = serviceDispatcher({ f: () => { ran += 1; } }, "/api", { forms: { allow: ["f"], redirect: () => "/" } });
    const res = new FakeResponse();
    assert.equal(await handler(brokenRequest(), res), true);
    assert.equal(res.statusCode, 400);
    assert.equal(res.writableEnded, true);
    const gone = new FakeResponse();
    gone.destroyed = true;
    assert.equal(await handler(brokenRequest(), gone), true);
    assert.equal(gone.headersSent, false, "nobody to answer");
    const answered = new FakeResponse();
    answered.headersSent = true;
    await handler(brokenRequest(), answered);
    assert.equal(answered.writableEnded, false, "an answer already begun is not written over");
    assert.equal(ran, 0);
    handler.close();
});

test("a browser that closes mid-upload runs nothing and nothing rejects out of the dispatcher", async () => {
    let ran = 0;
    await withServer({ f: () => { ran += 1; } }, { forms: { allow: ["f"], redirect: () => "/done" } }, async (host) => {
        const req = http.request({
            port: host.port, host: "127.0.0.1", path: "/api/f", method: "POST", agent: false,
            headers: { "content-type": FORM, origin: host.origin, "content-length": 1000 },
        });
        req.on("error", () => { });
        req.write("a=1&b=");
        await new Promise((resolve) => setTimeout(resolve, 20));
        req.destroy();
        assert.ok(await until(() => req.destroyed));
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(host.failures, []);
    });
    assert.equal(ran, 0);
});
