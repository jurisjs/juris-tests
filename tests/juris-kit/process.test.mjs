// server/process.js, held to REFERENCE.md's "server/process.js" and "One worker per instance, behind a
// sticky balancer": startProcess serves in this process or forks workers, refuses workers beside live
// queries before anything is forked, forks each with the same env and an id of its own, and replaces
// one that exits unasked after a wait that doubles. A stand-in cluster and clock for the rules, and
// child processes (tests/support/process-entry.mjs) for an entry on Node's own cluster, its exit and
// its console.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startProcess } from "juris-kit/server/process.js";

const ENTRY = fileURLToPath(new URL("../support/process-entry.mjs", import.meta.url));

// A cluster that records its forks instead of making processes.
function fakeCluster({ isPrimary = true } = {}) {
    const cluster = new EventEmitter();
    cluster.isPrimary = isPrimary;
    cluster.forks = [];
    cluster.fork = (env) => {
        const worker = { id: cluster.forks.length + 1, env };
        cluster.forks.push(worker);
        return worker;
    };
    return cluster;
}

// A clock the test moves: setTimeout queues, runNext runs the next one after its wait.
function fakeTimers() {
    const timers = { clock: 0, pending: [] };
    timers.setTimeout = (fn, ms) => { timers.pending.push({ fn, ms }); };
    timers.now = () => timers.clock;
    timers.runNext = () => {
        const next = timers.pending.shift();
        timers.clock += next.ms;
        next.fn();
        return next.ms;
    };
    return timers;
}

// A log that keeps what it is told.
function recordingLog() {
    const log = { lines: [], errors: [] };
    log.log = (line) => log.lines.push(line);
    log.error = (line) => log.errors.push(line);
    return log;
}

// Runs the entry in a child process: { code, stdout, stderr }.
function runEntry(mode) {
    return new Promise((resolve) => {
        execFile(process.execPath, [ENTRY, mode], { timeout: 8000 }, (error, stdout, stderr) => {
            resolve({ code: error ? error.code : 0, signal: error?.signal ?? null, stdout, stderr });
        });
    });
}

// ---- serving in this process ------------------------------------------------------------------

test("one worker serves in this process, beside live queries or not, and forks nothing", () => {
    for (const workers of [undefined, 1, 0, -2]) {
        const cluster = fakeCluster();
        const log = recordingLog();
        assert.equal(startProcess({ workers, cluster, log }), "serve", String(workers));
        assert.equal(cluster.forks.length, 0);
        assert.equal(cluster.listenerCount("exit"), 0);
        assert.deepEqual(log.errors, []);
    }
    assert.equal(startProcess(), "serve", "no options at all");
});

test("a worker the primary forked serves, and forks nothing itself", () => {
    const cluster = fakeCluster({ isPrimary: false });
    assert.equal(startProcess({ workers: 4, liveQueries: false, cluster }), "serve");
    assert.equal(startProcess({ workers: 4, allow: true, cluster }), "serve");
    assert.equal(cluster.forks.length, 0);
    assert.equal(cluster.listenerCount("exit"), 0);
});

// ---- the refusal ------------------------------------------------------------------------------

test("more than one worker beside live queries is refused before anything is forked: logged, and exit(1) called", () => {
    const cluster = fakeCluster();
    const log = recordingLog();
    const exits = [];
    // A real exit does not return; this one does, and the entry must still not go on.
    assert.throws(() => startProcess({ workers: 2, cluster, log, exit: (code) => exits.push(code) }), { name: "Error", message: /2 workers on one port would break live queries/ });
    assert.deepEqual(exits, [1]);
    assert.equal(log.errors.length, 1);
    assert.match(log.errors[0], /^2 workers on one port would break live queries/);
    assert.equal(cluster.forks.length, 0, "a worker was forked before the refusal");
    assert.equal(cluster.listenerCount("exit"), 0);
});

test("the refusal says why and what to do instead, unless the app gives its own words", () => {
    const why = (options) => {
        try { startProcess({ cluster: fakeCluster(), ...options }); } catch (error) { return error.message; }
        return assert.fail("not refused");
    };
    const message = why({ workers: 3 });
    assert.match(message, /^3 workers on one port would break live queries/);
    assert.match(message, /separate connections/);
    assert.match(message, /403/);
    assert.match(message, /several instances behind a sticky balancer instead, or one worker/);
    assert.equal(why({ workers: 3, refusal: "WEB_WORKERS=3 needs ALLOW_WORKERS=1" }), "WEB_WORKERS=3 needs ALLOW_WORKERS=1");
    const asked = [];
    assert.equal(why({ workers: 5, refusal: (n) => { asked.push(n); return `no ${n}`; } }), "no 5");
    assert.deepEqual(asked, [5]);
    assert.equal(why({ workers: 2, refusal: 42 }), "42");
});

test("without an exit, the refusal is thrown, and nothing is logged or forked", () => {
    const cluster = fakeCluster();
    const log = recordingLog();
    assert.throws(() => startProcess({ workers: 2, liveQueries: true, cluster, log }), { name: "Error", message: /would break live queries/ });
    assert.deepEqual(log.errors, []);
    assert.equal(cluster.forks.length, 0);
});

test("a refusal with an exit and no log is written to the console's error stream", (t) => {
    const errors = [];
    t.mock.method(console, "error", (line) => errors.push(line));
    assert.throws(() => startProcess({ workers: 2, cluster: fakeCluster(), exit: () => {} }), /would break live queries/);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^2 workers on one port/);
});

test("allow runs workers beside live queries anyway, and an app without live queries runs them unasked", () => {
    for (const options of [{ allow: true }, { liveQueries: false }, { allow: true, liveQueries: false }]) {
        const cluster = fakeCluster();
        assert.equal(startProcess({ workers: 3, cluster, ...options }), "primary", JSON.stringify(options));
        assert.equal(cluster.forks.length, 3);
    }
});

// ---- the options ------------------------------------------------------------------------------

test("env, workerIdEnv and exit that are not what they say are refused with a TypeError, before anything else", () => {
    const cluster = fakeCluster();
    for (const env of [null, "BUILD=1", 5, true]) {
        assert.throws(() => startProcess({ workers: 2, liveQueries: false, env, cluster }), { name: "TypeError", message: /env is the variables every worker is forked with/ }, String(env));
    }
    for (const workerIdEnv of [5, {}, true]) {
        assert.throws(() => startProcess({ workers: 2, liveQueries: false, workerIdEnv, cluster }), { name: "TypeError", message: /workerIdEnv is a variable's name, or null/ }, String(workerIdEnv));
    }
    for (const exit of ["process.exit", 1, {}]) {
        assert.throws(() => startProcess({ workers: 2, exit, cluster }), { name: "TypeError", message: /exit is a function/ }, String(exit));
    }
    assert.equal(cluster.forks.length, 0);
});

test("a backoff value that is not a whole number of milliseconds is refused with a TypeError naming it", () => {
    for (const name of ["minMs", "maxMs", "resetAfterMs"]) {
        for (const value of [-1, 1.5, "1000", NaN, Infinity, null]) {
            const cluster = fakeCluster();
            assert.throws(
                () => startProcess({ workers: 2, liveQueries: false, cluster, backoff: { [name]: value } }),
                { name: "TypeError", message: `startProcess: backoff.${name} is a whole number of milliseconds, not ${String(value)}` },
                `${name}: ${String(value)}`,
            );
            assert.equal(cluster.forks.length, 0);
        }
    }
    assert.equal(startProcess({ workers: 1, backoff: null }), "serve", "a null backoff is the defaults");
    assert.equal(startProcess({ workers: 1, backoff: { minMs: 0, maxMs: 0, resetAfterMs: 0 } }), "serve");
});

// ---- the primary ------------------------------------------------------------------------------

test("the primary forks every worker with the same env and an id of its own, \"1\" to n, in workerIdEnv", () => {
    const cluster = fakeCluster();
    const env = { BUILD_ID: "b42" };
    assert.equal(startProcess({ workers: 3, liveQueries: false, env, workerIdEnv: "WORKER_ID", cluster }), "primary");
    assert.deepEqual(cluster.forks.map((worker) => worker.env), [
        { BUILD_ID: "b42", WORKER_ID: "1" },
        { BUILD_ID: "b42", WORKER_ID: "2" },
        { BUILD_ID: "b42", WORKER_ID: "3" },
    ]);
    assert.deepEqual(env, { BUILD_ID: "b42" }, "the app's env was written into");
    assert.notEqual(cluster.forks[0].env, cluster.forks[1].env, "two workers share one env object");
});

test("without workerIdEnv, every worker is forked with a copy of env alone", () => {
    const cluster = fakeCluster();
    const env = { BUILD_ID: "b42" };
    startProcess({ workers: 2, liveQueries: false, env, cluster });
    assert.deepEqual(cluster.forks.map((worker) => worker.env), [{ BUILD_ID: "b42" }, { BUILD_ID: "b42" }]);
    assert.notEqual(cluster.forks[0].env, env);
    const bare = fakeCluster();
    startProcess({ workers: 2, liveQueries: false, cluster: bare });
    assert.deepEqual(bare.forks.map((worker) => worker.env), [{}, {}]);
});

test("a worker that exits cleanly, or on SIGTERM or SIGINT, was asked to stop and is not replaced", () => {
    const cluster = fakeCluster();
    const timers = fakeTimers();
    const log = recordingLog();
    const heard = [];
    startProcess({ workers: 3, liveQueries: false, cluster, timers, log });
    cluster.emit("exit", cluster.forks[0], 0, null);
    cluster.emit("exit", cluster.forks[1], null, "SIGTERM");
    cluster.emit("exit", cluster.forks[2], null, "SIGINT");
    assert.equal(timers.pending.length, 0);
    assert.equal(cluster.forks.length, 3);
    assert.deepEqual(log.lines, []);
    // The app's own hook is not told of them either.
    const told = fakeCluster();
    startProcess({ workers: 2, liveQueries: false, cluster: told, timers, onWorkerExit: (...args) => heard.push(args) });
    told.emit("exit", told.forks[0], 0, null);
    assert.deepEqual(heard, []);
});

test("a worker that exits unasked is told to onWorkerExit, then replaced after minMs with the same env and the id r", () => {
    const cluster = fakeCluster();
    const timers = fakeTimers();
    const log = recordingLog();
    const heard = [];
    startProcess({
        workers: 2, liveQueries: false, env: { BUILD_ID: "b1" }, workerIdEnv: "WORKER_ID", cluster, timers, log,
        onWorkerExit: (worker, code, signal) => heard.push({ id: worker.id, code, signal, forks: cluster.forks.length }),
    });
    cluster.emit("exit", cluster.forks[1], 1, null);
    assert.deepEqual(heard, [{ id: 2, code: 1, signal: null, forks: 2 }], "told before the replacement");
    assert.equal(cluster.forks.length, 2, "replaced at once");
    assert.equal(timers.runNext(), 1000);
    assert.equal(cluster.forks.length, 3);
    assert.deepEqual(cluster.forks[2].env, { BUILD_ID: "b1", WORKER_ID: "r" });
    cluster.emit("exit", cluster.forks[0], null, "SIGKILL");
    assert.equal(heard.at(-1).signal, "SIGKILL");
    timers.runNext();
    assert.deepEqual(cluster.forks[3].env, { BUILD_ID: "b1", WORKER_ID: "r" });
    assert.deepEqual(log.lines, [], "the app's hook replaces the log");
});

test("a replacement is written to log.log, unless onWorkerExit is given: the worker, its signal or code, and the wait", () => {
    const cluster = fakeCluster();
    const timers = fakeTimers();
    const log = recordingLog();
    startProcess({ workers: 2, liveQueries: false, cluster, timers, log });
    cluster.emit("exit", cluster.forks[1], 1, null);
    cluster.emit("exit", cluster.forks[0], null, "SIGKILL");
    assert.deepEqual(log.lines, [
        "  worker 2 exited (1), replacing it in 1 s",
        "  worker 1 exited (SIGKILL), replacing it in 2 s",
    ]);
});

test("a replacement is written to the console unless a log is given", (t) => {
    const lines = [];
    t.mock.method(console, "log", (line) => lines.push(line));
    const cluster = fakeCluster();
    startProcess({ workers: 2, liveQueries: false, cluster, timers: fakeTimers() });
    cluster.emit("exit", cluster.forks[0], 7, null);
    assert.deepEqual(lines, ["  worker 1 exited (7), replacing it in 1 s"]);
});

test("the wait doubles from minMs to maxMs while workers keep dying young", () => {
    const cluster = fakeCluster();
    const timers = fakeTimers();
    startProcess({ workers: 2, liveQueries: false, cluster, timers, log: recordingLog() });
    const waits = [];
    for (let i = 0; i < 8; i++) {
        cluster.emit("exit", cluster.forks.at(-1), 1, null);
        waits.push(timers.runNext());
    }
    assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    assert.equal(cluster.forks.length, 10);
});

test("the backoff takes the app's minMs and maxMs", () => {
    const cluster = fakeCluster();
    const timers = fakeTimers();
    startProcess({ workers: 2, liveQueries: false, cluster, timers, log: recordingLog(), backoff: { minMs: 100, maxMs: 500 } });
    const waits = [];
    for (let i = 0; i < 5; i++) {
        cluster.emit("exit", cluster.forks.at(-1), 1, null);
        waits.push(timers.runNext());
    }
    assert.deepEqual(waits, [100, 200, 400, 500, 500]);
});

test("a minMs of 0 replaces the first at once, and the next wait still grows: never a fork loop", () => {
    const cluster = fakeCluster();
    const timers = fakeTimers();
    startProcess({ workers: 2, liveQueries: false, cluster, timers, log: recordingLog(), backoff: { minMs: 0, maxMs: 8 } });
    const waits = [];
    for (let i = 0; i < 6; i++) {
        cluster.emit("exit", cluster.forks.at(-1), 1, null);
        waits.push(timers.runNext());
    }
    assert.deepEqual(waits, [0, 1, 2, 4, 8, 8]);
});

test("a worker that ran at least resetAfterMs before it died starts the count over; one that ran less does not", () => {
    const cluster = fakeCluster();
    const timers = fakeTimers();
    startProcess({ workers: 2, liveQueries: false, cluster, timers, log: recordingLog(), backoff: { minMs: 10, maxMs: 1000, resetAfterMs: 500 } });
    const crash = () => { cluster.emit("exit", cluster.forks.at(-1), 1, null); return timers.runNext(); };
    assert.deepEqual([crash(), crash(), crash()], [10, 20, 40]);
    timers.clock += 499;                                   // the newest worker ran 499 ms
    assert.equal(crash(), 80, "a worker that died young reset the count");
    timers.clock += 500;                                   // exactly resetAfterMs
    assert.equal(crash(), 10);
    assert.equal(crash(), 20);
    timers.clock += 60_000;
    assert.equal(crash(), 10);
});

test("a worker the primary did not fork is replaced too, with no change to the count", () => {
    const cluster = fakeCluster();
    const timers = fakeTimers();
    startProcess({ workers: 2, liveQueries: false, cluster, timers, log: recordingLog(), backoff: { minMs: 10, resetAfterMs: 100 } });
    cluster.emit("exit", cluster.forks[0], 1, null);
    assert.equal(timers.runNext(), 10);
    timers.clock += 10_000;
    cluster.emit("exit", { id: 99 }, 1, null);             // no birth on record: nothing says it lived long
    assert.equal(timers.runNext(), 20);
    assert.equal(cluster.forks.length, 4);
});

test("without timers, a replacement waits on Node's own clock", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const cluster = fakeCluster();
    startProcess({ workers: 2, liveQueries: false, cluster, log: recordingLog(), backoff: { minMs: 100, resetAfterMs: 1000 } });
    cluster.emit("exit", cluster.forks[0], 1, null);
    t.mock.timers.tick(99);
    assert.equal(cluster.forks.length, 2);
    t.mock.timers.tick(1);
    assert.equal(cluster.forks.length, 3);
    // Its birth is on Node's clock too: one that lived a second resets the wait.
    cluster.emit("exit", cluster.forks[2], 1, null);
    t.mock.timers.tick(200);
    assert.equal(cluster.forks.length, 4);
    t.mock.timers.tick(1000);
    cluster.emit("exit", cluster.forks[3], 1, null);
    t.mock.timers.tick(100);
    assert.equal(cluster.forks.length, 5, "the wait did not start over");
});

// ---- an entry on Node's own cluster, in a child process --------------------------------------

test("an entry that calls it at its top level with no exit stops there, with the message and exit code 1", async () => {
    const { code, stdout, stderr } = await runEntry("refuse-throw");
    assert.equal(code, 1);
    assert.match(stderr, /2 workers on one port would break live queries/);
    assert.doesNotMatch(stdout, /still running/);
});

test("an entry's own exit is called with 1, after the refusal is written to the console", async () => {
    const { code, stdout, stderr } = await runEntry("refuse-exit");
    assert.equal(code, 1);
    assert.match(stderr, /^2 workers on one port would break live queries/);
    assert.doesNotMatch(stdout, /still running/);
});

test("on Node's cluster, every worker gets the env and its id, and one that crashes is replaced with the id r", async () => {
    const { code, signal, stdout, stderr } = await runEntry("cluster");
    assert.equal(code, 0, `the primary ended with ${code ?? signal}: ${stderr}`);
    const lines = stdout.trimEnd().split("\n");
    const summary = JSON.parse(lines.at(-1));
    assert.equal(summary.role, "primary");
    assert.equal(summary.isPrimary, true);
    const seen = summary.seen.sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(seen, [
        { role: "serve", id: "1", build: "b7", isWorker: true },
        { role: "serve", id: "2", build: "b7", isWorker: true },
        { role: "serve", id: "r", build: "b7", isWorker: true },
    ]);
    assert.ok(lines.some((line) => /^ {2}worker \d+ exited \(3\), replacing it in 0\.02 s$/.test(line)), stdout);
});
