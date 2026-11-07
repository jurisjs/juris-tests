// server/kernel.js, createLifecycle, held to REFERENCE.md's "server/kernel.js" and the request
// invariants ("Nothing a request carries ends the instance, and nothing that throws is shown to
// it"): the options it refuses, `serve` in its order (x-instance, the 400, /version, /healthz and its
// bounded check, the app's handler, the fixed 500), `drain`, and the jobs (atStart, the interval, a
// failure reported, never beside itself, `skipped`, `stop` waiting for a run in flight). HTTP servers
// on port 0; node:test's mock timers for the intervals, and a child process for a timer that must
// not keep the process alive.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { execFile } from "node:child_process";
import { createLifecycle } from "juris-kit/server/kernel.js";
import { serve, request, gate, recorder } from "../support/kernel-app.mjs";

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

async function served(t, life, handler = (req, res) => { res.end("app"); }) {
    const server = await serve(life.serve(handler));
    t.after(() => server.close());
    return server;
}

// A request written by hand, for a target Node's client would refuse to send: { status, raw }.
function rawRequest(port, target) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
        let raw = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => { raw += chunk; });
        socket.on("end", () => resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(raw)?.[1]), raw }));
        socket.on("error", reject);
    });
}

// ---- construction -----------------------------------------------------------------------------

test("a lifecycle's options are an object of the keys it names: any other is refused", () => {
    for (const options of [null, [], "b", 5]) {
        assert.throws(() => createLifecycle(options), { name: "TypeError", message: "createLifecycle: options is an object" }, JSON.stringify(options));
    }
    assert.throws(() => createLifecycle({ build: "b", healthz: {} }), { name: "TypeError", message: /"healthz" is not an option \(build, instance, instanceHeader, health, jobs, onError\)/ });
});

test("a lifecycle needs a build: a string or a function answering it", () => {
    assert.throws(() => createLifecycle(), { name: "TypeError", message: /build, the build id or a function answering it, is required/ });
    for (const build of [undefined, null, 5, {}]) {
        assert.throws(() => createLifecycle({ build }), { name: "TypeError", message: /build, the build id/ }, String(build));
    }
    assert.doesNotThrow(() => createLifecycle({ build: () => "b" }));
});

test("health is { check, details, timeoutMs }: another shape or key is refused, and check and details are functions", () => {
    for (const health of [null, [], "check", 1]) {
        assert.throws(() => createLifecycle({ build: "b", health }), { name: "TypeError", message: /health is \{ check, details, timeoutMs \}/ }, JSON.stringify(health));
    }
    assert.throws(() => createLifecycle({ build: "b", health: { timeoutMS: 100 } }), { name: "TypeError", message: /health\.timeoutMS is not an option \(check, details, timeoutMs\)/ });
    assert.throws(() => createLifecycle({ build: "b", health: { check: "db" } }), { name: "TypeError", message: /health\.check is a function/ });
    assert.throws(() => createLifecycle({ build: "b", health: { details: {} } }), { name: "TypeError", message: /health\.details is a function/ });
    assert.doesNotThrow(() => createLifecycle({ build: "b", health: { check: null, details: null } }));
});

test("health.timeoutMs is a whole number of milliseconds Node's timers keep, 1 to 2^31 - 1", () => {
    for (const timeoutMs of [0, -1, 1.5, 2 ** 31, Infinity, NaN, "100", null]) {
        assert.throws(() => createLifecycle({ build: "b", health: { timeoutMs } }), { name: "TypeError", message: /health\.timeoutMs is a whole number of milliseconds, 1 to 2147483647/ }, String(timeoutMs));
    }
    assert.doesNotThrow(() => createLifecycle({ build: "b", health: { timeoutMs: 1 } }));
    assert.doesNotThrow(() => createLifecycle({ build: "b", health: { timeoutMs: 2 ** 31 - 1 } }));
});

test("every job has a name of its own, only the keys a job takes, an interval Node keeps, and something to run", () => {
    const run = () => {};
    const refused = (jobs, message) => assert.throws(() => createLifecycle({ build: "b", jobs }), { name: "TypeError", message }, JSON.stringify(jobs));
    refused([{ every: 10, run }], /every job has a name/);
    refused([{ name: "", every: 10, run }], /every job has a name/);
    refused([null], /every job has a name/);
    refused([{ name: "a", every: 10, run }, { name: "a", every: 20, run }], /two jobs are called "a"/);
    refused([{ name: "a", every: 10, run, atstart: true }], /job "a": atstart is not an option \(name, every, run, atStart\)/);
    for (const every of [undefined, 0, 1.5, 2 ** 31, "10", Infinity]) refused([{ name: "a", every, run }], /job "a" needs an interval, every, a whole number of milliseconds, 1 to 2147483647 \(about 24\.8 days\)/);
    refused([{ name: "a", every: 10 }], /job "a" has nothing to run/);
    refused([{ name: "a", every: 10, run: "cleanup" }], /job "a" has nothing to run/);
    assert.doesNotThrow(() => createLifecycle({ build: "b", jobs: [{ name: "a", every: 2 ** 31 - 1, run, atStart: true }] }));
});

// ---- serve ------------------------------------------------------------------------------------

test("serve hands the app's handler every other request, with its URL already read", async (t) => {
    const seen = [];
    const life = createLifecycle({ build: "b" });
    const server = await served(t, life, async (req, res, url) => { seen.push([req.url, url.pathname, url.searchParams.get("q")]); res.end("app"); });
    const answer = await request(server.port, "/things?q=1");
    assert.equal(answer.status, 200);
    assert.equal(answer.body, "app");
    assert.deepEqual(seen, [["/things?q=1", "/things", "1"]]);
});

test("serve names the instance in x-instance only when instanceHeader says so", async (t) => {
    const named = await served(t, createLifecycle({ build: "b", instance: "web-1", instanceHeader: true }));
    assert.equal((await request(named.port, "/")).headers["x-instance"], "web-1");
    assert.equal((await request(named.port, "/version")).headers["x-instance"], "web-1");
    const quiet = await served(t, createLifecycle({ build: "b", instance: "web-1" }));
    assert.equal((await request(quiet.port, "/")).headers["x-instance"], undefined, "it publishes a name, so it is off unless asked");
    const nameless = await served(t, createLifecycle({ build: "b", instanceHeader: true }));
    assert.equal((await request(nameless.port, "/")).headers["x-instance"], undefined);
});

test("serve answers a target no URL can be made of with a 400, and nothing else reads it", async (t) => {
    const seen = [];
    const errors = [];
    const life = createLifecycle({ build: "b", instance: "web-1", instanceHeader: true, onError: (error, where) => errors.push(where) });
    const server = await served(t, life, (req, res) => { seen.push(req.url); res.end(); });
    const answer = await rawRequest(server.port, "//[x");
    assert.equal(answer.status, 400);
    assert.match(answer.raw, /content-type: text\/plain; charset=utf-8/i);
    assert.match(answer.raw, /cache-control: no-store/i);
    assert.match(answer.raw, /x-instance: web-1/i);
    assert.match(answer.raw, /\r\nBad request\.\r\n/);
    assert.deepEqual(seen, []);
    assert.deepEqual(errors, []);
    assert.equal((await request(server.port, "/")).status, 200, "the instance answers the next request");
});

test("serve answers /version with the build, never kept, asking a build function on every request", async (t) => {
    let n = 0;
    const life = createLifecycle({ build: () => `b${++n}` });
    const server = await served(t, life, () => assert.fail("the handler was asked about /version"));
    const first = await request(server.port, "/version");
    assert.equal(first.status, 200);
    assert.equal(first.headers["content-type"], "application/json");
    assert.equal(first.headers["cache-control"], "no-store");
    assert.deepEqual(JSON.parse(first.body), { build: "b1" });
    assert.deepEqual(JSON.parse((await request(server.port, "/version?x=1")).body), { build: "b2" });
});

test("serve answers /healthz 200 with ok, the instance, the build and the details, once the check passes", async (t) => {
    let checks = 0;
    const life = createLifecycle({ build: "b9", instance: "web-2", health: { check: async () => { checks++; }, details: () => ({ pool: 3, waiting: 0 }) } });
    const server = await served(t, life, () => assert.fail("the handler was asked about /healthz"));
    const answer = await request(server.port, "/healthz");
    assert.equal(answer.status, 200);
    assert.equal(answer.headers["cache-control"], "no-store");
    assert.equal(answer.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(answer.body), { ok: true, instance: "web-2", build: "b9", pool: 3, waiting: 0 });
    assert.equal(checks, 1);
});

test("serve answers /healthz with no check, no details and no instance as { ok, build }", async (t) => {
    const server = await served(t, createLifecycle({ build: "b1" }));
    assert.deepEqual(JSON.parse((await request(server.port, "/healthz")).body), { ok: true, build: "b1" });
});

test("a failing health check is a 503 with a fixed body, and its reason goes to onError, never to the body", async (t) => {
    const errors = [];
    const checks = [
        async () => { throw new Error("password authentication failed for user \"app\" at 10.0.0.5"); },
        () => { throw new Error("sync failure with secrets"); },
    ];
    for (const check of checks) {
        const life = createLifecycle({ build: "b", health: { check }, onError: (error, where) => errors.push([where, error.message]) });
        const server = await served(t, life);
        const answer = await request(server.port, "/healthz");
        assert.equal(answer.status, 503);
        assert.equal(answer.headers["cache-control"], "no-store");
        assert.deepEqual(JSON.parse(answer.body), { ok: false, error: "unavailable" });
    }
    assert.deepEqual(errors.map(([where]) => where), ["healthz", "healthz"]);
    assert.match(errors[0][1], /10\.0\.0\.5/);
});

test("a health check that does not answer within timeoutMs is a 503, and onError says how long it waited", async (t) => {
    const errors = [];
    const hung = gate();
    const life = createLifecycle({ build: "b", health: { check: () => hung.promise, timeoutMs: 20 }, onError: (error, where) => errors.push([where, error.message]) });
    const server = await served(t, life);
    const started = Date.now();
    const answer = await request(server.port, "/healthz");
    assert.equal(answer.status, 503);
    assert.deepEqual(JSON.parse(answer.body), { ok: false, error: "unavailable" });
    assert.ok(Date.now() - started < 1000, "the check held the answer");
    assert.deepEqual(errors, [["healthz", "the health check did not answer within 20 ms"]]);
    hung.open();
});

test("a health check that answers in time clears its timer: nothing is reported after the answer", async (t) => {
    const errors = [];
    const life = createLifecycle({ build: "b", health: { check: async () => {}, timeoutMs: 15 }, onError: (error, where) => errors.push(where) });
    const server = await served(t, life);
    assert.equal((await request(server.port, "/healthz")).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(errors, []);
});

test("drain takes the instance out of rotation: /healthz answers 503 stopping with connection: close, and other requests are still answered", async (t) => {
    let checks = 0;
    const life = createLifecycle({ build: "b", health: { check: () => { checks++; } } });
    const server = await served(t, life);
    assert.equal(life.draining, false);
    assert.equal((await request(server.port, "/healthz")).status, 200);
    life.drain();
    assert.equal(life.draining, true);
    const answer = await request(server.port, "/healthz");
    assert.equal(answer.status, 503);
    assert.equal(answer.headers.connection, "close");
    assert.equal(answer.headers["cache-control"], "no-store");
    assert.deepEqual(JSON.parse(answer.body), { ok: false, error: "stopping" });
    assert.equal(checks, 1, "the check was asked while draining");
    assert.equal((await request(server.port, "/anything")).body, "app");
    assert.equal((await request(server.port, "/version")).status, 200);
});

// RFC 9110, 9.1 and 15.5.6: a method the address does not take is a 405 that names, in Allow, the
// ones it does; 9.3.7: a successful OPTIONS sends Allow.
test("serve answers /version and /healthz to GET and HEAD: OPTIONS is a 204 with Allow, any other a 405", async (t) => {
    let checks = 0;
    const life = createLifecycle({ build: "b", health: { check: () => { checks++; } } });
    const server = await served(t, life, () => assert.fail("the handler was asked about the lifecycle's own address"));
    for (const pathname of ["/version", "/healthz"]) {
        for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
            const answer = await request(server.port, pathname, { method });
            assert.equal(answer.status, 405, `${method} ${pathname}`);
            assert.equal(answer.headers.allow, "GET, HEAD", `${method} ${pathname}`);
            assert.equal(answer.headers["cache-control"], "no-store", `${method} ${pathname}`);
            assert.equal(answer.body, "This address takes GET, HEAD.", `${method} ${pathname}`);
        }
        const options = await request(server.port, pathname, { method: "OPTIONS" });
        assert.deepEqual([options.status, options.headers.allow, options.body], [204, "GET, HEAD", ""], pathname);
        const head = await request(server.port, pathname, { method: "HEAD" });
        const told = [head.status, head.headers["content-type"], head.body];
        assert.deepEqual(told, [200, "application/json", ""], pathname);
    }
    assert.equal(checks, 1, "only the HEAD ran the health check");
});

test("serve hands the app's handler every method at any other address", async (t) => {
    const seen = [];
    const life = createLifecycle({ build: "b" });
    const server = await served(t, life, (req, res) => { seen.push(req.method); res.end("app"); });
    for (const method of ["POST", "DELETE", "OPTIONS"]) {
        assert.equal((await request(server.port, "/upload", { method })).body, "app", method);
    }
    assert.deepEqual(seen, ["POST", "DELETE", "OPTIONS"]);
});

test("anything the handler throws is logged as \"request\", and the answer is a 500 whose body says nothing of it", async (t) => {
    const errors = [];
    const life = createLifecycle({ build: "b", onError: (error, where) => errors.push([where, error.message]) });
    const server = await served(t, life, async (req) => {
        if (req.url === "/sync") throw new Error("ENOENT: /srv/app/secret.json");
        await Promise.resolve();
        throw new Error("relation \"users\" does not exist");
    });
    for (const pathname of ["/sync", "/async"]) {
        const answer = await request(server.port, pathname);
        assert.equal(answer.status, 500, pathname);
        assert.equal(answer.headers["content-type"], "text/plain; charset=utf-8");
        assert.equal(answer.headers["cache-control"], "no-store");
        assert.equal(answer.body, "Something went wrong on our side. Try again in a moment.");
    }
    assert.deepEqual(errors, [["request", "ENOENT: /srv/app/secret.json"], ["request", "relation \"users\" does not exist"]]);
});

test("a handler that throws once its answer is under way has that answer ended as it is", async (t) => {
    const errors = [];
    const life = createLifecycle({ build: "b", onError: (error, where) => errors.push(where) });
    const server = await served(t, life, (req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial ");
        throw new Error("mid-answer");
    });
    const answer = await request(server.port, "/");
    assert.equal(answer.status, 200);
    assert.equal(answer.body, "partial ");
    assert.deepEqual(errors, ["request"]);
});

test("the lifecycle's log, unless onError is given, is the console's error stream", async (t) => {
    const lines = [];
    t.mock.method(console, "error", (...args) => lines.push(args));
    const life = createLifecycle({ build: "b" });
    const error = new Error("boom");
    const res = recorder();
    await life.serve(() => { throw error; })({ url: "/", headers: {} }, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(lines, [["  request:", error]]);
});

// ---- jobs -------------------------------------------------------------------------------------

test("start runs each job on its interval, and an atStart job at once too", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const runs = [];
    const life = createLifecycle({
        build: "b",
        jobs: [
            { name: "eager", every: 100, atStart: true, run: () => { runs.push("eager"); } },
            { name: "lazy", every: 250, run: async () => { runs.push("lazy"); } },
        ],
    });
    assert.deepEqual(runs, [], "a job ran before start()");
    life.start();
    await flush();
    assert.deepEqual(runs, ["eager"]);
    t.mock.timers.tick(100); await flush();
    t.mock.timers.tick(100); await flush();
    t.mock.timers.tick(50); await flush();
    assert.deepEqual(runs, ["eager", "eager", "eager", "lazy"]);
    await life.stop();
});

test("a job that throws or rejects is reported as \"job <name>\" and keeps its schedule", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const errors = [];
    let n = 0;
    const life = createLifecycle({
        build: "b",
        onError: (error, where) => errors.push([where, error.message]),
        jobs: [
            { name: "sync", every: 10, run: () => { n++; throw new Error(`sync ${n}`); } },
            { name: "async", every: 10, run: async () => { throw new Error("async"); } },
        ],
    });
    life.start();
    t.mock.timers.tick(10); await flush();
    t.mock.timers.tick(10); await flush();
    assert.deepEqual(errors, [["job sync", "sync 1"], ["job async", "async"], ["job sync", "sync 2"], ["job async", "async"]]);
    await life.stop();
});

test("a job never runs beside itself: a tick while its run is in flight is skipped and counted", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const held = [];
    let active = 0;
    let most = 0;
    const life = createLifecycle({
        build: "b",
        jobs: [
            { name: "slow", every: 10, atStart: true, run: async () => { active++; most = Math.max(most, active); const g = gate(); held.push(g); await g.promise; active--; } },
            { name: "quick", every: 10, run: () => {} },
        ],
    });
    assert.deepEqual(life.skipped, { slow: 0, quick: 0 });
    life.start();
    for (let i = 0; i < 3; i++) { t.mock.timers.tick(10); await flush(); }
    assert.equal(held.length, 1);
    assert.deepEqual(life.skipped, { slow: 3, quick: 0 });
    held[0].open();
    await flush();
    t.mock.timers.tick(10); await flush();
    assert.equal(held.length, 2, "the next tick after the run finished runs it again");
    assert.equal(most, 1);
    held[1].open();
    await life.stop();
});

test("skipped is a copy: writing to it changes nothing", () => {
    const life = createLifecycle({ build: "b", jobs: [{ name: "a", every: 10, run: () => {} }] });
    const copy = life.skipped;
    copy.a = 99;
    assert.deepEqual(life.skipped, { a: 0 });
});

test("start a second time starts nothing more", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let runs = 0;
    const life = createLifecycle({ build: "b", jobs: [{ name: "a", every: 10, atStart: true, run: () => { runs++; } }] });
    life.start();
    life.start();
    await flush();
    assert.equal(runs, 1);
    t.mock.timers.tick(10); await flush();
    assert.equal(runs, 2, "a second start added a second timer");
    await life.stop();
});

test("stop clears the timers and resolves once the runs in flight have finished; a stopped lifecycle does not start again", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const order = [];
    const held = gate();
    const life = createLifecycle({ build: "b", jobs: [{ name: "a", every: 10, atStart: true, run: async () => { order.push("run"); await held.promise; order.push("finished"); } }] });
    life.start();
    await flush();
    const stopped = life.stop().then(() => order.push("stopped"));
    await flush();
    assert.deepEqual(order, ["run"], "stop resolved while a run was in flight");
    held.open();
    await stopped;
    assert.deepEqual(order, ["run", "finished", "stopped"]);
    t.mock.timers.tick(100); await flush();
    life.start();
    t.mock.timers.tick(100); await flush();
    assert.deepEqual(order, ["run", "finished", "stopped"], "a job ran after stop()");
});

test("stop before start resolves, and start after it runs nothing", async () => {
    let runs = 0;
    const life = createLifecycle({ build: "b", jobs: [{ name: "a", every: 10, atStart: true, run: () => { runs++; } }] });
    await life.stop();
    life.start();
    await flush();
    assert.equal(runs, 0);
});

test("a job's timer never keeps the process alive by itself", async () => {
    const kernel = import.meta.resolve("juris-kit/server/kernel.js");
    const script = `
        const { createLifecycle } = await import(${JSON.stringify(kernel)});
        const life = createLifecycle({ build: "b", jobs: [{ name: "hourly", every: 3_600_000, run: () => {} }] });
        life.start();
        console.log("started");`;
    const started = Date.now();
    const { code, stdout } = await new Promise((resolve) => {
        execFile(process.execPath, ["--input-type=module", "-e", script], { timeout: 5000 }, (error, out) => resolve({ code: error ? (error.code ?? error.signal) : 0, stdout: out }));
    });
    assert.equal(code, 0, "the process was kept alive until it was killed");
    assert.equal(stdout.trim(), "started");
    assert.ok(Date.now() - started < 4000);
});
