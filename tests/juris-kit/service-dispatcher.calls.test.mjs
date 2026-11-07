// serviceDispatcher's ordinary service calls: which requests it takes (POST under its base, JSON
// only, a body of arguments within maxBody), what a service is called with (its arguments, and a
// context marked as a direct call), what a refusal answers (the status, the words exposeError lets
// out, fields, field and code), authorize on a direct call to a declared query, handler.invoke, and
// the touches a call that succeeded runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { serviceDispatcher, ALL } from "juris-kit/server/service-dispatcher.js";
import { CALL_KIND, callKind } from "juris/live-protocol.js";
import { ServiceError } from "juris/errors.js";
import { serve, request, call, until, flush, deferred, driver, fakeRequest, FakeResponse } from "../support/service-dispatcher-harness.mjs";

// A dispatcher behind a real server, closed after the test whatever happens.
async function withServer(services, options, run, base = "/api") {
    const handler = serviceDispatcher(services, base, options);
    const host = await serve(handler);
    try {
        await run(host, handler);
        assert.deepEqual(host.failures, [], "nothing rejected out of the dispatcher");
    } finally {
        handler.close();
        await host.close();
    }
}

// ---- which requests are its own -------------------------------------------------------------------

test("a request outside the base path is not handled, and nothing is written", async () => {
    const handler = serviceDispatcher({ a: () => 1 }, "/api");
    for (const url of ["/", "/api", "/apia", "/other/a", "/API/a"]) {
        const res = new FakeResponse();
        assert.equal(await handler(fakeRequest({ url }), res), false, url);
        assert.equal(res.headersSent, false, url);
    }
    handler.close();
});

test("a base other than /api is the prefix the services answer under", async () => {
    await withServer({ a: () => "from rpc" }, {}, async (host) => {
        const answer = await call(host.port, "a", [], { base: "/rpc" });
        assert.equal(answer.status, 200);
        assert.equal(answer.json, "from rpc");
        const outside = await call(host.port, "a", []);
        assert.equal(outside.headers["x-not-handled"], "1", "/api/a is not the dispatcher's");
    }, "/rpc");
});

test("a service name that is not valid percent-encoding is a 400, never a throw", async () => {
    await withServer({ a: () => 1 }, {}, async (host) => {
        const answer = await request(host.port, { path: "/api/%E0%A4%A", headers: { "content-type": "application/json" }, body: "[]" });
        assert.equal(answer.status, 400);
        assert.deepEqual(answer.json, { error: "bad service name" });
        assert.equal(answer.headers["content-type"], "application/json");
        assert.equal(answer.headers["x-content-type-options"], "nosniff");
    });
});

test("a percent-encoded name is decoded, and the query string is not part of it", async () => {
    await withServer({ "a b": () => "spaced", plain: () => "plain" }, {}, async (host) => {
        assert.equal((await call(host.port, "a%20b", [])).json, "spaced");
        assert.equal((await call(host.port, "plain?x=1", [])).json, "plain");
    });
});

test("a service takes POST only: anything else is a 405 that says Allow: POST", async () => {
    let ran = 0;
    await withServer({ a: () => { ran += 1; } }, {}, async (host) => {
        // RFC 9110 (15.5.6): every 405 carries Allow, the methods the address takes. Under the base that
        // is POST alone, for a name no service has as well. OPTIONS is refused the same way.
        for (const method of ["GET", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
            for (const path of ["/api/a", "/api/nope"]) {
                const answer = await request(host.port, { method, path });
                assert.equal(answer.status, 405, `${method} ${path}`);
                assert.equal(answer.headers.allow, "POST", `${method} ${path}`);
                assert.deepEqual(answer.json, { error: "services take POST" });
            }
        }
        // HEAD is answered as GET is, without the body.
        const head = await request(host.port, { method: "HEAD", path: "/api/a" });
        assert.equal(head.status, 405);
        assert.equal(head.headers.allow, "POST");
        assert.equal(head.text, "");
        assert.equal(ran, 0);
        // Only a 405 says it.
        assert.equal((await call(host.port, "a", [])).headers.allow, undefined);
    });
});

test("a refusal a service makes with 405 says Allow: POST too", async () => {
    const services = { a: () => { throw new ServiceError("Not like that.", { status: 405 }); } };
    await withServer(services, {}, async (host) => {
        const answer = await call(host.port, "a", []);
        assert.equal(answer.status, 405);
        assert.equal(answer.headers.allow, "POST");
        assert.deepEqual(answer.json, { error: "Not like that." });
    });
});

test("a name the dispatcher does not answer to is a 404 naming it", async () => {
    await withServer({ a: () => 1 }, {}, async (host) => {
        const answer = await call(host.port, "nope", []);
        assert.equal(answer.status, 404);
        assert.deepEqual(answer.json, { error: 'unknown service "nope"' });
    });
});

test("without live queries, events and _live are ordinary names that no service has", async () => {
    await withServer({ a: () => 1 }, {}, async (host) => {
        assert.deepEqual((await call(host.port, "events", [])).json, { error: 'unknown service "events"' });
        assert.equal((await call(host.port, "_live", { client: "x" })).status, 404);
        const stream = await request(host.port, { method: "GET", path: "/api/events" });
        assert.equal(stream.status, 405);
        assert.equal(stream.headers.allow, "POST");
    });
});

// ---- JSON only, within maxBody -----------------------------------------------------------------------

test("a POST that is not application/json is a 415, and the service is not run", async () => {
    let ran = 0;
    await withServer({ a: () => { ran += 1; } }, {}, async (host) => {
        for (const type of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
            const answer = await request(host.port, { path: "/api/a", headers: type ? { "content-type": type } : {}, body: "[]" });
            assert.equal(answer.status, 415, String(type));
            assert.deepEqual(answer.json, { error: "bad request: content-type must be application/json" });
        }
        assert.equal(ran, 0);
    });
});

test("the JSON type is read without its parameters and whatever its case", async () => {
    await withServer({ a: (x) => x * 2 }, {}, async (host) => {
        const answer = await request(host.port, { path: "/api/a", headers: { "content-type": "Application/JSON ; charset=utf-8" }, body: "[21]" });
        assert.equal(answer.status, 200);
        assert.equal(answer.json, 42);
    });
});

test("a body that is not JSON, or not an array, is a 400", async () => {
    let ran = 0;
    await withServer({ a: () => { ran += 1; } }, {}, async (host) => {
        const broken = await call(host.port, "a", "[1,");
        assert.equal(broken.status, 400);
        assert.match(broken.json.error, /^bad request: /);
        const object = await call(host.port, "a", { first: 1 });
        assert.equal(object.status, 400);
        assert.deepEqual(object.json, { error: "bad request: body must be a JSON array of arguments" });
        assert.equal((await call(host.port, "a", "7")).status, 400);
        assert.equal(ran, 0);
    });
});

test("the body's arguments are the service's, and an empty body or null is no arguments", async () => {
    const seen = [];
    await withServer({ a: (...args) => { seen.push(args); return { got: args.length }; } }, {}, async (host) => {
        const answer = await call(host.port, "a", [1, "two", { three: [3] }, null]);
        assert.equal(answer.status, 200);
        assert.deepEqual(answer.json, { got: 4 });
        assert.equal(answer.headers["content-type"], "application/json");
        assert.equal(answer.headers["x-content-type-options"], "nosniff");
        await call(host.port, "a", undefined);
        await call(host.port, "a", "null");
        assert.deepEqual(seen, [[1, "two", { three: [3] }, null], [], []]);
    });
});

test("an async service is awaited, and a result of undefined is sent as null", async () => {
    await withServer({ later: async () => { await flush(1); return [1, 2]; }, nothing: () => undefined }, {}, async (host) => {
        assert.deepEqual((await call(host.port, "later", [])).json, [1, 2]);
        const empty = await call(host.port, "nothing", []);
        assert.equal(empty.status, 200);
        assert.equal(empty.text, "null");
    });
});

test("a body over maxBody is a 413 naming the limit, and one at it is taken", async () => {
    let ran = 0;
    await withServer({ a: (s) => { ran += 1; return s.length; } }, { maxBody: 10 }, async (host) => {
        const at = await call(host.port, "a", '["123456"]');
        assert.equal(at.status, 200);
        assert.equal(at.json, 6);
        const over = await call(host.port, "a", '["1234567"]');
        assert.equal(over.status, 413);
        assert.deepEqual(over.json, { error: "bad request: body larger than 10 bytes" });
        assert.equal(ran, 1);
    });
});

test("a 415 answered while the body is still arriving reads the rest first and says connection: close", async () => {
    await withServer({ a: () => 1 }, {}, async (host) => {
        const answer = await new Promise((resolve, reject) => {
            const req = http.request({ host: "127.0.0.1", port: host.port, path: "/api/a", method: "POST", agent: false, headers: { "content-type": "text/plain", "content-length": 20 } });
            req.on("error", reject);
            req.on("response", (res) => {
                let text = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => { text += chunk; });
                res.on("end", () => resolve({ status: res.statusCode, connection: res.headers.connection, text }));
            });
            req.write("0123456789");
            setTimeout(() => req.end("0123456789"), 20);
        });
        assert.equal(answer.status, 415);
        assert.equal(answer.connection, "close");
        assert.deepEqual(JSON.parse(answer.text), { error: "bad request: content-type must be application/json" });
    });
});

test("a refusal made once the body has arrived whole does not close the connection", async () => {
    const handler = serviceDispatcher({ a: () => 1 }, "/api", { maxBody: 2 });
    const res = new FakeResponse();
    await handler(fakeRequest({ url: "/api/a", headers: { "content-type": "application/json" }, body: "[1,2,3]", complete: true }), res);
    assert.equal(res.statusCode, 413);
    assert.equal(res.headers.connection, undefined);
    const early = new FakeResponse();
    await handler(fakeRequest({ url: "/api/a", headers: { "content-type": "text/plain" }, body: "[1]", complete: false }), early);
    assert.equal(early.statusCode, 415);
    assert.equal(early.headers.connection, "close");
    handler.close();
});

// ---- the context a service is called with ------------------------------------------------------------

test("with no context option a service's this is the dispatcher's own: frozen, a direct call, nothing else", async () => {
    let seen;
    await withServer({ a() { seen = this; return 1; } }, {}, async (host) => {
        await call(host.port, "a", []);
        assert.equal(callKind(seen), "direct");
        assert.ok(Object.isFrozen(seen));
        assert.deepEqual(Reflect.ownKeys(seen), [CALL_KIND]);
    });
});

test("the app's context is built from the request and response, and marked as a direct call in place", async () => {
    let seen;
    let made;
    await withServer({ a() { seen = this; return this.user; } }, {
        context: (req, res) => {
            res.setHeader("x-context", "built");
            made = { user: req.headers["x-user"], path: req.url };
            return made;
        },
    }, async (host) => {
        const answer = await call(host.port, "a", [], { headers: { "x-user": "ada" } });
        assert.equal(answer.json, "ada");
        assert.equal(answer.headers["x-context"], "built", "the context was handed the response");
        assert.equal(seen, made, "marked in place: the same object");
        assert.equal(seen.path, "/api/a");
        assert.equal(callKind(seen), "direct");
        assert.ok(Object.hasOwn(seen, CALL_KIND), "the mark is its own");
    });
});

test("a context that is frozen, sealed or claims another kind is wrapped, inheriting its fields", async () => {
    const seen = [];
    const contexts = [
        Object.freeze({ user: "frozen" }),
        Object.preventExtensions({ user: "sealed" }),
        { user: "claims live", [CALL_KIND]: "live" },
        Object.freeze({ user: "frozen live", [CALL_KIND]: "live" }),
    ];
    let next = 0;
    await withServer({ a() { seen.push(this); return this.user; } }, { context: () => contexts[next++] }, async (host) => {
        for (const context of contexts) assert.equal((await call(host.port, "a", [])).json, context.user);
    });
    seen.forEach((value, i) => {
        assert.notEqual(value, contexts[i]);
        assert.equal(Object.getPrototypeOf(value), contexts[i]);
        assert.equal(callKind(value), "direct", contexts[i].user);
    });
    assert.equal(contexts[2][CALL_KIND], "live", "the app's own object is left as it was");
});

test("a context already marked direct is used as it is, and one that inherits the mark is marked itself", async () => {
    const own = { user: "own", [CALL_KIND]: "direct" };
    const inherits = Object.create({ [CALL_KIND]: "direct" });
    const seen = [];
    let next = 0;
    await withServer({ a() { seen.push(this); return null; } }, { context: () => [own, inherits][next++] }, async (host) => {
        await call(host.port, "a", []);
        await call(host.port, "a", []);
    });
    assert.equal(seen[0], own);
    assert.equal(seen[1], inherits);
    assert.ok(Object.hasOwn(inherits, CALL_KIND));
});

test("a context that is a function is marked too; one that returns nothing or a primitive gets the dispatcher's own", async () => {
    const fn = function ctx() { };
    fn.user = "fn";
    const results = [fn, undefined, null, 7, "text"];
    const seen = [];
    let next = 0;
    await withServer({ a() { seen.push(this); return null; } }, { context: () => results[next++] }, async (host) => {
        for (let i = 0; i < results.length; i++) await call(host.port, "a", []);
    });
    assert.equal(seen[0], fn);
    assert.equal(callKind(fn), "direct");
    for (const value of seen.slice(1)) {
        assert.ok(Object.isFrozen(value));
        assert.deepEqual(Reflect.ownKeys(value), [CALL_KIND]);
        assert.equal(callKind(value), "direct");
    }
});

test("a context that throws is a refusal like a service's, with its own status and words when they may be read", async () => {
    const errors = [];
    let mode = "service-error";
    let ran = 0;
    await withServer({ a: () => { ran += 1; } }, {
        context: () => {
            if (mode === "service-error") throw new ServiceError("sign in first", { status: 401, code: "auth.required" });
            throw new Error("session store down");
        },
        onError: (error, name, args) => errors.push({ message: error.message, name, args }),
    }, async (host) => {
        const shown = await call(host.port, "a", [1]);
        assert.equal(shown.status, 401);
        assert.deepEqual(shown.json, { error: "sign in first", code: "auth.required" });
        mode = "plain";
        const hidden = await call(host.port, "a", [2]);
        assert.equal(hidden.status, 400);
        assert.deepEqual(hidden.json, { error: "request failed" });
    });
    assert.equal(ran, 0);
    assert.deepEqual(errors, [{ message: "session store down", name: "a", args: [2] }]);
});

// ---- a 401's challenge -----------------------------------------------------------------------------------

// How a shop's callers sign in: a session cookie, from its own page. A scheme no browser knows, so none
// opens a password dialog for it.
const SIGN_IN = 'Cookie realm="shop", sign-in="/login"';
const signedOut = (challenge) => {
    const error = new ServiceError("Sign in first.", { status: 401, code: "auth.required" });
    error.challenge = challenge;
    return error;
};

test("a 401 refusal sends its error's challenge as WWW-Authenticate, as RFC 9110 has every 401 do", async () => {
    let context = () => ({});
    const services = {
        cart: () => { throw signedOut(SIGN_IN); },
        // A challenge goes out with a 401 alone.
        stock: () => { throw Object.assign(new ServiceError("Not yours.", { status: 403 }), { challenge: SIGN_IN }); },
        // None given, none made up: how an app's callers sign in is the app's to say.
        bare: () => { throw new ServiceError("Sign in first.", { status: 401 }); },
        price: () => 3,
    };
    await withServer(services, { context: (req) => context(req) }, async (host, handler) => {
        const refused = await call(host.port, "cart", []);
        assert.equal(refused.status, 401);
        assert.equal(refused.headers["www-authenticate"], SIGN_IN);
        assert.deepEqual(refused.json, { error: "Sign in first.", code: "auth.required" });
        // invoke answers what a JSON caller reads: the challenge is the HTTP answer's alone.
        assert.deepEqual(await handler.invoke("cart", []), {
            ok: false,
            status: 401,
            error: "Sign in first.",
            code: "auth.required",
        });
        const other = await call(host.port, "stock", []);
        assert.deepEqual([other.status, other.headers["www-authenticate"]], [403, undefined]);
        const bare = await call(host.port, "bare", []);
        assert.deepEqual([bare.status, bare.headers["www-authenticate"]], [401, undefined]);
        assert.equal((await call(host.port, "price", [])).headers["www-authenticate"], undefined);
        // A context that refuses with 401 sends its challenge the same way.
        context = () => { throw signedOut('Bearer realm="shop"'); };
        const early = await call(host.port, "price", []);
        assert.equal(early.status, 401);
        assert.equal(early.headers["www-authenticate"], 'Bearer realm="shop"');
    });
});

test("a challenge that is not one fails the request, and no 401 goes out without it", async () => {
    const wrong = ["", " Cookie", "Cookie\r\nSet-Cookie: session=stolen", 'Cookie realm="café"', "Cookie\trealm=x", 5, {}];
    for (const challenge of wrong) {
        const handler = serviceDispatcher({ cart: () => { throw signedOut(challenge); } }, "/api");
        const res = new FakeResponse();
        const req = fakeRequest({ url: "/api/cart", headers: { "content-type": "application/json" }, body: "[]" });
        await assert.rejects(handler(req, res), {
            name: "TypeError",
            message: `serviceDispatcher: "cart" refused with 401 and the challenge ${JSON.stringify(challenge)}: `
                + "a challenge is an auth-scheme, then its parameters (RFC 9110, 11.6.1)",
        }, JSON.stringify(challenge));
        assert.equal(res.headersSent, false, "nothing went out");
        assert.deepEqual(res.headers, {});
        handler.close();
    }
    // Undefined and null are no challenge at all.
    for (const challenge of [undefined, null]) {
        await withServer({ cart: () => { throw signedOut(challenge); } }, {}, async (host) => {
            const answer = await call(host.port, "cart", []);
            assert.deepEqual([answer.status, answer.headers["www-authenticate"]], [401, undefined]);
        });
    }
});

// ---- what a refusal answers ------------------------------------------------------------------------------

test("a plain error is hidden: 400 request failed, and onError hears it with the name and arguments", async () => {
    const errors = [];
    const failure = new Error('duplicate key value violates unique constraint "users_email_key"');
    await withServer({ a: () => { throw failure; } }, { onError: (...args) => errors.push(args) }, async (host) => {
        const answer = await call(host.port, "a", ["x@example.com"]);
        assert.equal(answer.status, 400);
        assert.deepEqual(answer.json, { error: "request failed" });
    });
    assert.deepEqual(errors, [[failure, "a", ["x@example.com"]]]);
});

test("a ServiceError's words, status and code reach the caller, and onError is not told", async () => {
    const errors = [];
    await withServer({ a: () => { throw new ServiceError("That name is taken.", { status: 409, code: "name.taken" }); } }, { onError: (...args) => errors.push(args) }, async (host) => {
        const answer = await call(host.port, "a", []);
        assert.equal(answer.status, 409);
        assert.deepEqual(answer.json, { error: "That name is taken.", code: "name.taken" });
    });
    assert.deepEqual(errors, []);
});

test("a hidden error's code is not sent, and an exposed error's code that is not a string is not either", async () => {
    await withServer({
        hidden: () => { throw Object.assign(new Error("ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" }); },
        numeric: () => { throw Object.assign(new Error("Too many."), { expose: true, code: 42, status: 429 }); },
    }, {}, async (host) => {
        assert.deepEqual((await call(host.port, "hidden", [])).json, { error: "request failed" });
        const numeric = await call(host.port, "numeric", []);
        assert.equal(numeric.status, 429);
        assert.deepEqual(numeric.json, { error: "Too many." });
    });
});

test("a refusal's status is its error's when that is an HTTP error status Node knows, and 500 otherwise", async () => {
    const thrower = (status) => () => { throw Object.assign(new Error("no"), { status }); };
    await withServer({ s422: thrower(422), s503: thrower(503), s404: thrower(404), s999: thrower(999), s302: thrower(302),
        s599: thrower(599), sText: thrower("404"), sFloat: thrower(404.5), sNull: thrower(null) }, {}, async (host) => {
        const expected = { s422: 422, s503: 503, s404: 404, s999: 500, s302: 500, s599: 500, sText: 500, sFloat: 500, sNull: 400 };
        for (const [name, status] of Object.entries(expected)) {
            const answer = await call(host.port, name, []);
            assert.equal(answer.status, status, name);
            assert.deepEqual(answer.json, { error: "request failed" }, name);
        }
    });
});

test("a service's fields travel as given, even when its words are hidden", async () => {
    await withServer({ a: () => { throw Object.assign(new Error("check failed"), { fields: { email: "Use a real address.", age: "Too young." } }); } }, {}, async (host) => {
        assert.deepEqual((await call(host.port, "a", [])).json, { error: "request failed", fields: { email: "Use a real address.", age: "Too young." } });
    });
});

test("a refusal naming one field sends it as it is and folds it into fields with the words the caller may read", async () => {
    await withServer({
        alone: () => { throw new ServiceError("Give the post a title.", { field: "title" }); },
        // A plain error carrying `field` folds in what the caller may read: the hidden sentence.
        hidden: () => { throw Object.assign(new Error("column title is null"), { field: "title" }); },
        // The field's own entry in `fields` is kept; one given as null takes the message.
        kept: () => { throw Object.assign(new Error("Fix these."), { expose: true, field: "title", fields: { title: "Too long.", body: "Empty." } }); },
        nulled: () => { throw Object.assign(new Error("Fix the title."), { expose: true, field: "title", fields: { title: null } }); },
        // `fields` that is no object gives way to the one field.
        odd: () => { throw Object.assign(new Error("Fix the title."), { expose: true, field: "title", fields: "title is wrong" }); },
    }, {}, async (host) => {
        assert.deepEqual((await call(host.port, "alone", [])).json, { error: "Give the post a title.", fields: { title: "Give the post a title." }, field: "title" });
        assert.deepEqual((await call(host.port, "hidden", [])).json, { error: "request failed", fields: { title: "request failed" }, field: "title" });
        assert.deepEqual((await call(host.port, "kept", [])).json, { error: "Fix these.", fields: { title: "Too long.", body: "Empty." }, field: "title" });
        assert.deepEqual((await call(host.port, "nulled", [])).json, { error: "Fix the title.", fields: { title: "Fix the title." }, field: "title" });
        assert.deepEqual((await call(host.port, "odd", [])).json, { error: "Fix the title.", fields: { title: "Fix the title." }, field: "title" });
    });
});

test("a field that is empty or not a string names nothing", async () => {
    await withServer({
        empty: () => { throw Object.assign(new Error("No."), { expose: true, field: "", fields: { a: "x" } }); },
        numeric: () => { throw Object.assign(new Error("No."), { expose: true, field: 3 }); },
    }, {}, async (host) => {
        assert.deepEqual((await call(host.port, "empty", [])).json, { error: "No.", fields: { a: "x" } });
        assert.deepEqual((await call(host.port, "numeric", [])).json, { error: "No." });
    });
});

test("options.exposeError decides whose words are read; one that throws or says anything but true hides them", async () => {
    class Shown extends Error { }
    const errors = [];
    await withServer({
        shown: () => { throw new Shown("Shown words."); },
        plain: () => { throw new Error("Hidden words."); },
        truthy: () => { throw Object.assign(new Error("Truthy words."), { yes: 1 }); },
        boom: () => { throw Object.assign(new Error("Boom words."), { boom: true }); },
    }, {
        exposeError: (error) => {
            if (error.boom) throw new Error("the rule broke");
            if (error.yes) return 1;
            return error instanceof Shown;
        },
        onError: (error, name) => errors.push(name),
    }, async (host) => {
        assert.deepEqual((await call(host.port, "shown", [])).json, { error: "Shown words." });
        assert.deepEqual((await call(host.port, "plain", [])).json, { error: "request failed" });
        assert.deepEqual((await call(host.port, "truthy", [])).json, { error: "request failed" });
        assert.deepEqual((await call(host.port, "boom", [])).json, { error: "request failed" });
    });
    assert.deepEqual(errors, ["plain", "truthy", "boom"]);
});

test("a thrown value that is no Error is a hidden 400", async () => {
    const errors = [];
    await withServer({ text: () => { throw "a string"; }, nothing: () => { throw undefined; }, rejected: () => Promise.reject(null) },
        { onError: (error, name) => errors.push([error, name]) }, async (host) => {
            for (const name of ["text", "nothing", "rejected"]) {
                const answer = await call(host.port, name, []);
                assert.equal(answer.status, 400, name);
                assert.deepEqual(answer.json, { error: "request failed" }, name);
            }
        });
    assert.deepEqual(errors, [["a string", "text"], [undefined, "nothing"], [null, "rejected"]]);
});

test("a result JSON cannot carry is a hidden 400 refusal, and onError hears why", async () => {
    const errors = [];
    const cycle = {};
    cycle.self = cycle;
    await withServer({ big: () => 1n, loop: () => cycle }, { onError: (error, name, args) => errors.push({ error, name, args }) }, async (host) => {
        const big = await call(host.port, "big", [5]);
        assert.equal(big.status, 400);
        assert.deepEqual(big.json, { error: "request failed" });
        assert.equal((await call(host.port, "loop", [])).status, 400);
    });
    assert.equal(errors.length, 2);
    assert.ok(errors[0].error instanceof TypeError);
    assert.deepEqual([errors[0].name, errors[0].args], ["big", [5]]);
    assert.equal(errors[1].name, "loop");
});

// ---- authorize on a direct call ------------------------------------------------------------------------------

test("a direct POST to a declared query asks authorize, as the request's context, with the request", async () => {
    const asked = [];
    let allow = true;
    await withServer({ q: (id) => ({ id }) }, {
        context: (req) => ({ user: req.headers["x-user"] }),
        live: { queries: ["q"], authorize(name, args, info) { asked.push({ kind: callKind(this), user: this.user, name, args, url: info.req.url, direct: info.direct }); return allow; } },
    }, async (host) => {
        const allowed = await call(host.port, "q", [7], { headers: { "x-user": "ada" } });
        assert.equal(allowed.status, 200);
        assert.deepEqual(allowed.json, { id: 7 });
        allow = false;
        const refused = await call(host.port, "q", [8], { headers: { "x-user": "bob" } });
        assert.equal(refused.status, 403);
        assert.deepEqual(refused.json, { error: "not allowed" });
    });
    assert.deepEqual(asked, [
        { kind: "direct", user: "ada", name: "q", args: [7], url: "/api/q", direct: true },
        { kind: "direct", user: "bob", name: "q", args: [8], url: "/api/q", direct: true },
    ]);
});

test("an authorize that throws refuses the direct call with a 403 and tells onError", async () => {
    const errors = [];
    let ran = 0;
    const failure = new Error("rules table missing");
    await withServer({ q: () => { ran += 1; } }, {
        live: { queries: ["q"], authorize: () => { throw failure; } },
        onError: (error, where, args) => errors.push([error, where, args]),
    }, async (host) => {
        const answer = await call(host.port, "q", [1]);
        assert.equal(answer.status, 403);
        assert.deepEqual(answer.json, { error: "not allowed" });
    });
    assert.equal(ran, 0);
    assert.deepEqual(errors, [[failure, "live.authorize", [1]]]);
});

test("a direct POST to a name a touches list makes subscribable asks no authorize", async () => {
    let asked = 0;
    await withServer({ q: () => 1, profile: (id) => `profile ${id}`, follow: () => 1 }, {
        live: { queries: ["q"], touches: { follow: ["profile"] }, authorize: () => { asked += 1; return false; } },
    }, async (host) => {
        const answer = await call(host.port, "profile", [3]);
        assert.equal(answer.status, 200);
        assert.equal(answer.json, "profile 3");
        assert.equal(asked, 0);
    });
});

// ---- touches after a call ------------------------------------------------------------------------------------

test("a call that succeeded runs its touches after it has answered; a refusal runs none", async () => {
    const told = [];
    const handler = serviceDispatcher({ q: () => 1, m: (ok) => { if (!ok) throw new Error("no"); return "done"; } }, "/api", {
        live: { queries: ["q"], public: true, touches: { m: ["q"] }, onInvalidate: (targets, info) => told.push({ targets, info, answered: res.writableEnded }) },
        onError: () => { },
    });
    const res = new FakeResponse();
    await handler(fakeRequest({ url: "/api/m", headers: { "content-type": "application/json" }, body: [true] }), res);
    assert.equal(res.json, "done");
    await flush();
    assert.deepEqual(told, [{ targets: ["q"], info: { remote: false }, answered: true }]);
    const refused = new FakeResponse();
    await handler(fakeRequest({ url: "/api/m", headers: { "content-type": "application/json" }, body: [false] }), refused);
    await flush();
    assert.equal(refused.statusCode, 400);
    assert.equal(told.length, 1, "a refusal invalidates nothing");
    handler.close();
});

test("a call whose result cannot be sent still runs its touches", async () => {
    const told = [];
    await withServer({ q: () => 1, m: () => 1n }, {
        live: { queries: ["q"], public: true, touches: { m: ["q"] }, onInvalidate: (targets) => told.push(targets) },
        onError: () => { },
    }, async (host) => {
        assert.equal((await call(host.port, "m", [])).status, 400);
        assert.ok(await until(() => told.length === 1));
        assert.deepEqual(told, [["q"]]);
    });
});

test("a touches function is called as the request's context with the arguments and the result, and may be async", async () => {
    const calls = [];
    const told = [];
    await withServer({ q: () => 1, post: (room, text) => ({ id: 9, room, text }) }, {
        context: (req) => ({ user: req.headers["x-user"] }),
        live: {
            queries: ["q"], public: true,
            touches: { post: async function (room, text, result) { calls.push({ kind: callKind(this), user: this.user, room, text, result }); await flush(1); return { name: "q", args: [room] }; } },
            onInvalidate: (targets) => told.push(targets),
        },
    }, async (host) => {
        await call(host.port, "post", [7, "hi"], { headers: { "x-user": "ada" } });
        assert.ok(await until(() => told.length === 1));
    });
    assert.deepEqual(calls, [{ kind: "direct", user: "ada", room: 7, text: "hi", result: { id: 9, room: 7, text: "hi" } }]);
    assert.deepEqual(told, [[{ name: "q", args: [7] }]], "one target is taken as a list of one");
});

test("a touches function that answers nothing invalidates nothing", async () => {
    const told = [];
    const handler = serviceDispatcher({ q: () => 1, a: () => 1, b: () => 1 }, "/api", {
        live: { queries: ["q"], public: true, touches: { a: () => undefined, b: async () => null }, onInvalidate: (targets) => told.push(targets) },
    });
    assert.deepEqual(await handler.invoke("a", []), { ok: true, result: 1 });
    assert.deepEqual(await handler.invoke("b", []), { ok: true, result: 1 });
    await flush();
    assert.deepEqual(told, []);
    handler.close();
});

test("a touches function that throws or rejects goes to onError as live.touches, never to the caller", async () => {
    const errors = [];
    const thrown = new Error("cannot work out targets");
    const rejected = new Error("async targets failed");
    await withServer({ q: () => 1, a: () => "a", b: () => "b" }, {
        live: { queries: ["q"], public: true, touches: { a: () => { throw thrown; }, b: async () => { throw rejected; } } },
        onError: (error, where, args) => errors.push([error, where, args]),
    }, async (host) => {
        assert.deepEqual((await call(host.port, "a", [1])).json, "a");
        assert.deepEqual((await call(host.port, "b", [2])).json, "b");
        assert.ok(await until(() => errors.length === 2));
    });
    assert.deepEqual(errors, [[thrown, "live.touches", [1]], [rejected, "live.touches", [2]]]);
});

test("a flushAll service invalidates ALL beside its own touches; ALL may be a touches entry itself", async () => {
    const told = [];
    const handler = serviceDispatcher({ q: () => 1, rename: () => 1, avatar: () => 1, purge: () => 1 }, "/api", {
        live: { queries: ["q"], public: true, touches: { rename: ["q"], purge: ALL }, onInvalidate: (targets) => told.push(targets) },
        strict: { flushAll: ["rename", "avatar"] },
    });
    await handler.invoke("rename", []);
    await handler.invoke("avatar", []);
    await handler.invoke("purge", []);
    await flush();
    assert.deepEqual(told, [["q", ALL], [ALL], [ALL]]);
    handler.close();
});

test("a flushAll service with no live layer still succeeds", async () => {
    const handler = serviceDispatcher({ a: () => 5 }, "/api", { strict: { flushAll: ["a"] } });
    assert.deepEqual(await handler.invoke("a", []), { ok: true, result: 5 });
    handler.close();
});

// ---- handler.invoke ------------------------------------------------------------------------------------------

test("invoke runs a service with ctx taken as given and answers what a JSON caller reads", async () => {
    const seen = [];
    const handler = serviceDispatcher({ a(x, y) { seen.push({ self: this, x, y }); return x + y; } }, "/api");
    const ctx = { reason: "job" };
    assert.deepEqual(await handler.invoke("a", [2, 3], ctx), { ok: true, result: 5 });
    assert.equal(seen[0].self, ctx, "not marked, not wrapped");
    assert.equal(Object.hasOwn(ctx, CALL_KIND), false);
    assert.deepEqual(await handler.invoke("a", "not a list"), { ok: true, result: NaN });
    assert.deepEqual([seen[1].x, seen[1].y, seen[1].self], [undefined, undefined, undefined]);
    assert.equal(callKind(seen[1].self), "direct", "a ctx that says nothing is a direct call");
    handler.close();
});

test("invoke answers a refusal as { ok: false, status, error, fields, field, code }", async () => {
    const handler = serviceDispatcher({
        a: () => { throw new ServiceError("Pick a date.", { status: 422, field: "date", code: "date.missing" }); },
        b: () => { throw new Error("pool exhausted"); },
    }, "/api", { onError: () => { } });
    assert.deepEqual(await handler.invoke("a", []), { ok: false, status: 422, error: "Pick a date.", fields: { date: "Pick a date." }, field: "date", code: "date.missing" });
    assert.deepEqual(await handler.invoke("b", []), { ok: false, status: 400, error: "request failed" });
    assert.deepEqual(await handler.invoke("missing", []), { ok: false, status: 404, error: 'unknown service "missing"' });
    handler.close();
});

test("invoke given a name that cannot be made a string answers the 404 without quoting it, not a throw", async () => {
    const handler = serviceDispatcher({ a: () => 1 }, "/api");
    assert.deepEqual(await handler.invoke({ toString: 0 }, []), { ok: false, status: 404, error: "unknown service" });
    handler.close();
});

test("invoke asks authorize for a declared query with ctx as this, then runs the touches with it", async () => {
    const asked = [];
    const touched = [];
    const handler = serviceDispatcher({ q: (id) => id, m: () => "m" }, "/api", {
        live: {
            queries: ["q"],
            authorize(name, args, info) { asked.push({ self: this, name, args, info }); return args[0] === 1; },
            touches: { m: function () { touched.push(this); return ["q"]; } },
        },
    });
    const ctx = { user: "job" };
    assert.deepEqual(await handler.invoke("q", [1], ctx), { ok: true, result: 1 });
    assert.deepEqual(await handler.invoke("q", [2], ctx), { ok: false, status: 403, error: "not allowed" });
    assert.deepEqual(asked.map(({ self, name, args, info }) => ({ self: self === ctx, name, args, info })), [
        { self: true, name: "q", args: [1], info: { direct: true } },
        { self: true, name: "q", args: [2], info: { direct: true } },
    ]);
    await handler.invoke("m", [], ctx);
    await flush();
    assert.deepEqual(touched, [ctx]);
    handler.close();
});

test("a service taken off the services object after construction is refused, not crashed on", async () => {
    const given = { a: () => 1 };
    const handler = serviceDispatcher(given, "/api", { onError: () => { } });
    delete given.a;
    const outcome = await handler.invoke("a", []);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, 400);
    assert.equal(outcome.error, "request failed");
    handler.close();
});

test("a request made by hand reaches a service as one off a socket does", async () => {
    // A guard for the made requests the other files use.
    const seen = [];
    const handler = serviceDispatcher({ a(...args) { seen.push({ args, kind: callKind(this) }); return args.length; } }, "/api");
    const answer = await driver(handler).post("a", [1, 2]);
    assert.equal(answer.status, 200);
    assert.equal(answer.body, 2);
    assert.deepEqual(seen, [{ args: [1, 2], kind: "direct" }]);
    handler.close();
});

test("a deferred service holds its answer until it settles", async () => {
    const gate = deferred();
    const handler = serviceDispatcher({ slow: () => gate.promise }, "/api");
    const res = new FakeResponse();
    const done = handler(fakeRequest({ url: "/api/slow", headers: { "content-type": "application/json" }, body: [] }), res);
    await flush();
    assert.equal(res.writableEnded, false);
    gate.resolve({ ready: true });
    assert.equal(await done, true);
    assert.deepEqual(res.json, { ready: true });
    handler.close();
});
