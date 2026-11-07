// Development reload (server/dev-reload.js): what devReload refuses before it watches anything,
// what it watches (the framework's own directories, restartOn, reloadOn), how a burst of changes
// becomes one decision (restart over reload, once), a failed watcher, the /__reload stream and its
// browser client, and close(). Watchers are a fake `watch` and timers are node:test's mock, except
// in the one test that saves a real file under fs.watch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, mkdir, writeFile, rename, rm, realpath } from "node:fs/promises";
import { devReload } from "juris-kit/server/dev-reload.js";
import { renderDocument } from "juris-kit/server/document.js";

const JURIS_DIR = path.dirname(fileURLToPath(import.meta.resolve("juris")));
const KIT_SERVER_DIR = path.dirname(fileURLToPath(import.meta.resolve("juris-kit/server/dev-reload.js")));
const QUIET_MS = 150;

// An app's directory: server/ (code the server runs), app.mjs, client/ (what browsers load), and
// notes.css beside app.mjs. Removed after the test.
async function app(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "juris-tests-dev-reload-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "server"));
    await mkdir(path.join(root, "client"));
    await writeFile(path.join(root, "server", "index.js"), "export {};\n");
    await writeFile(path.join(root, "app.mjs"), "export {};\n");
    await writeFile(path.join(root, "notes.css"), "a{}\n");
    await writeFile(path.join(root, "client", "theme.css"), "a{}\n");
    await writeFile(path.join(root, "client", "boot.js"), "export {};\n");
    return root;
}

// A stand-in for fs.watch: each watcher it makes records what it watches, and the test makes it
// hear a change (`change(name)`) or fail (`fail()`).
function fakeWatch({ withOn = true, throwOn = Infinity } = {}) {
    const watchers = [];
    const watch = (target, options, listener) => {
        if (watchers.length + 1 >= throwOn) throw Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" });
        const handlers = new Map();
        const watcher = {
            target, options, closed: 0,
            close() { this.closed += 1; },
            change(name) { listener("change", name); },
            fail() { handlers.get("error")(new Error("EPERM")); },
        };
        if (withOn) watcher.on = (event, fn) => { handlers.set(event, fn); return watcher; };
        watchers.push(watcher);
        return watcher;
    };
    const at = (dir) => {
        const found = watchers.find((w) => w.target === dir);
        assert.ok(found, `nothing watches ${dir}`);
        return found;
    };
    return { watch, watchers, at };
}

// A reloader over `root` with a fake watch, recording what it decides.
function reloader(t, root, options = {}) {
    const fake = fakeWatch(options.fake);
    const restarts = [];
    const reloads = [];
    const reload = devReload({
        root,
        restartOn: ["server", "app.mjs"],
        reloadOn: ["client/theme.css", "client/boot.js"],
        onRestart: (file) => restarts.push(file),
        onReload: (file, info) => reloads.push([file, info]),
        watch: fake.watch,
        ...options.reload,
    });
    t.after(() => reload.close());
    return { reload, restarts, reloads, ...fake };
}

// A page's request for the reload stream, and the response it is written to.
function stream() {
    const req = new EventEmitter();
    const res = {
        status: null, headers: null, chunks: [], ended: false,
        writeHead(status, headers) { this.status = status; this.headers = headers; },
        write(chunk) { this.chunks.push(chunk); },
        end() { this.ended = true; },
    };
    return { req, res };
}
const RELOAD_URL = new URL("http://localhost/__reload");
const RELOAD_EVENT = "event: reload\ndata: 1\n\n";

// ---- what is refused --------------------------------------------------------------------------

test("devReload: root is a path or a file: URL, and anything else is refused", async (t) => {
    const message = "devReload: `root` is the directory the watched paths are relative to (a path or a file: URL)";
    for (const root of [undefined, "", 5, null]) {
        assert.throws(() => devReload({ root, onRestart() {}, watch: fakeWatch().watch }), { name: "TypeError", message }, String(root));
    }
    assert.throws(() => devReload(), { name: "TypeError", message }, "no options at all");

    const root = await app(t);
    const { reload, restarts, at } = reloader(t, pathToFileURL(root + path.sep), { reload: { restartOn: ["server"], reloadOn: [] } });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    at(path.join(root, "server")).change("a.js");
    t.mock.timers.tick(QUIET_MS);
    assert.deepEqual(restarts, ["server/a.js"], "a file: URL root names files as a path does");
    reload.close();
});

test("devReload: onRestart is required, and onReload and watch are functions when given", async (t) => {
    const root = await app(t);
    const { watch } = fakeWatch();
    assert.throws(() => devReload({ root, watch }), { name: "TypeError", message: /^devReload: `onRestart\(file\)` is required/ });
    assert.throws(() => devReload({ root, watch, onRestart: "restart" }), { name: "TypeError", message: /^devReload: `onRestart\(file\)` is required/ });
    assert.throws(() => devReload({ root, watch, onRestart() {}, onReload: 1 }), { name: "TypeError", message: "devReload: `onReload(file, { clients })` is a function, when given" });
    assert.throws(() => devReload({ root, onRestart() {}, watch: {} }), { name: "TypeError", message: "devReload: `watch` is a function with fs.watch's signature, when given" });
});

test("devReload: a watched path that is not a relative path to something under the root is refused before anything is watched", async (t) => {
    const root = await app(t);
    const cases = [
        [{ restartOn: "server" }, "devReload: `restartOn` is a list of paths relative to the root"],
        [{ reloadOn: { file: "a.css" } }, "devReload: `reloadOn` is a list of paths relative to the root"],
        [{ restartOn: [""] }, "devReload: `restartOn` holds paths relative to the root, as non-empty strings"],
        [{ reloadOn: [5] }, "devReload: `reloadOn` holds paths relative to the root, as non-empty strings"],
        [{ restartOn: [path.join(root, "server")] }, `devReload: ${path.join(root, "server")} in \`restartOn\` is absolute; paths are relative to the root`],
        [{ restartOn: ["../elsewhere"] }, "devReload: ../elsewhere in `restartOn` is outside the root"],
        [{ reloadOn: ["client/../../x.css"] }, "devReload: client/../../x.css in `reloadOn` is outside the root"],
        [{ reloadOn: ["client/missing.css"] }, "devReload: client/missing.css in `reloadOn` does not exist under the root"],
        // The last bad path refuses the whole reloader, the good ones before it included.
        [{ restartOn: ["server", "app.mjs"], reloadOn: ["client/theme.css", "nope"] }, "devReload: nope in `reloadOn` does not exist under the root"],
    ];
    for (const [options, message] of cases) {
        const { watch, watchers } = fakeWatch();
        assert.throws(() => devReload({ root, onRestart() {}, watch, ...options }), { name: "TypeError", message }, JSON.stringify(options));
        assert.equal(watchers.length, 0, `${JSON.stringify(options)}: nothing is watched`);
    }
});

// ---- what is watched --------------------------------------------------------------------------

test("devReload: the framework's own directories are always watched, recursively, as is a directory restartOn names", async (t) => {
    const root = await app(t);
    const { watchers } = reloader(t, root, { reload: { restartOn: ["server"], reloadOn: [] } });
    assert.deepEqual(watchers.map((w) => [w.target, w.options]), [
        [JURIS_DIR, { recursive: true }],
        [KIT_SERVER_DIR, { recursive: true }],
        [path.join(root, "server"), { recursive: true }],
    ]);
    const none = reloader(t, root, { reload: { restartOn: [], reloadOn: [] } });
    assert.deepEqual(none.watchers.map((w) => w.target), [JURIS_DIR, KIT_SERVER_DIR], "with nothing named, the framework still is");
});

test("devReload: a file is watched through its directory, one watch per directory, and not recursively", async (t) => {
    const root = await app(t);
    const { watchers } = reloader(t, root);
    assert.deepEqual(watchers.slice(3).map((w) => [w.target, w.options]), [
        [root, { recursive: false }],
        [path.join(root, "client"), { recursive: false }],
    ]);
    assert.equal(watchers.length, 5);
});

// ---- one decision per burst -------------------------------------------------------------------

test("devReload: a change under restartOn restarts once 150 ms pass without another, named relative to the root", async (t) => {
    const root = await app(t);
    const { restarts, reloads, at } = reloader(t, root);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    at(path.join(root, "server")).change(path.join("lib", "a.js"));
    t.mock.timers.tick(QUIET_MS - 1);
    assert.deepEqual(restarts, [], "not before the quiet time");
    t.mock.timers.tick(1);
    assert.deepEqual(restarts, ["server/lib/a.js"]);
    assert.deepEqual(reloads, []);
});

test("devReload: a change a watcher cannot name counts as the directory, and a Buffer name is read as text", async (t) => {
    const root = await app(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const nameless = reloader(t, root);
    nameless.at(path.join(root, "server")).change(null);
    t.mock.timers.tick(QUIET_MS);
    assert.deepEqual(nameless.restarts, ["server"]);

    const buffer = reloader(t, root);
    buffer.at(path.join(root, "server")).change(Buffer.from("b.js"));
    t.mock.timers.tick(QUIET_MS);
    assert.deepEqual(buffer.restarts, ["server/b.js"]);
});

test("devReload: a change to the framework's own code restarts, named by its full path", async (t) => {
    const root = await app(t);
    const { restarts, at } = reloader(t, root);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    at(KIT_SERVER_DIR).change("modules.js");
    t.mock.timers.tick(QUIET_MS);
    assert.deepEqual(restarts, [`${KIT_SERVER_DIR}/modules.js`]);
});

test("devReload: the root itself in restartOn names its files relative to it", async (t) => {
    const root = await app(t);
    const { restarts, at } = reloader(t, root, { reload: { restartOn: ["."], reloadOn: [] } });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    at(root).change("app.mjs");
    t.mock.timers.tick(QUIET_MS);
    assert.equal(restarts.length, 1);
    assert.equal(path.posix.normalize(restarts[0]), "app.mjs");
});

test("devReload: each change within 150 ms of the last pushes the decision back, so a burst is one decision", async (t) => {
    const root = await app(t);
    const { restarts, at } = reloader(t, root);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = at(path.join(root, "server"));
    server.change("a.js");
    t.mock.timers.tick(100);
    server.change("b.js");
    t.mock.timers.tick(100);
    server.change("c.js");
    t.mock.timers.tick(QUIET_MS - 1);
    assert.deepEqual(restarts, [], "the burst is still going");
    t.mock.timers.tick(1);
    assert.equal(restarts.length, 1);
    assert.ok(["server/a.js", "server/b.js", "server/c.js"].includes(restarts[0]), restarts[0]);
});

test("devReload: a burst that touched anything restartOn covers restarts, whatever else it touched and in whatever order", async (t) => {
    const root = await app(t);
    for (const order of [["reload", "restart"], ["restart", "reload"], ["reload", "restart", "reload"]]) {
        const { reload, restarts, reloads, at } = reloader(t, root);
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const page = stream();
        reload.handle(page.req, page.res, RELOAD_URL);
        for (const action of order) {
            if (action === "reload") at(path.join(root, "client")).change("theme.css");
            else at(root).change("app.mjs");
        }
        t.mock.timers.tick(QUIET_MS);
        assert.deepEqual(restarts, ["app.mjs"], order.join(", "));
        assert.deepEqual(reloads, [], `${order.join(", ")}: no reload beside a restart`);
        assert.ok(!page.res.chunks.includes(RELOAD_EVENT), "the pages are not told to reload: the restart does it");
        t.mock.timers.reset();
    }
});

test("devReload: onRestart is called once, and nothing this process hears after it counts", async (t) => {
    const root = await app(t);
    const { restarts, reloads, at } = reloader(t, root);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    at(root).change("app.mjs");
    t.mock.timers.tick(QUIET_MS);
    at(root).change("app.mjs");
    at(path.join(root, "server")).change("x.js");
    at(path.join(root, "client")).change("theme.css");
    t.mock.timers.tick(QUIET_MS * 2);
    assert.deepEqual(restarts, ["app.mjs"]);
    assert.deepEqual(reloads, []);
});

test("devReload: a change to a reloadOn file runs onReload with the open pages' count first, then tells every page to reload", async (t) => {
    const root = await app(t);
    const pages = [stream(), stream()];
    const seenByPagesAtReload = [];
    const { reload, restarts, reloads, at } = reloader(t, root, {
        reload: { onReload: (file, info) => { reloads.push([file, info]); seenByPagesAtReload.push(pages.map((p) => p.res.chunks.includes(RELOAD_EVENT))); } },
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const { req, res } of pages) assert.equal(reload.handle(req, res, RELOAD_URL), true);
    at(path.join(root, "client")).change("theme.css");
    t.mock.timers.tick(QUIET_MS);
    assert.deepEqual(reloads, [["client/theme.css", { clients: 2 }]]);
    assert.deepEqual(seenByPagesAtReload, [[false, false]], "onReload ran before any page was told");
    for (const { res } of pages) assert.equal(res.chunks.at(-1), RELOAD_EVENT);
    assert.deepEqual(restarts, []);

    // Another burst later is another decision.
    at(path.join(root, "client")).change("boot.js");
    t.mock.timers.tick(QUIET_MS);
    assert.deepEqual(reloads.at(-1), ["client/boot.js", { clients: 2 }]);
    for (const { res } of pages) assert.equal(res.chunks.filter((c) => c === RELOAD_EVENT).length, 2);
});

test("devReload: with no onReload, the pages are still told to reload", async (t) => {
    const root = await app(t);
    const { watch, at } = fakeWatch();
    const reload = devReload({ root, reloadOn: ["client/theme.css"], onRestart() {}, watch });
    t.after(() => reload.close());
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const page = stream();
    reload.handle(page.req, page.res, RELOAD_URL);
    at(path.join(root, "client")).change("theme.css");
    t.mock.timers.tick(QUIET_MS);
    assert.equal(page.res.chunks.at(-1), RELOAD_EVENT);
});

test("devReload: a directory's watcher hears only the files named in it; a change it cannot name may be any of them", async (t) => {
    const root = await app(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const filtered = reloader(t, root);
    filtered.at(root).change("README.md");
    filtered.at(path.join(root, "client")).change("other.css");
    t.mock.timers.tick(QUIET_MS);
    assert.deepEqual([filtered.restarts, filtered.reloads], [[], []], "a file nobody named is no change");

    const nameless = reloader(t, root);
    nameless.at(path.join(root, "client")).change(undefined);
    t.mock.timers.tick(QUIET_MS);
    assert.equal(nameless.reloads.length, 1);
    assert.ok(["client/theme.css", "client/boot.js"].includes(nameless.reloads[0][0]));

    // In a directory that holds both kinds, a change it cannot name restarts.
    const mixed = reloader(t, root, { reload: { restartOn: ["app.mjs"], reloadOn: ["notes.css"] } });
    mixed.at(root).change(null);
    t.mock.timers.tick(QUIET_MS);
    assert.deepEqual(mixed.restarts, ["app.mjs"]);
    assert.deepEqual(mixed.reloads, []);
});

test("devReload: a file named in both restartOn and reloadOn restarts", async (t) => {
    const root = await app(t);
    const { restarts, reloads, at } = reloader(t, root, { reload: { restartOn: ["app.mjs"], reloadOn: ["app.mjs"] } });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    at(root).change("app.mjs");
    t.mock.timers.tick(QUIET_MS);
    assert.deepEqual(restarts, ["app.mjs"]);
    assert.deepEqual(reloads, []);
});

// ---- a watcher that fails ---------------------------------------------------------------------

test("devReload: a watcher that fails counts as a change to what it watched", async (t) => {
    const root = await app(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const framework = reloader(t, root);
    framework.at(JURIS_DIR).fail();
    t.mock.timers.tick(QUIET_MS);
    assert.deepEqual(framework.restarts, [JURIS_DIR]);

    const directory = reloader(t, root);
    directory.at(path.join(root, "server")).fail();
    t.mock.timers.tick(QUIET_MS);
    assert.deepEqual(directory.restarts, ["server"]);

    const files = reloader(t, root);
    files.at(path.join(root, "client")).fail();
    t.mock.timers.tick(QUIET_MS);
    assert.equal(files.reloads.length, 1, "what only reloads, reloads");
    assert.ok(["client/theme.css", "client/boot.js"].includes(files.reloads[0][0]));
    assert.deepEqual(files.restarts, []);

    const restartFile = reloader(t, root);
    restartFile.at(root).fail();
    t.mock.timers.tick(QUIET_MS);
    assert.deepEqual(restartFile.restarts, ["app.mjs"]);
});

test("devReload: a watch with no error events (a test's stand-in) is accepted", async (t) => {
    const root = await app(t);
    const { reload, restarts, watchers, at } = reloader(t, root, { fake: { withOn: false } });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    at(root).change("app.mjs");
    t.mock.timers.tick(QUIET_MS);
    assert.deepEqual(restarts, ["app.mjs"]);
    reload.close();
    assert.ok(watchers.every((w) => w.closed === 1));
});

test("devReload: when a watch cannot be made, the ones made already are closed and the error is thrown", async (t) => {
    const root = await app(t);
    const { watch, watchers } = fakeWatch({ throwOn: 4 });
    assert.throws(() => devReload({ root, restartOn: ["server", "app.mjs"], reloadOn: ["client/theme.css"], onRestart() {}, watch }), { code: "EMFILE" });
    assert.equal(watchers.length, 3);
    assert.ok(watchers.every((w) => w.closed === 1), "every watcher made was closed");
});

// ---- the page's stream ------------------------------------------------------------------------

test("devReload: handle answers /__reload with an event stream that names this process, and false for any other path", async (t) => {
    const root = await app(t);
    const { reload } = reloader(t, root);
    const other = stream();
    assert.equal(reload.handle(other.req, other.res, new URL("http://localhost/__reload/x")), false);
    assert.equal(reload.handle(other.req, other.res, new URL("http://localhost/app.js?__reload")), false);
    assert.deepEqual([other.res.status, other.res.chunks], [null, []], "another URL is left as it was");

    const page = stream();
    assert.equal(reload.handle(page.req, page.res, new URL("http://localhost/__reload?since=1")), true);
    assert.equal(page.res.status, 200);
    assert.deepEqual(page.res.headers, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const [first] = page.res.chunks;
    const match = /^retry: 1000\n\nevent: build\ndata: ([^\n]+)\n\n$/.exec(first);
    assert.ok(match, JSON.stringify(first));
    assert.equal(page.res.ended, false, "the stream stays open");

    const again = stream();
    reload.handle(again.req, again.res, RELOAD_URL);
    assert.equal(again.res.chunks[0], first, "one process, one name");
});

test("devReload: each reloader names its own process with an id of its own", async (t) => {
    const root = await app(t);
    const ids = new Set();
    for (let i = 0; i < 3; i++) {
        const { reload } = reloader(t, root);
        const page = stream();
        reload.handle(page.req, page.res, RELOAD_URL);
        ids.add(/data: ([^\n]+)/.exec(page.res.chunks[0])[1]);
    }
    assert.equal(ids.size, 3, "three processes, three names");
});

test("devReload: a page that closes its stream is no longer counted or written to", async (t) => {
    const root = await app(t);
    const { reload, reloads, at } = reloader(t, root);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const [stays, leaves] = [stream(), stream()];
    reload.handle(stays.req, stays.res, RELOAD_URL);
    reload.handle(leaves.req, leaves.res, RELOAD_URL);
    leaves.req.emit("close");
    at(path.join(root, "client")).change("theme.css");
    t.mock.timers.tick(QUIET_MS);
    assert.deepEqual(reloads, [["client/theme.css", { clients: 1 }]]);
    assert.equal(stays.res.chunks.at(-1), RELOAD_EVENT);
    assert.ok(!leaves.res.chunks.includes(RELOAD_EVENT));
});

test("devReload: close() ends the open streams, stops watching and drops a decision still pending; a second close does nothing", async (t) => {
    const root = await app(t);
    const { reload, restarts, reloads, watchers, at } = reloader(t, root);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const page = stream();
    reload.handle(page.req, page.res, RELOAD_URL);
    at(root).change("app.mjs");
    reload.close();
    t.mock.timers.tick(QUIET_MS * 2);
    assert.deepEqual(restarts, [], "the pending restart was dropped");
    assert.equal(page.res.ended, true);
    assert.ok(watchers.every((w) => w.closed === 1), "every watcher was closed");

    reload.close();
    assert.ok(watchers.every((w) => w.closed === 1), "closed once, not twice");

    at(path.join(root, "client")).change("theme.css");
    t.mock.timers.tick(QUIET_MS);
    assert.deepEqual([restarts, reloads], [[], []], "nothing heard after close counts");
});

test("devReload: a stream opened after close() gets its first lines and ends at once", async (t) => {
    const root = await app(t);
    const { reload } = reloader(t, root);
    const before = stream();
    reload.handle(before.req, before.res, RELOAD_URL);
    reload.close();
    const after = stream();
    assert.equal(reload.handle(after.req, after.res, RELOAD_URL), true);
    assert.equal(after.res.status, 200);
    assert.deepEqual(after.res.chunks, before.res.chunks.slice(0, 1));
    assert.equal(after.res.ended, true);
});

// ---- the browser's client ---------------------------------------------------------------------

test("devReload: the client listens at /__reload, and reloads on a reload event or on another process's build", async (t) => {
    const root = await app(t);
    const { reload } = reloader(t, root);
    assert.doesNotThrow(() => renderDocument({}, { entry: "/boot.js", devReload: reload.script }), "renderDocument takes it as it is");

    const run = () => {
        const sources = [];
        const location = { reloads: 0, reload() { this.reloads += 1; } };
        class EventSource {
            constructor(url) { this.url = url; this.listeners = new Map(); sources.push(this); }
            addEventListener(type, fn) { this.listeners.set(type, fn); }
        }
        vm.runInNewContext(reload.script, { EventSource, location });
        assert.equal(sources.length, 1);
        return { source: sources[0], location };
    };

    const first = run();
    assert.equal(first.source.url, "/__reload");
    const build = first.source.listeners.get("build");
    build({ data: "one" });
    build({ data: "one" });
    assert.equal(first.location.reloads, 0, "the process it first heard, heard again: no reload");
    build({ data: "two" });
    assert.equal(first.location.reloads, 1, "another process answered: reload");

    const second = run();
    second.source.listeners.get("reload")({ data: "1" });
    assert.equal(second.location.reloads, 1, "an explicit reload");
});

// ---- the real fs.watch ------------------------------------------------------------------------

test("devReload: under fs.watch, saving a reloadOn file by renaming a copy over it reloads, and so does the next save", async (t) => {
    const root = await realpath(await app(t));
    const reloads = [];
    const restarts = [];
    const reload = devReload({ root, reloadOn: ["client/theme.css"], onRestart: (file) => restarts.push(file), onReload: (file) => reloads.push(file) });
    t.after(() => reload.close());
    // The quiet time is the mock's; real time passes on a real interval, ticking it as events come.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const waitFor = (done, ms) => new Promise((resolve) => {
        const started = Date.now();
        const poll = setInterval(() => {
            t.mock.timers.tick(QUIET_MS);
            if (done() || Date.now() - started >= ms) { clearInterval(poll); resolve(); }
        }, 5);
    });
    let saves = 0;
    const save = async () => {
        const copy = path.join(root, "client", `.theme.css.${++saves}.tmp`);
        await writeFile(copy, `a{order:${saves}}\n`);
        await rename(copy, path.join(root, "client", "theme.css"));
    };
    // A watch can start hearing a moment after fs.watch returns (macOS restarts its event stream as
    // watches come and go), so the first save is made again until one is heard.
    for (let i = 0; i < 30 && reloads.length === 0; i++) {
        await save();
        await waitFor(() => reloads.length > 0, 100);
    }
    assert.ok(reloads.length > 0, "a save was heard");
    reloads.length = 0;
    await save();
    await waitFor(() => reloads.length > 0, 3000);
    assert.ok(reloads.length > 0, "the next save, renamed over the file again, was heard too");
    assert.ok(reloads.every((file) => file === "client/theme.css"), reloads.join(", "));
    assert.deepEqual(restarts, []);
});
