// Helpers for the service-dispatcher tests (tests/juris-kit/service-dispatcher*.test.mjs).
//
// Two ways to reach a dispatcher. `serve` puts it behind a real HTTP server on port 0 and records
// every rejection out of it (what a host would answer 500 to), with `request`, `call`, `openStream`
// and `subscribe` to talk to it. `FakeResponse`, `fakeRequest` and `driver` hand it a request and a
// response made by hand, for the tests that move the clock with mock.timers (no socket is involved,
// so nothing but the dispatcher's own timers runs on it) or need a response in a state a socket
// cannot be put in on demand (a write buffer that is full, a response already ended).
import http from "node:http";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { liveKey } from "juris/live-protocol.js";

// ---- waiting ------------------------------------------------------------------------------------

// Lets queued promise callbacks and I/O callbacks run. setImmediate is not one of the APIs the
// tests mock, so this works with mock.timers on.
export const flush = async (rounds = 10) => {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

// Polls `check` until it holds or `ms` pass (real time; for the tests on a real socket).
export const until = async (check, ms = 1000) => {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) return false;
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return true;
};

// A promise and the functions that settle it.
export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

// ---- the event stream's wire format --------------------------------------------------------------

// Server-Sent Events text as a list: { retry }, { comment }, or { event, data } with data parsed.
export function parseEvents(text) {
    const out = [];
    for (const block of text.split("\n\n")) {
        if (!block) continue;
        const retry = /^retry: (.*)$/m.exec(block)?.[1];
        const comment = /^: ?(.*)$/m.exec(block)?.[1];
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (retry !== undefined) out.push({ retry });
        else if (event !== undefined) out.push({ event, data: data === undefined ? undefined : JSON.parse(data) });
        else if (comment !== undefined) out.push({ comment });
    }
    return out;
}

// ---- a real server -------------------------------------------------------------------------------

export async function serve(handler) {
    const failures = [];
    const server = http.createServer((req, res) => {
        Promise.resolve()
            .then(() => handler(req, res))
            .then(
                (handled) => {
                    if (!handled) { res.statusCode = 404; res.setHeader("x-not-handled", "1"); res.end(); }
                },
                (error) => {
                    failures.push(error);
                    if (!res.headersSent) res.statusCode = 500;
                    res.end();
                },
            );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return {
        port,
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        failures,
        close: () => {
            server.closeAllConnections();
            return new Promise((resolve) => server.close(resolve));
        },
    };
}

// One request on its own connection: { status, headers, text, json }.
export function request(port, { method = "POST", path, headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false });
        req.on("error", reject);
        req.on("response", (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                let json;
                try { json = JSON.parse(text); } catch { json = undefined; }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.end(body === undefined ? undefined : body);
    });
}

// A JSON service call: POST `${base}/${name}` with `args` as the body (none when undefined).
export const call = (port, name, args, { headers = {}, base = "/api" } = {}) =>
    request(port, {
        path: `${base}/${name}`,
        headers: { "content-type": "application/json", ...headers },
        body: args === undefined ? undefined : typeof args === "string" ? args : JSON.stringify(args),
    });

// A body sent to the subscribe endpoint.
export const live = (port, body, { headers = {} } = {}) =>
    request(port, { path: "/api/_live", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

export const subscribeBody = (client, name, args = []) => ({ client, subscribe: { key: liveKey(name, args), name, args } });

export const subscribe = (port, client, name, args = [], options) => live(port, subscribeBody(client, name, args), options);

// Opens the event stream and resolves at its hello (or, for a refusal, once its body has arrived).
// The stream records what it is sent: `events` (patches and the like), `retry`, `comments`.
export function openStream(port, { client, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const path = `/api/events${client ? `?client=${encodeURIComponent(client)}` : ""}`;
        const req = http.request({ port, host: "127.0.0.1", path, headers, agent: false });
        req.on("error", () => { });
        req.on("response", (res) => {
            const stream = {
                req, res, status: res.statusCode, headers: res.headers, text: "", events: [], ended: false, id: null,
                close: () => req.destroy(),
            };
            stream.done = new Promise((done) => {
                const end = () => { stream.ended = true; done(); };
                res.on("end", end);
                res.on("close", end);
            });
            res.setEncoding("utf8");
            if (res.statusCode !== 200) {
                res.on("data", (chunk) => { stream.text += chunk; });
                res.on("end", () => {
                    try { stream.json = JSON.parse(stream.text); } catch { stream.json = undefined; }
                    resolve(stream);
                });
                return;
            }
            let buffer = "";
            res.on("data", (chunk) => {
                stream.text += chunk;
                buffer += chunk;
                let at;
                while ((at = buffer.indexOf("\n\n")) >= 0) {
                    const [item] = parseEvents(buffer.slice(0, at + 2));
                    buffer = buffer.slice(at + 2);
                    if (!item) continue;
                    if (item.event === "hello") { stream.id = item.data.client; resolve(stream); }
                    else if (item.event) stream.events.push(item);
                }
            });
        });
        req.on("error", reject);
        req.end();
    });
}

// ---- a request and a response made by hand -------------------------------------------------------

// What a dispatcher reads and writes of a Node response, recorded.
export class FakeResponse extends EventEmitter {
    statusCode = 200;
    headers = {};
    chunks = [];
    headersSent = false;
    writableEnded = false;
    destroyed = false;
    writableLength = 0;

    setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
    getHeader(name) { return this.headers[name.toLowerCase()]; }
    writeHead(status, headers = {}) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
        this.headersSent = true;
        return this;
    }
    write(chunk) {
        this.headersSent = true;
        this.chunks.push(String(chunk));
        return true;
    }
    end(chunk) {
        if (chunk !== undefined) this.chunks.push(String(chunk));
        this.headersSent = true;
        this.writableEnded = true;
        this.emit("finish");
    }
    get text() { return this.chunks.join(""); }
    get json() { return JSON.parse(this.text); }
    get events() { return parseEvents(this.text); }
    // The `event: patch` payloads, in order.
    get patches() { return this.events.filter((item) => item.event === "patch").map((item) => item.data); }
}

// A request with a body (a Buffer, a string, or a value sent as JSON), read the way Node's is.
export function fakeRequest({ method = "POST", url = "/api/x", headers = {}, body, complete = true, socket = { remoteAddress: "10.0.0.1", destroyed: false } } = {}) {
    const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
    const req = Readable.from(chunks, { objectMode: false });
    return Object.assign(req, { method, url, headers, complete, socket });
}

// A GET of the event stream: nothing to read, and 'close' when the test says the browser left.
export function fakeStreamRequest({ url = "/api/events", headers = {}, socket = { remoteAddress: "10.0.0.1", destroyed: false } } = {}) {
    return Object.assign(new EventEmitter(), { method: "GET", url, headers, socket, destroyed: false, complete: true });
}

// A dispatcher driven with made requests: streams, subscribes and calls, each answered in full
// before the promise resolves (a subscribe's first run included, when it does not wait on anything).
export function driver(handler, { base = "/api" } = {}) {
    return {
        async open({ client, headers = {}, socket } = {}) {
            const req = fakeStreamRequest({ url: `${base}/events${client ? `?client=${encodeURIComponent(client)}` : ""}`, headers, socket });
            const res = new FakeResponse();
            const handled = await handler(req, res);
            const hello = res.events.find((item) => item.event === "hello");
            return { req, res, handled, id: hello?.data.client ?? null, leave: () => req.emit("close") };
        },
        async post(path, body, { headers = {}, socket, method = "POST" } = {}) {
            const req = fakeRequest({ method, url: `${base}/${path}`, headers: { "content-type": "application/json", ...headers }, body, socket });
            const res = new FakeResponse();
            const handled = await handler(req, res);
            let json;
            try { json = res.json; } catch { json = undefined; }
            return { handled, status: res.statusCode, body: json, res };
        },
        subscribe(client, name, args = [], options) {
            return this.post("_live", subscribeBody(client, name, args), options);
        },
        unsubscribe(client, name, args = [], options) {
            return this.post("_live", { client, unsubscribe: liveKey(name, args) }, options);
        },
    };
}
