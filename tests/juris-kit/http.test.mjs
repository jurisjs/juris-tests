// server/http.js, held to REFERENCE.md's "server/http.js" and its security invariants: cookies read
// one at a time and written with safe defaults, the client's address behind trusted proxies, the
// on-this-site test for redirects, request bodies (readBody, drainBody), packed answers (pack, send)
// and files from disk (sendFile, its byte ranges as RFC 9110 reads them). Real HTTP servers on port 0
// and temporary directories, each cleaned up; the body and timer tests use stand-in streams and
// node:test's mock timers.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import {
    parseCookies, serializeCookie, appendSetCookie, clientIp, onThisSite,
    readBody, drainBody, refuseMethod, CACHE_CONTROL, pack, notModified, send, sendFile,
} from "juris-kit/server/http.js";

const tempDir = () => mkdtemp(path.join(os.tmpdir(), "juris-tests-http-"));

// A server on port 0 around `handler`, and a way to close it.
async function serve(handler) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        port: server.address().port,
        close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
    };
}

// One request: { status, headers, body (a Buffer) }, or { error } when the connection failed.
function request(port, { method = "GET", pathname = "/", headers = {}, body = null } = {}) {
    return new Promise((resolve) => {
        const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers, agent: false }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), complete: res.complete }));
            res.on("aborted", () => resolve({ status: res.statusCode, aborted: true }));
            res.on("error", (error) => resolve({ status: res.statusCode, error }));
        });
        req.on("error", (error) => resolve({ error }));
        if (body !== null) req.write(body);
        req.end();
    });
}

// A response that records what it is told, for the functions that only write headers and a body.
function recorder() {
    const res = {
        status: null, headers: null, body: undefined, ended: false, set: new Map(),
        writeHead(status, headers = {}) { res.status = status; res.headers = headers; return res; },
        end(body) { res.body = body; res.ended = true; },
        getHeader(name) { return res.set.get(name); },
        setHeader(name, value) { res.set.set(name, value); },
    };
    return res;
}

// A request body that arrives when the test says, for drainBody.
function trickle({ complete = false, readableEnded = false, destroyed = false } = {}) {
    const req = new EventEmitter();
    Object.assign(req, { complete, readableEnded, destroyed, resumed: 0 });
    req.resume = () => { req.resumed++; return req; };
    return req;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---- cookies ----------------------------------------------------------------------------------

test("parseCookies reads every cookie by name into an object with no prototype", () => {
    const cookies = parseCookies("a=1; b=two;c = three ; __proto__=x");
    assert.equal(Object.getPrototypeOf(cookies), null);
    assert.deepEqual(Object.entries(cookies), [["a", "1"], ["b", "two"], ["c", "three"], ["__proto__", "x"]]);
    assert.equal(cookies.__proto__, "x", "a cookie named __proto__ is just a name");
    assert.equal(Object.hasOwn(cookies, "__proto__"), true);
});

test("parseCookies decodes each value and keeps an = inside it", () => {
    assert.deepEqual({ ...parseCookies("next=%2Fa%3Fb%3D1; token=abc==") }, { next: "/a?b=1", token: "abc==" });
});

test("parseCookies skips a cookie it cannot decode, and a part with no = or no name, and reads the rest", () => {
    const cookies = parseCookies("bad=%E0%A4%A; good=yes; noequals; =orphan; ; also=%41");
    assert.deepEqual({ ...cookies }, { good: "yes", also: "A" });
});

test("parseCookies keeps a repeated name's last readable value", () => {
    assert.equal(parseCookies("a=1; a=2").a, "2");
    assert.equal(parseCookies("a=1; a=%ZZ").a, "1", "an unreadable repeat does not erase the readable value");
});

test("parseCookies answers an empty object for a missing header", () => {
    for (const header of [undefined, null, ""]) {
        const cookies = parseCookies(header);
        assert.equal(Object.getPrototypeOf(cookies), null);
        assert.deepEqual(Object.keys(cookies), []);
    }
});

test("serializeCookie writes the safe defaults: the whole site, no script, Lax, https only", () => {
    assert.equal(serializeCookie("sid", "abc"), "sid=abc; Path=/; HttpOnly; SameSite=Lax; Secure");
});

test("serializeCookie %-encodes the value, so it can never end the value and add an attribute", () => {
    const cookie = serializeCookie("next", "/a; Domain=evil.example", { secure: false });
    assert.equal(cookie, "next=%2Fa%3B%20Domain%3Devil.example; Path=/; HttpOnly; SameSite=Lax");
    assert.equal(parseCookies(cookie.split("; ")[0]).next, "/a; Domain=evil.example", "parseCookies reads it back");
    assert.equal(serializeCookie("e", null), "e=; Path=/; HttpOnly; SameSite=Lax; Secure");
    assert.equal(serializeCookie("e", undefined), "e=; Path=/; HttpOnly; SameSite=Lax; Secure");
    assert.equal(serializeCookie("n", 42), "n=42; Path=/; HttpOnly; SameSite=Lax; Secure");
});

test("serializeCookie writes every attribute in its fixed order: Path, HttpOnly, SameSite, Expires, Max-Age, Secure", () => {
    const expires = new Date(Date.UTC(2030, 0, 2, 3, 4, 5));
    assert.equal(
        serializeCookie("a", "b", { path: "/app", sameSite: "strict", expires, maxAge: 3600 }),
        "a=b; Path=/app; HttpOnly; SameSite=Strict; Expires=Wed, 02 Jan 2030 03:04:05 GMT; Max-Age=3600; Secure",
    );
    assert.equal(serializeCookie("a", "b", { httpOnly: false, secure: false, maxAge: 0 }), "a=b; Path=/; SameSite=Lax; Max-Age=0");
    assert.equal(serializeCookie("a", "b", { maxAge: -1 }), "a=b; Path=/; HttpOnly; SameSite=Lax; Max-Age=-1; Secure");
});

test("serializeCookie reads SameSite in any case, and allows None only with Secure", () => {
    assert.match(serializeCookie("a", "b", { sameSite: "LAX" }), /; SameSite=Lax;/);
    assert.match(serializeCookie("a", "b", { sameSite: "none" }), /; SameSite=None; Secure$/);
    assert.throws(() => serializeCookie("a", "b", { sameSite: "None", secure: false }), { name: "TypeError", message: /SameSite=None needs Secure/ });
    for (const sameSite of ["loose", "", null, 1]) {
        assert.throws(() => serializeCookie("a", "b", { sameSite }), { name: "TypeError", message: /SameSite must be Strict, Lax or None/ }, String(sameSite));
    }
});

test("serializeCookie refuses a name that is not an RFC 6265 token", () => {
    for (const name of ["", "a b", "a;b", "a=b", "a,b", "ä", "a\tb", "(a)", null, 5, undefined]) {
        assert.throws(() => serializeCookie(name, "v"), { name: "TypeError", message: /is not a cookie name/ }, JSON.stringify(name));
    }
    assert.match(serializeCookie("!#$%&'*+-.^_`|~09AZaz", "v"), /^!#\$%&'\*\+-\.\^_`\|~09AZaz=v;/);
});

test("serializeCookie refuses a path with ; or a control character, or one that is not a string", () => {
    for (const p of ["/a;b", "/a\nb", "/a\x00", "/a\x7f", "/a\x1f", 5, null]) {
        assert.throws(() => serializeCookie("a", "b", { path: p }), { name: "TypeError", message: /is not a cookie path/ }, JSON.stringify(p));
    }
});

test("serializeCookie refuses an Expires that is not a valid Date, and a Max-Age that is not an integer", () => {
    for (const expires of [new Date(NaN), "2030-01-01", 0, null]) {
        assert.throws(() => serializeCookie("a", "b", { expires }), { name: "TypeError", message: /expires must be a valid Date/ }, String(expires));
    }
    for (const maxAge of [1.5, "60", NaN, Infinity, null]) {
        assert.throws(() => serializeCookie("a", "b", { maxAge }), { name: "TypeError", message: /maxAge must be an integer/ }, String(maxAge));
    }
});

test("appendSetCookie adds a cookie beside those already set, never replacing them", () => {
    const res = recorder();
    appendSetCookie(res, "a=1");
    assert.deepEqual(res.getHeader("set-cookie"), ["a=1"]);
    appendSetCookie(res, "b=2");
    assert.deepEqual(res.getHeader("set-cookie"), ["a=1", "b=2"]);
    const single = recorder();
    single.setHeader("set-cookie", "x=0");
    appendSetCookie(single, "y=1");
    assert.deepEqual(single.getHeader("set-cookie"), ["x=0", "y=1"]);
});

test("appendSetCookie on a real response sends every cookie as its own Set-Cookie", async () => {
    const server = await serve((req, res) => {
        res.setHeader("set-cookie", "first=1");
        appendSetCookie(res, serializeCookie("second", "2", { secure: false }));
        appendSetCookie(res, serializeCookie("third", "3", { secure: false }));
        res.end();
    });
    try {
        const answer = await request(server.port);
        assert.deepEqual(answer.headers["set-cookie"], ["first=1", "second=2; Path=/; HttpOnly; SameSite=Lax", "third=3; Path=/; HttpOnly; SameSite=Lax"]);
    } finally {
        await server.close();
    }
});

// ---- the client's address ---------------------------------------------------------------------

const from = (remoteAddress, forwarded) => ({ socket: { remoteAddress }, headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded } });

test("clientIp with no proxy trusted is the socket's address, and X-Forwarded-For is not read", () => {
    assert.equal(clientIp(from("10.0.0.9", "6.6.6.6")), "10.0.0.9");
    assert.equal(clientIp(from("10.0.0.9", "6.6.6.6"), { trustProxy: false }), "10.0.0.9");
    assert.equal(clientIp({ headers: {} }), undefined, "no socket, no address");
});

test("clientIp behind one proxy is the right-most entry, the one the proxy wrote", () => {
    assert.equal(clientIp(from("10.0.0.1", "6.6.6.6, 203.0.113.7"), { trustProxy: true }), "203.0.113.7");
    assert.equal(clientIp(from("10.0.0.1", "6.6.6.6, 203.0.113.7"), { trustProxy: {} }), "203.0.113.7", "no hops is one");
    assert.equal(clientIp(from("10.0.0.1", "203.0.113.7"), { trustProxy: true }), "203.0.113.7", "a proxy that replaces the header");
});

test("clientIp behind several proxies is the entry `hops` from the right, and what the client wrote is never read", () => {
    const req = from("10.0.0.1", "1.1.1.1, 6.6.6.6 ,  203.0.113.7, 10.0.0.2");
    assert.equal(clientIp(req, { trustProxy: { hops: 2 } }), "203.0.113.7");
    assert.equal(clientIp(req, { trustProxy: { hops: 1 } }), "10.0.0.2");
    assert.equal(clientIp(from("10.0.0.1", "203.0.113.7, 10.0.0.2"), { trustProxy: { hops: 5 } }), "203.0.113.7", "fewer entries: the left-most");
});

test("clientIp with an empty or missing header is the socket's address", () => {
    for (const forwarded of [undefined, "", " , ,", ","]) {
        assert.equal(clientIp(from("10.0.0.1", forwarded), { trustProxy: true }), "10.0.0.1", JSON.stringify(forwarded));
    }
});

test("clientIp refuses a hops that is not a whole number of proxies, at least 1", () => {
    for (const hops of [0, -1, 1.5, "2", NaN]) {
        assert.throws(() => clientIp(from("10.0.0.1", "a, b"), { trustProxy: { hops } }), { name: "TypeError", message: /trustProxy\.hops must be a whole number/ }, String(hops));
    }
});

// ---- redirects --------------------------------------------------------------------------------

test("onThisSite accepts a path on this site, however it is spelt", () => {
    for (const location of ["/", "/a", "/a/b?c=1#d", "/a/../b", "/%2F%2Fevil.example", "/login?to=//evil.example", "/a//b"]) {
        assert.equal(onThisSite(location), true, location);
    }
});

test("onThisSite refuses anything the browser's URL parser would send to another host, or that is no path", () => {
    // A host no URL can be made of ("/\\[x" names the host "[x") is refused, not thrown.
    assert.equal(onThisSite("/\\[x"), false);
    assert.equal(onThisSite("/\t\\[::1"), false);
    for (const location of ["//evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "/\r\\evil.example", "\\\\evil.example",
        "https://evil.example/", "http://one.invalid/", "javascript:alert(1)", "evil.example", "", " /a", null, undefined, 1, ["/a"], { toString: () => "/a" }]) {
        assert.equal(onThisSite(location), false, JSON.stringify(location));
    }
});

// ---- request bodies ---------------------------------------------------------------------------

test("readBody answers the whole body as one Buffer", async () => {
    const body = await readBody(Readable.from([Buffer.from("hel"), Buffer.from("lo")]));
    assert.ok(Buffer.isBuffer(body));
    assert.equal(body.toString(), "hello");
    assert.equal((await readBody(Readable.from([]))).length, 0, "an empty body is an empty Buffer");
});

test("readBody holds a body of exactly the limit, and answers null once it passes it", async () => {
    assert.equal((await readBody(Readable.from([Buffer.alloc(4), Buffer.alloc(6)]), { limit: 10 })).length, 10);
    assert.equal(await readBody(Readable.from([Buffer.alloc(4), Buffer.alloc(7)]), { limit: 10 }), null);
    assert.equal(await readBody(Readable.from([Buffer.alloc(1)]), { limit: 0 }), null);
    assert.equal((await readBody(Readable.from([]), { limit: 0 })).length, 0);
});

test("readBody's limit is a megabyte unless told", async () => {
    assert.equal((await readBody(Readable.from([Buffer.alloc(1_000_000)]))).length, 1_000_000);
    assert.equal(await readBody(Readable.from([Buffer.alloc(1_000_000), Buffer.alloc(1)])), null);
});

test("readBody stops at the limit and leaves the stream as it is, with the rest still to come", async () => {
    const stream = Readable.from([Buffer.from("aaaa"), Buffer.from("bbbb"), Buffer.from("cccc")]);
    assert.equal(await readBody(stream, { limit: 5 }), null);
    assert.equal(stream.destroyed, false, "the stream was destroyed");
    const rest = [];
    for await (const chunk of stream) rest.push(chunk.toString());
    assert.deepEqual(rest, ["cccc"]);
});

test("readBody refuses a limit that is not a number of bytes", async () => {
    for (const limit of [-1, NaN, "10", null]) {
        await assert.rejects(readBody(Readable.from([]), { limit }), { name: "TypeError", message: /limit must be a number of bytes/ }, String(limit));
    }
});

test("drainBody resolves at once, reading nothing, for a body that has already ended or a request that is gone", async () => {
    for (const state of [{ complete: true }, { readableEnded: true }, { destroyed: true }]) {
        const req = trickle(state);
        await drainBody(req);
        assert.equal(req.resumed, 0, JSON.stringify(state));
        assert.equal(req.listenerCount("data"), 0);
    }
});

test("drainBody reads the rest of the body and resolves when it ends, leaving no listener behind", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const req = trickle();
    let done = false;
    const drained = drainBody(req).then(() => { done = true; });
    assert.equal(req.resumed, 1, "the rest is read");
    req.emit("data", Buffer.alloc(10));
    req.emit("end");
    await drained;
    assert.equal(done, true);
    for (const event of ["data", "end", "close", "error"]) assert.equal(req.listenerCount(event), 0, event);
});

test("drainBody stops waiting once idleMs pass without a piece", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const req = trickle();
    let done = false;
    drainBody(req, { idleMs: 100, totalMs: 1000 }).then(() => { done = true; });
    t.mock.timers.tick(60);
    req.emit("data", Buffer.alloc(1));                    // a piece: the idle wait starts again
    t.mock.timers.tick(60);
    await flush();
    assert.equal(done, false, "the idle wait was not restarted by a piece");
    t.mock.timers.tick(40);
    await flush();
    assert.equal(done, true);
    assert.equal(req.listenerCount("data"), 0);
});

test("drainBody stops waiting after totalMs in all, however long the client keeps sending", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const req = trickle();
    let done = false;
    drainBody(req, { idleMs: 100, totalMs: 300 }).then(() => { done = true; });
    for (let i = 0; i < 5; i++) {
        t.mock.timers.tick(50);
        req.emit("data", Buffer.alloc(1));
    }
    await flush();
    assert.equal(done, false, "resolved before the total wait");
    t.mock.timers.tick(50);
    await flush();
    assert.equal(done, true);
});

test("drainBody waits a second between pieces and five seconds in all unless told", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const idle = trickle();
    let idleDone = false;
    drainBody(idle).then(() => { idleDone = true; });
    t.mock.timers.tick(999);
    await flush();
    assert.equal(idleDone, false);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(idleDone, true);

    const busy = trickle();
    let busyDone = false;
    drainBody(busy).then(() => { busyDone = true; });
    for (let i = 0; i < 9; i++) { t.mock.timers.tick(500); busy.emit("data", Buffer.alloc(1)); }
    await flush();
    assert.equal(busyDone, false);
    t.mock.timers.tick(500);
    await flush();
    assert.equal(busyDone, true);
});

test("drainBody resolves when the request closes or fails", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const event of ["close", "error"]) {
        const req = trickle();
        const drained = drainBody(req);
        req.emit(event, event === "error" ? new Error("reset") : undefined);
        await drained;
        for (const name of ["data", "end", "close", "error"]) assert.equal(req.listenerCount(name), 0, `${event}: ${name}`);
    }
});

test("a body refused at the limit and drained first reaches the client as a 413, not a failed connection", async () => {
    const seen = [];
    const server = await serve(async (req, res) => {
        const body = await readBody(req, { limit: 1024 });
        seen.push(body);
        await drainBody(req, { idleMs: 50, totalMs: 500 });
        res.writeHead(413, { connection: "close" });
        res.end("too large");
    });
    try {
        const answer = await request(server.port, { method: "POST", body: Buffer.alloc(256 * 1024, 1) });
        assert.equal(answer.error, undefined, `the client saw ${answer.error?.code}`);
        assert.equal(answer.status, 413);
        assert.equal(answer.body.toString(), "too large");
        assert.deepEqual(seen, [null]);
    } finally {
        await server.close();
    }
});

test("readBody over HTTP answers a body sent without a Content-Length, counted as it arrives", async () => {
    const seen = [];
    const server = await serve(async (req, res) => {
        const body = await readBody(req, { limit: 10 });
        seen.push(body === null ? null : body.toString());
        if (body === null) await drainBody(req, { idleMs: 50, totalMs: 500 });
        res.end();
    });
    try {
        await request(server.port, { method: "POST", headers: { "transfer-encoding": "chunked" }, body: "0123456789" });
        await request(server.port, { method: "POST", headers: { "transfer-encoding": "chunked" }, body: "0123456789x" });
        assert.deepEqual(seen, ["0123456789", null]);
    } finally {
        await server.close();
    }
});

// ---- methods ----------------------------------------------------------------------------------

const PLAIN_405 = { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };

test("refuseMethod leaves GET and HEAD to the caller, and answers OPTIONS with 204, any other method with 405", () => {
    for (const method of ["GET", "HEAD"]) {
        const res = recorder();
        assert.equal(refuseMethod({ method, headers: {} }, res), false, method);
        assert.equal(res.status, null, `${method}: something was written`);
    }
    const options = recorder();
    assert.equal(refuseMethod({ method: "OPTIONS", headers: {} }, options), true);
    assert.equal(options.status, 204);
    assert.deepEqual(options.headers, { allow: "GET, HEAD" });
    assert.equal(options.body, undefined);
    assert.equal(options.ended, true);
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "TRACE", "PROPFIND"]) {
        const res = recorder();
        assert.equal(refuseMethod({ method, headers: {} }, res), true, method);
        assert.equal(res.status, 405, method);
        assert.deepEqual(res.headers, PLAIN_405, method);
        assert.equal(res.body, "This address takes GET, HEAD.", method);
    }
});

test("refuseMethod takes the methods an address takes, and names them in Allow", () => {
    const asking = (method) => ({ method, headers: {} });
    const post = recorder();
    assert.equal(refuseMethod(asking("POST"), post, ["POST"]), false);
    assert.equal(post.status, null);
    const get = recorder();
    assert.equal(refuseMethod(asking("GET"), get, ["POST"]), true);
    assert.deepEqual([get.status, get.headers.allow, get.body], [405, "POST", "This address takes POST."]);
    const options = recorder();
    refuseMethod(asking("OPTIONS"), options, ["GET", "HEAD", "POST"]);
    assert.deepEqual([options.status, options.headers.allow], [204, "GET, HEAD, POST"]);
    const taken = recorder();
    const answered = refuseMethod(asking("OPTIONS"), taken, ["GET", "OPTIONS"]);
    assert.equal(answered, false, "an address that takes OPTIONS answers it itself");
});

test("refuseMethod refuses an allow that is not a list of method names, before anything is written", () => {
    const refusal = { name: "TypeError", message: /^refuseMethod: allow is a list of method names/ };
    for (const allow of ["GET", [], ["GET", "get me"], ["GET", 5], null]) {
        const res = recorder();
        const refuse = () => refuseMethod({ method: "DELETE", headers: {} }, res, allow);
        assert.throws(refuse, refusal, JSON.stringify(allow));
        assert.equal(res.status, null);
    }
});

test("refuseMethod over HTTP: a 405 to a HEAD has no body, and the OPTIONS 204 no Content-Length", async () => {
    const server = await serve((req, res) => {
        if (refuseMethod(req, res, ["POST"])) return;
        res.end("posted");
    });
    try {
        const head = await request(server.port, { method: "HEAD" });
        assert.deepEqual([head.status, head.headers.allow, head.body.length], [405, "POST", 0]);
        const options = await request(server.port, { method: "OPTIONS" });
        assert.deepEqual([options.status, options.headers.allow, options.body.length], [204, "POST", 0]);
        assert.equal(options.headers["content-length"], undefined);
        assert.equal((await request(server.port, { method: "POST" })).body.toString(), "posted");
    } finally {
        await server.close();
    }
});

// ---- responses: pack and send -----------------------------------------------------------------

test("CACHE_CONTROL names each policy's Cache-Control, and cannot be changed", () => {
    assert.deepEqual({ ...CACHE_CONTROL }, {
        "no-store": "no-store",
        private: "private, no-cache",
        public: "public, max-age=0, must-revalidate",
        immutable: "public, max-age=31536000, immutable",
    });
    assert.equal(Object.isFrozen(CACHE_CONTROL), true);
});

test("pack keeps the bytes, their gzip, a weak ETag of the length and the SHA-256, the status and when it was made", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
    const text = "<p>héllo</p>".repeat(10);
    const entry = pack(text);
    const bytes = Buffer.from(text);
    assert.deepEqual(entry.body, bytes);
    assert.deepEqual(zlib.gunzipSync(entry.gz), bytes);
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
    assert.equal(entry.etag, `W/"${bytes.length.toString(36)}-${hash}"`);
    assert.equal(entry.status, 200);
    assert.equal(entry.at, 1_700_000_000_000);
    assert.equal(pack(text, { status: 404 }).status, 404);
});

test("pack's ETag names the bytes: the same body has the same tag, a changed body of the same length a new one", () => {
    assert.equal(pack("abc").etag, pack(Buffer.from("abc")).etag);
    assert.notEqual(pack("abc").etag, pack("abd").etag);
    assert.match(pack("").etag, /^W\/"0-[0-9a-f]{32}"$/);
});

test("pack with gzip: false keeps no gzip", () => {
    const entry = pack(Buffer.from([1, 2, 3]), { gzip: false });
    assert.equal(entry.gz, null);
    assert.deepEqual([...entry.body], [1, 2, 3]);
});

test("send answers gzip to a client that asks for it, the bytes otherwise, and always says Vary: Accept-Encoding", () => {
    const entry = pack("hello world");
    const gz = recorder();
    send({ headers: { "accept-encoding": "deflate, gzip;q=0.8, br" } }, gz, entry, { type: "text/plain" });
    assert.equal(gz.status, 200);
    assert.deepEqual(gz.headers, { etag: entry.etag, "cache-control": "private, no-cache", vary: "Accept-Encoding", "content-type": "text/plain", "content-encoding": "gzip" });
    assert.equal(gz.body, entry.gz);

    for (const accept of [undefined, "br, deflate", "identity", "xgzip"]) {
        const plain = recorder();
        send({ headers: accept === undefined ? {} : { "accept-encoding": accept } }, plain, entry, { type: "text/plain" });
        assert.equal(plain.headers["content-encoding"], undefined, String(accept));
        assert.equal(plain.headers.vary, "Accept-Encoding");
        assert.equal(plain.body, entry.body);
    }
});

test("send answers the bytes to a gzip client when the entry keeps no gzip", () => {
    const entry = pack(Buffer.alloc(10, 1), { gzip: false });
    const res = recorder();
    send({ headers: { "accept-encoding": "gzip" } }, res, entry, { type: "image/png" });
    assert.equal(res.headers["content-encoding"], undefined);
    assert.equal(res.body, entry.body);
});

test("send answers with the entry's status, 200 when it has none", () => {
    const res = recorder();
    send({ headers: {} }, res, pack("gone", { status: 404 }), { type: "text/html" });
    assert.equal(res.status, 404);
    const bare = recorder();
    send({ headers: {} }, bare, { body: Buffer.from("x"), gz: null, etag: 'W/"1-x"' }, { type: "text/plain" });
    assert.equal(bare.status, 200);
});

test("send answers 304 to an If-None-Match that names the ETag, repeating its ETag, Cache-Control, Vary and the caller's headers", () => {
    const entry = pack("hello");
    const res = recorder();
    const conditional = { method: "GET", headers: { "if-none-match": entry.etag, "accept-encoding": "gzip" } };
    const policy = { "content-security-policy": "default-src 'self'" };
    send(conditional, res, entry, { type: "text/html", cache: "public", headers: policy });
    assert.equal(res.status, 304);
    assert.deepEqual(res.headers, { "content-security-policy": "default-src 'self'", etag: entry.etag, "cache-control": CACHE_CONTROL.public, vary: "Accept-Encoding" });
    assert.equal(res.body, undefined);
    assert.equal(res.ended, true);
    const other = recorder();
    send({ method: "GET", headers: { "if-none-match": 'W/"5-other"' } }, other, entry, { type: "text/html" });
    assert.equal(other.status, 200, "another tag is answered in full");
});

// RFC 9110, 13.2.1: a server ignores the conditional headers when its answer would not be a 2xx,
// and for a method that selects no representation; 13.1.2: only a GET or a HEAD is answered 304.
test("send answers a 404 in full whatever If-None-Match names: a missing page is never a 304", () => {
    const missing = pack("<h1>Not found</h1>", { status: 404 });
    const res = recorder();
    const held = { method: "GET", headers: { "if-none-match": missing.etag } };
    send(held, res, missing, { type: "text/html" });
    assert.equal(res.status, 404);
    assert.equal(res.body, missing.body);
    assert.equal(res.headers.etag, missing.etag);
});

test("send answers 304 to a HEAD as to a GET, and any other method in full, whatever If-None-Match names", () => {
    const entry = pack("hello");
    const held = (method) => ({ method, headers: { "if-none-match": entry.etag } });
    const head = recorder();
    send(held("HEAD"), head, entry, { type: "text/plain" });
    assert.equal(head.status, 304);
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
        const res = recorder();
        send(held(method), res, entry, { type: "text/plain" });
        assert.equal(res.status, 200, method);
        assert.equal(res.body, entry.body, method);
    }
});

test("send over HTTP: a 404 with the tag the client holds still arrives whole, and a POST is never a 304", async () => {
    const missing = pack("Not found", { status: 404 });
    const server = await serve((req, res) => send(req, res, missing, { type: "text/plain; charset=utf-8" }));
    try {
        const conditional = { headers: { "if-none-match": missing.etag } };
        const gone = await request(server.port, conditional);
        assert.equal(gone.status, 404);
        assert.equal(gone.body.toString(), "Not found");
        const posted = await request(server.port, { method: "POST", ...conditional });
        assert.equal(posted.status, 404);
        assert.equal(posted.body.toString(), "Not found");
    } finally {
        await server.close();
    }
});

test("notModified reads If-None-Match as RFC 9110 does: a list of tags compared weakly, or *", () => {
    const entry = pack("hello");
    const strong = entry.etag.slice(2);                   // the same opaque tag, not marked weak
    const asks = (header) => notModified({ method: "GET", headers: { "if-none-match": header } }, entry);
    assert.equal(asks(entry.etag), true);
    assert.equal(asks(strong), true, "the weak comparison: W/ aside, the same opaque tag");
    assert.equal(asks(`"a,b", W/"other", ${entry.etag}`), true, "one tag of a list, one with a comma included");
    assert.equal(asks(`"other",${strong}`), true);
    assert.equal(asks(" * "), true, "* is any representation at all");
    assert.equal(asks('W/"5-other"'), false);
    assert.equal(asks(entry.etag.replace(/"$/, 'x"')), false, "a longer tag is another tag");
    assert.equal(asks(`"a", "b"`), false);
    assert.equal(asks(""), false);
    assert.equal(notModified({ method: "GET", headers: {} }, entry), false, "no header, nothing to compare");
    const bare = { method: "GET", headers: { "if-none-match": '"x"' } };
    assert.equal(notModified(bare, { etag: '"x"' }), true, "a status of 200 unless told");
    assert.equal(notModified(bare, {}), false, "no ETag, nothing a tag can name");
});

test("notModified ignores If-None-Match for any method but GET and HEAD, and for an answer that is no 2xx", () => {
    const entry = pack("hello");
    const ask = (method, status) => {
        const req = { method, headers: { "if-none-match": entry.etag } };
        return notModified(req, { etag: entry.etag, status });
    };
    assert.equal(ask("GET", 200), true);
    assert.equal(ask("HEAD", 200), true);
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE", undefined]) {
        assert.equal(ask(method, 200), false, String(method));
    }
    for (const status of [201, 203, 299]) {
        assert.equal(ask("GET", status), true, String(status));
    }
    for (const status of [100, 199, 300, 301, 304, 404, 410, 412, 500, 503]) {
        assert.equal(ask("GET", status), false, String(status));
    }
    const anything = { method: "GET", headers: { "if-none-match": "*" } };
    const missing = { etag: entry.etag, status: 404 };
    assert.equal(notModified(anything, missing), false, "* names a representation a 404 does not have");
});

test("send writes each named cache policy, and refuses a name that is not one before anything is written", () => {
    for (const [name, value] of Object.entries(CACHE_CONTROL)) {
        const res = recorder();
        send({ headers: {} }, res, pack("x"), { type: "text/plain", cache: name });
        assert.equal(res.headers["cache-control"], value, name);
    }
    for (const cache of ["forever", "toString", "__proto__", "", null]) {
        const res = recorder();
        assert.throws(() => send({ headers: {} }, res, pack("x"), { type: "text/plain", cache }), { name: "TypeError", message: /unknown cache policy/ }, String(cache));
        assert.equal(res.status, null, "something was written");
    }
});

test("send adds the caller's headers to the answer, and they never replace the ones it writes", () => {
    const entry = pack("hello");
    const res = recorder();
    send({ headers: {} }, res, entry, { type: "text/html", headers: { "x-frame-options": "DENY", etag: "mine", "cache-control": "public, max-age=99999", vary: "Cookie", "content-type": "text/plain" } });
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers.etag, entry.etag);
    assert.equal(res.headers["cache-control"], CACHE_CONTROL.private);
    assert.equal(res.headers.vary, "Accept-Encoding");
    assert.equal(res.headers["content-type"], "text/html");
});

test("send: a caller's header spelt in another case does not reach the wire beside the one send writes", async () => {
    const entry = pack("hello");
    const server = await serve((req, res) => send(req, res, entry, { type: "text/plain", headers: { "Cache-Control": "public, max-age=99999", ETag: '"mine"', Vary: "Cookie" } }));
    try {
        const answer = await request(server.port);
        assert.equal(answer.headers["cache-control"], CACHE_CONTROL.private);
        assert.equal(answer.headers.etag, entry.etag);
        assert.equal(answer.headers.vary, "Accept-Encoding");
    } finally {
        await server.close();
    }
});

test("send over HTTP: the gzip arrives as the body's gzip, and a 304 has no body", async () => {
    const entry = pack("hello ".repeat(100));
    const server = await serve((req, res) => send(req, res, entry, { type: "text/plain; charset=utf-8", cache: "public" }));
    try {
        const gz = await request(server.port, { headers: { "accept-encoding": "gzip" } });
        assert.equal(gz.status, 200);
        assert.equal(gz.headers["content-encoding"], "gzip");
        assert.equal(zlib.gunzipSync(gz.body).toString(), "hello ".repeat(100));
        const again = await request(server.port, { headers: { "if-none-match": gz.headers.etag } });
        assert.equal(again.status, 304);
        assert.equal(again.body.length, 0);
        assert.equal(again.headers["cache-control"], CACHE_CONTROL.public);
        assert.equal(again.headers.vary, "Accept-Encoding");
    } finally {
        await server.close();
    }
});

// ---- responses: sendFile ----------------------------------------------------------------------

// A server that answers every request with sendFile(file, options), and a ten-byte file to send.
async function fileServer(t, options = {}) {
    const dir = await tempDir();
    const file = path.join(dir, "ten.txt");
    await writeFile(file, "0123456789");
    const failures = [];
    const state = { file, options };
    const server = await serve((req, res) => {
        sendFile(req, res, state.file, { type: "text/plain", ...state.options }).catch((error) => { failures.push(error); res.writeHead(500); res.end(); });
    });
    t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
    return { ...server, dir, file, state, failures };
}

test("sendFile sends the whole file with Accept-Ranges, its length and the private policy unless told", async (t) => {
    const app = await fileServer(t);
    const answer = await request(app.port);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.toString(), "0123456789");
    assert.equal(answer.headers["content-type"], "text/plain");
    assert.equal(answer.headers["accept-ranges"], "bytes");
    assert.equal(answer.headers["content-length"], "10");
    assert.equal(answer.headers["cache-control"], CACHE_CONTROL.private);
    app.state.options = { cache: "immutable" };
    assert.equal((await request(app.port)).headers["cache-control"], CACHE_CONTROL.immutable);
});

test("sendFile answers one byte range with 206 and those bytes: first-last, first- and -N", async (t) => {
    const app = await fileServer(t);
    const cases = [
        ["bytes=2-4", "234", "bytes 2-4/10"],
        ["bytes=0-0", "0", "bytes 0-0/10"],
        ["bytes=7-", "789", "bytes 7-9/10"],
        ["bytes=-3", "789", "bytes 7-9/10"],
        ["bytes=5-100", "56789", "bytes 5-9/10"],              // an end past the file is clamped
        ["bytes=-100", "0123456789", "bytes 0-9/10"],          // a suffix longer than the file is all of it
        ["BYTES=1-2", "12", "bytes 1-2/10"],                   // the unit in any case
        ["Bytes=9-9", "9", "bytes 9-9/10"],
    ];
    for (const [range, body, contentRange] of cases) {
        const answer = await request(app.port, { headers: { range } });
        assert.equal(answer.status, 206, range);
        assert.equal(answer.body.toString(), body, range);
        assert.equal(answer.headers["content-range"], contentRange, range);
        assert.equal(answer.headers["content-length"], String(body.length), range);
        assert.equal(answer.headers["accept-ranges"], "bytes", range);
    }
});

test("sendFile answers 416 to a range it cannot satisfy: a first at or past the end, a suffix of 0, a last before its first", async (t) => {
    const app = await fileServer(t, { headers: { "content-disposition": "attachment" } });
    for (const range of ["bytes=10-", "bytes=10-12", "bytes=50-60", "bytes=-0", "bytes=5-2"]) {
        const answer = await request(app.port, { headers: { range } });
        assert.equal(answer.status, 416, range);
        assert.equal(answer.headers["content-range"], "bytes */10", range);
        assert.equal(answer.headers["content-disposition"], undefined, "the caller's headers are on every answer but the 416");
        assert.equal(answer.body.length, 0);
    }
});

test("sendFile ignores a Range header that is not one byte range, and sends the whole file", async (t) => {
    const app = await fileServer(t);
    for (const range of ["items=0-1", "bytes=0-1,3-4", "bytes=", "bytes=-", "bytes=a-b", "bytes 0-1", "bytes=1.5-2", "bytes=0-1 ,"]) {
        const answer = await request(app.port, { headers: { range } });
        assert.equal(answer.status, 200, range);
        assert.equal(answer.body.toString(), "0123456789", range);
        assert.equal(answer.headers["content-range"], undefined, range);
    }
});

test("sendFile sends an empty file whole, and ignores a suffix range on it", async (t) => {
    const app = await fileServer(t);
    app.state.file = path.join(app.dir, "empty.txt");
    await writeFile(app.state.file, "");
    for (const headers of [{}, { range: "bytes=-5" }]) {
        const answer = await request(app.port, { headers });
        assert.equal(answer.status, 200, JSON.stringify(headers));
        assert.equal(answer.headers["content-length"], "0");
        assert.equal(answer.body.length, 0);
    }
    assert.equal((await request(app.port, { headers: { range: "bytes=0-" } })).status, 416, "a first at the end of an empty file");
});

test("sendFile answers HEAD with the headers GET would, and no body", async (t) => {
    const app = await fileServer(t);
    const whole = await request(app.port, { method: "HEAD" });
    assert.equal(whole.status, 200);
    assert.equal(whole.headers["content-length"], "10");
    assert.equal(whole.body.length, 0);
    const part = await request(app.port, { method: "HEAD", headers: { range: "bytes=3-5" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers["content-range"], "bytes 3-5/10");
    assert.equal(part.headers["content-length"], "3");
    assert.equal(part.body.length, 0);
});

// RFC 9110, 13.1.5: a Range beside an If-Range is honoured only when the If-Range names the answer's
// current ETag by the strong comparison; otherwise the whole file goes, the copy the client holds
// being stale.
test("sendFile honours a Range beside an If-Range only when it names, strongly, the answer's ETag", async (t) => {
    const app = await fileServer(t, { headers: { ETag: '"v1"' } });
    const ranged = (ifRange, range = "bytes=3-5") => request(app.port, { headers: { range, "if-range": ifRange } });
    const part = await ranged('"v1"');
    assert.equal(part.status, 206);
    assert.equal(part.body.toString(), "345");
    assert.equal(part.headers.etag, '"v1"');
    for (const ifRange of ['"v0"', 'W/"v1"', "Thu, 01 Jan 2026 00:00:00 GMT"]) {
        const whole = await ranged(ifRange);
        assert.equal(whole.status, 200, ifRange);
        assert.equal(whole.body.toString(), "0123456789", ifRange);
        assert.equal(whole.headers["content-range"], undefined, ifRange);
    }
    assert.equal((await ranged('"v0"', "bytes=20-")).status, 200, "a stale copy is sent whole, never refused");
    app.state.options = { headers: { etag: 'W/"v1"' } };
    assert.equal((await ranged('W/"v1"')).status, 200, "a weak tag never matches by the strong comparison");
    app.state.options = {};
    assert.equal((await ranged('"v1"')).status, 200, "with no ETag of its own, no If-Range names the file");
    const alone = await request(app.port, { headers: { range: "bytes=3-5" } });
    assert.equal(alone.status, 206, "a Range alone is still honoured");
});

test("sendFile adds the caller's headers to the 200 and the 206", async (t) => {
    const app = await fileServer(t, { headers: { "content-disposition": 'attachment; filename="ten.txt"' } });
    assert.equal((await request(app.port)).headers["content-disposition"], 'attachment; filename="ten.txt"');
    assert.equal((await request(app.port, { headers: { range: "bytes=1-1" } })).headers["content-disposition"], 'attachment; filename="ten.txt"');
});

test("sendFile takes a caller's header in any case: it replaces sendFile's own, once, and a Content-Length is always the body's", async (t) => {
    const headers = { "Content-Type": "application/pdf", "Cache-Control": "no-store", "Content-Length": "99", "Content-Disposition": "attachment" };
    const whole = recorder();
    await sendFile({ method: "HEAD", headers: {} }, whole, "/not-read", { type: "text/plain", size: 10, headers });
    assert.deepEqual(whole.headers, { "content-type": "application/pdf", "accept-ranges": "bytes", "cache-control": "no-store", "content-disposition": "attachment", "content-length": 10 });
    const part = recorder();
    await sendFile({ method: "HEAD", headers: { range: "bytes=3-5" } }, part, "/not-read", { type: "text/plain", size: 10, headers });
    assert.deepEqual(part.headers, { "content-type": "application/pdf", "accept-ranges": "bytes", "cache-control": "no-store", "content-disposition": "attachment", "content-range": "bytes 3-5/10", "content-length": 3 });
    const app = await fileServer(t, { headers });
    const answer = await request(app.port);
    assert.equal(answer.status, 200);
    assert.equal(answer.headers["content-length"], "10");
    assert.equal(answer.body.toString(), "0123456789");
});

test("sendFile takes the size it is given, and does not stat the file then", async (t) => {
    const app = await fileServer(t);
    app.state.file = path.join(app.dir, "not-there.txt");
    app.state.options = { size: 10 };
    const answer = await request(app.port, { headers: { range: "bytes=20-" } });
    assert.equal(answer.status, 416);
    assert.equal(answer.headers["content-range"], "bytes */10");
    assert.deepEqual(app.failures, []);
    app.state.file = app.file;
    app.state.options = { size: 4 };
    const told = await request(app.port, { method: "HEAD" });
    assert.equal(told.headers["content-length"], "4");
});

test("sendFile throws for a missing file before anything is written", async () => {
    const dir = await tempDir();
    try {
        const res = recorder();
        await assert.rejects(sendFile({ headers: {}, method: "GET" }, res, path.join(dir, "missing.txt"), { type: "text/plain" }), { code: "ENOENT" });
        assert.equal(res.status, null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("sendFile refuses a cache policy that is not one before it reads or writes anything", async () => {
    const res = recorder();
    await assert.rejects(sendFile({ headers: {}, method: "GET" }, res, "/no/such/file", { type: "text/plain", cache: "week" }), { name: "TypeError", message: /unknown cache policy "week"/ });
    assert.equal(res.status, null);
});

test("sendFile: a read error once the answer has begun ends the connection, since the status line is gone", async (t) => {
    const app = await fileServer(t);
    app.state.file = app.dir;                             // a directory: the read fails once it starts
    app.state.options = { size: 10 };
    const answer = await request(app.port);
    assert.ok(answer.error || answer.aborted || answer.complete === false, `the client got a whole answer: ${answer.status}`);
    assert.deepEqual(app.failures, [], "the failure is the stream's, not sendFile's promise");
});

// The process's open file descriptors, by the directory the OS lists them in.
const openFds = () => {
    for (const dir of ["/dev/fd", "/proc/self/fd"]) {
        try { return readdirSync(dir).length; } catch { /* the next */ }
    }
    return null;
};

// Starts a download, reads its first chunk, and cuts the connection.
function cutAfterFirstChunk(port, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/", headers, agent: false }, (res) => {
            res.once("data", () => { req.destroy(); res.destroy(); resolve(res.statusCode); });
        });
        req.on("error", (error) => { if (error.code !== "ECONNRESET") reject(error); });
    });
}

test("sendFile closes the file however the answer ends, a client that goes away part-way included", async (t) => {
    if (openFds() === null) return t.skip("no /dev/fd or /proc/self/fd to count descriptors with");
    const app = await fileServer(t);
    app.state.file = path.join(app.dir, "big.bin");
    await writeFile(app.state.file, Buffer.alloc(8 * 1024 * 1024, 7));
    await cutAfterFirstChunk(app.port);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = openFds();
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push(await cutAfterFirstChunk(app.port));
    for (let i = 0; i < 4; i++) statuses.push(await cutAfterFirstChunk(app.port, { range: `bytes=${i * 100}-` }));
    assert.deepEqual(statuses, [200, 200, 200, 200, 206, 206, 206, 206]);
    let after = openFds();
    for (let i = 0; i < 20 && after - before >= 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        after = openFds();
    }
    assert.ok(after - before < 3, `file descriptors left open: ${before} before, ${after} after eight cut downloads`);
});
