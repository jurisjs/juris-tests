// Serving modules (server/modules.js): what handle answers for a mount, an asset and the framework's
// /src/, development (the disk, every time, no-store) against production (the boot snapshot,
// minified once), the 404 for a name with no file behind it, the code id, versioned(), caching
// (immutable only under this process's code id), clear(), and listModules.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { readdir, rm, mkdir, chmod } from "node:fs/promises";
import { createModuleServer, listModules } from "juris-kit/server/modules.js";
import { minifyJs, minifyCss } from "juris-kit/server/minify.js";
import { appDir, put, ask, JURIS_DIR } from "../support/modules-app.mjs";

const A = "// a, with a comment the minifier drops\nexport const a = 1;\n";
const FILES = {
    "app/a.js": A,
    "app/b.js": "export const b = 2;\n",
    "app/twin.js": A,
    "app/lib/c.js": "export const c = 3;\n",
    "app/lib/deep/d.js": "export const d = 4;\n",
    "app/a.b.js": "export {};\n",
    "app/style.css": "/* site */\n.a  >  .b { color : red ; }\n",
    "boot.js": "/* the entry */\nexport function start() {}\n",
    "site.css": "body { margin: 0; }\n",
};
const MOUNTS = [{ url: "/app/", dir: "app", depth: 1, only: [".js", ".css"] }];
const CACHE = {
    immutable: "public, max-age=31536000, immutable",
    public: "public, max-age=0, must-revalidate",
    "no-store": "no-store",
};
const server = (root, options = {}) => createModuleServer({ root, build: "b1", mounts: MOUNTS, assets: ["/boot.js", "/site.css"], ...options });

// ---- what handle answers ----------------------------------------------------------------------

test("handle: a URL the mounts or assets name is answered (true); any other is the app's (false), and nothing is written", async (t) => {
    const root = await appDir(t, FILES);
    for (const dev of [true, false]) {
        const modules = await server(root, { dev });
        for (const url of ["/app/a.js", "/app/lib/c.js", "/app/style.css", "/boot.js", "/site.css"]) {
            const answer = await ask(modules, url);
            assert.deepEqual([answer.handled, answer.status], [true, 200], `${url} (dev: ${dev})`);
        }
        for (const url of [
            "/", "/other/a.js", "/app/", "/app/lib/deep/d.js",      // no mount, or deeper than its depth
            "/app/a.b.js", "/app/.js", "/app/a%20b.js", "/app/a.JS", // names that are not plain, or another extension
            "/app/a.mjs", "/app/sub.dir/a.js", "/boot.css", "/app",
        ]) {
            const answer = await ask(modules, url);
            assert.deepEqual([answer.handled, answer.status], [false, null], `${url} (dev: ${dev})`);
        }
    }
});

test("handle: a mount serves only the extensions in its only, .js unless told", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await createModuleServer({ root, build: "b1", mounts: [{ url: "/app/", dir: "app" }] });
    assert.equal((await ask(modules, "/app/a.js")).status, 200);
    assert.equal((await ask(modules, "/app/style.css")).handled, false);
    assert.equal((await ask(modules, "/app/lib/c.js")).handled, false, "depth 0 unless told");
});

test("handle: the framework's browser half is always served, flat, at /src/, and never a subdirectory of it", async (t) => {
    const root = await appDir(t, FILES);
    for (const dev of [true, false]) {
        const modules = await createModuleServer({ root, dev, build: "b1", minify: false });
        const answer = await ask(modules, "/src/juris.js");
        assert.equal(answer.status, 200);
        assert.equal(answer.headers["content-type"], "text/javascript; charset=utf-8");
        assert.ok(answer.text.includes(`from "./state-manager.js?v=${modules.codeId}"`), "its own imports are stamped");
        assert.equal((await ask(modules, "/src/tests/core.test.mjs")).handled, false);
        assert.equal((await ask(modules, "/src/tests/x.js")).handled, false);
        assert.equal((await ask(modules, "/src/package.json")).handled, false);
    }
});

test("handle: a module is typed text/javascript and a stylesheet text/css", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root);
    assert.equal((await ask(modules, "/app/a.js")).headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal((await ask(modules, "/app/style.css")).headers["content-type"], "text/css; charset=utf-8");
    assert.equal((await ask(modules, "/site.css")).headers["content-type"], "text/css; charset=utf-8");
});

// ---- development ------------------------------------------------------------------------------

test("development: every request reads the disk and is no-store, and the source goes out unminified", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root, { dev: true });
    const first = await ask(modules, "/app/a.js");
    assert.equal(first.text, A, "the source as it is on disk");
    assert.equal(first.headers["cache-control"], CACHE["no-store"]);
    assert.equal((await ask(modules, "/app/style.css")).text, FILES["app/style.css"], "a stylesheet too");

    await put(root, { "app/a.js": "export const a = 'edited';\n", "app/new.js": "export const n = 1;\n" });
    assert.equal((await ask(modules, "/app/a.js")).text, "export const a = 'edited';\n", "what is on disk now");
    assert.equal((await ask(modules, "/app/new.js")).status, 200, "a file made since is served");
    const own = await ask(modules, `/app/a.js?v=${modules.codeId}`);
    assert.equal(own.headers["cache-control"], CACHE["no-store"], "no-store even under its own code id");
    modules.clear();
    assert.equal((await ask(modules, "/app/a.js")).text, "export const a = 'edited';\n", "clear() has nothing to forget");
});

test("development: a name the mounts accept with no file behind it is a 404 that says nothing else", async (t) => {
    const root = await appDir(t, FILES);
    await mkdir(path.join(root, "app", "folder.js"));
    const modules = await server(root, { dev: true });
    for (const url of ["/app/missing.js", "/app/folder.js", "/app/lib/missing.js"]) {
        const answer = await ask(modules, url);
        assert.equal(answer.handled, true, url);
        assert.equal(answer.status, 404, url);
        assert.deepEqual(answer.headers, { "content-type": "text/plain", "cache-control": "no-store" }, url);
        assert.equal(answer.text, "not found", url);
    }
});

test("development: a name that runs through a file, not a directory, is a 404 too", async (t) => {
    const root = await appDir(t, { ...FILES, "app/notes": "a plain file, not a directory\n" });
    const modules = await server(root, { dev: true });
    const answer = await ask(modules, "/app/notes/x.js");
    assert.deepEqual([answer.status, answer.text], [404, "not found"]);
});

test("development: a file that cannot be read for another reason is an error, not a 404", { skip: process.getuid?.() === 0 && "root reads any file" }, async (t) => {
    const root = await appDir(t, FILES);
    const file = path.join(root, "app", "b.js");
    const modules = await server(root, { dev: true });
    await chmod(file, 0o000);
    try {
        await assert.rejects(ask(modules, "/app/b.js"), { code: "EACCES" });
    } finally {
        await chmod(file, 0o644);
    }
});

// ---- production -------------------------------------------------------------------------------

test("production: JS is minified and CSS is minified; a module's text is otherwise the file's own", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root);
    assert.equal((await ask(modules, "/app/a.js")).text, minifyJs(A));
    assert.equal((await ask(modules, "/boot.js")).text, minifyJs(FILES["boot.js"]));
    assert.equal((await ask(modules, "/app/style.css")).text, minifyCss(FILES["app/style.css"]));
    assert.equal((await ask(modules, "/site.css")).text, minifyCss(FILES["site.css"]));
});

test("production: minify false serves the source, and minify { js, css } replaces either minifier", async (t) => {
    const root = await appDir(t, FILES);
    const plain = await server(root, { minify: false });
    assert.equal((await ask(plain, "/app/a.js")).text, A);
    assert.equal((await ask(plain, "/app/style.css")).text, FILES["app/style.css"]);

    const jsOnly = await server(root, { minify: { js: (text) => `/*js*/${text}` } });
    assert.equal((await ask(jsOnly, "/app/a.js")).text, `/*js*/${A}`);
    assert.equal((await ask(jsOnly, "/app/style.css")).text, minifyCss(FILES["app/style.css"]), "the framework's CSS minifier unless told");

    const cssOnly = await server(root, { minify: { css: (text) => text.toUpperCase() } });
    assert.equal((await ask(cssOnly, "/app/a.js")).text, minifyJs(A));
    assert.equal((await ask(cssOnly, "/app/style.css")).text, FILES["app/style.css"].toUpperCase());
});

test("production: each file is minified once and kept, until clear()", async (t) => {
    const root = await appDir(t, FILES);
    const calls = [];
    const modules = await server(root, { minify: { js: (text) => { calls.push(text); return text; } } });
    const first = await ask(modules, "/app/a.js");
    const second = await ask(modules, "/app/a.js");
    assert.equal(calls.length, 1, "built once");
    assert.equal(second.headers.etag, first.headers.etag);
    modules.clear();
    await ask(modules, "/app/a.js");
    assert.equal(calls.length, 2, "clear() forgot what was built");
});

test("production: the files are read once, at construction: a change, a removal or a new file on disk changes nothing", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root, { minify: false });
    const before = await ask(modules, "/app/a.js");
    const versioned = await modules.versioned("/app/a.js");

    await put(root, { "app/a.js": "export const a = 'next build';\n", "app/new.js": "export const n = 1;\n" });
    await rm(path.join(root, "app", "b.js"));
    for (const clear of [false, true]) {
        if (clear) modules.clear();
        assert.equal((await ask(modules, "/app/a.js")).text, before.text, "what it started with");
        assert.equal(await modules.versioned("/app/a.js"), versioned);
        assert.equal((await ask(modules, "/app/b.js")).text, FILES["app/b.js"], "a file the deploy removed is still served");
        const gained = await ask(modules, "/app/new.js");
        assert.deepEqual([gained.status, gained.headers["cache-control"], gained.text], [404, "no-store", "not found"], "a file the checkout gained since is not this build's");
    }
    await assert.rejects(modules.versioned("/app/new.js"), { message: /^\/app\/new\.js is not in the snapshot this server started with/ });
});

test("production: a name the mounts accept with no file behind it is a 404 that says nothing else", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root);
    const answer = await ask(modules, "/app/missing.js");
    assert.deepEqual([answer.handled, answer.status, answer.text], [true, 404, "not found"]);
    assert.deepEqual(answer.headers, { "content-type": "text/plain", "cache-control": "no-store" });
});

test("production: a directory named like a module is no module, and does not stop the server starting", async (t) => {
    const root = await appDir(t, FILES);
    await mkdir(path.join(root, "app", "folder.js"));
    const modules = await server(root);
    assert.equal((await ask(modules, "/app/folder.js")).status, 404);
});

test("production: a mount that names a directory with no files serves nothing, and is no error", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await createModuleServer({ root, build: "b1", mounts: [{ url: "/later/", dir: "not-yet" }] });
    assert.equal((await ask(modules, "/later/a.js")).status, 404);
});

// ---- caching ----------------------------------------------------------------------------------

test("caching: a module is immutable only when ?v names this process's own code id, and public under any other", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root);
    const other = await server(root, { build: "b2" });
    const id = modules.codeId;
    const cases = [
        [`/app/a.js?v=${id}`, "immutable"],
        [await modules.versioned("/app/a.js"), "immutable"],
        [`/app/a.js?v=anything-${id}`, "immutable"],
        ["/app/a.js", "public"],
        [`/app/a.js?v=${other.codeId}`, "public"],
        [await other.versioned("/app/a.js"), "public"],
        [`/app/a.js?v=${id}x`, "public"],
        [`/app/a.js?v=${id}-x`, "public"],
        [`/app/a.js?v=`, "public"],
    ];
    for (const [url, cache] of cases) assert.equal((await ask(modules, url)).headers["cache-control"], CACHE[cache], url);
});

test("caching: a module's answer varies by encoding, is gzipped for a browser that asks, and a 304 repeats what it stands for", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root);
    const url = await modules.versioned("/app/a.js");
    const plain = await ask(modules, url);
    assert.equal(plain.headers.vary, "Accept-Encoding");
    assert.equal(plain.headers["content-encoding"], undefined);
    const gzipped = await ask(modules, url, { "accept-encoding": "gzip, br" });
    assert.equal(gzipped.headers["content-encoding"], "gzip");
    assert.equal(gzipped.text, plain.text);
    const again = await ask(modules, url, { "if-none-match": plain.headers.etag });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
    assert.deepEqual([again.headers.etag, again.headers["cache-control"], again.headers.vary], [plain.headers.etag, CACHE.immutable, "Accept-Encoding"]);
});

test("caching: over a real connection, a module arrives gzipped and revalidates to a 304", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root);
    const httpServer = http.createServer((req, res) => {
        modules.handle(req, res, new URL(req.url, "http://localhost")).then((handled) => {
            if (!handled) { res.writeHead(418); res.end(); }
        });
    });
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => { httpServer.closeAllConnections(); httpServer.close(resolve); }));
    const get = (pathname, headers) => new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: httpServer.address().port, path: pathname, headers, agent: false }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on("error", reject);
    });
    const url = await modules.versioned("/app/a.js");
    const first = await get(url, { "accept-encoding": "gzip" });
    assert.equal(first.status, 200);
    assert.equal(first.headers["content-encoding"], "gzip");
    assert.equal(gunzipSync(first.body).toString(), minifyJs(A));
    const second = await get(url, { "if-none-match": first.headers.etag });
    assert.equal(second.status, 304);
    assert.equal((await get("/elsewhere")).status, 418, "a URL the module server does not serve is left to the app");
});

// ---- the code id and versioned() --------------------------------------------------------------

test("the code id: the same files, build and transform are the same code id, and a rollback is the same URLs", async (t) => {
    const root = await appDir(t, FILES);
    const one = await server(root);
    const two = await server(root);
    assert.equal(one.codeId, two.codeId);
    assert.match(one.codeId, /^[\w-]{10}$/);
    assert.equal(await one.versioned("/app/a.js"), await two.versioned("/app/a.js"));
});

test("the code id moves with the build and with any file the snapshot holds", async (t) => {
    const root = await appDir(t, FILES);
    const before = await server(root);
    assert.notEqual((await server(root, { build: "b2" })).codeId, before.codeId);
    await put(root, { "app/lib/c.js": "export const c = 'changed';\n" });
    assert.notEqual((await server(root)).codeId, before.codeId, "a file deeper in a mount");
    await put(root, { "app/lib/c.js": FILES["app/lib/c.js"] });
    assert.equal((await server(root)).codeId, before.codeId, "the same files again");
    await put(root, { "site.css": "body{margin:1px}" });
    assert.notEqual((await server(root)).codeId, before.codeId, "an asset");
});

test("the code id names the transform: no minifier, the framework's, or the app's by its source text", async (t) => {
    const root = await appDir(t, FILES);
    const ids = {
        juris: (await server(root)).codeId,
        jurisAsked: (await server(root, { minify: { js: minifyJs, css: minifyCss } })).codeId,
        empty: (await server(root, { minify: {} })).codeId,
        none: (await server(root, { minify: false })).codeId,
        custom: (await server(root, { minify: { js: (text) => text.trim() } })).codeId,
        sameText: (await server(root, { minify: { js: (text) => text.trim() } })).codeId,
        otherText: (await server(root, { minify: { js: (text) => text.trimEnd() } })).codeId,
        customCss: (await server(root, { minify: { css: (text) => text.trim() } })).codeId,
    };
    assert.equal(ids.jurisAsked, ids.juris, "the framework's minifiers, named, are the framework's");
    assert.equal(ids.empty, ids.juris);
    assert.equal(ids.sameText, ids.custom, "a custom minifier is known by its source text");
    const distinct = new Set([ids.juris, ids.none, ids.custom, ids.otherText, ids.customCss]);
    assert.equal(distinct.size, 5, JSON.stringify(ids));
});

test("the code id: root files and static files are not modules, and have no part in it", async (t) => {
    const root = await appDir(t, { ...FILES, "web/sw.js": "self.v = 1;\n", "pub/logo.png": "png" });
    const plain = await server(root);
    const more = await server(root, { rootFiles: { "/sw.js": "web/sw.js" }, static: [{ url: "/pub/", dir: "pub", only: [".png"] }] });
    assert.equal(more.codeId, plain.codeId);
    await put(root, { "web/sw.js": "self.v = 2;\n" });
    assert.equal((await server(root, { rootFiles: { "/sw.js": "web/sw.js" } })).codeId, plain.codeId);
});

test("versioned(path) is the path with ?v=<content hash>-<code id>, the hash naming the file's own bytes", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root);
    const a = await modules.versioned("/app/a.js");
    // Both halves are base64url, which has "-" in it, so the value is split at the code id, never at
    // the first or last "-": a code id that begins with one (1 run in 64) split the greedy way.
    const suffix = `-${modules.codeId}`;
    const hashIn = (url) => (url.endsWith(suffix) ? /\?v=([\w-]+)$/.exec(url.slice(0, -suffix.length))?.[1] : undefined);
    const match = [a, hashIn(a)];
    assert.ok(a.startsWith("/app/a.js?v=") && match[1], a);
    const hashOf = async (url) => hashIn(await modules.versioned(url));
    assert.equal(await hashOf("/app/twin.js"), match[1], "the same bytes, the same hash");
    assert.notEqual(await hashOf("/app/b.js"), match[1]);
    assert.match(await modules.versioned("/boot.js"), new RegExp(`^/boot\\.js\\?v=[\\w-]+-${modules.codeId}$`), "an asset too");
    assert.match(await modules.versioned("/src/juris.js"), new RegExp(`^/src/juris\\.js\\?v=[\\w-]+-${modules.codeId}$`), "the framework's too");
});

test("versioned: a path no mount or asset serves is refused", async (t) => {
    const root = await appDir(t, FILES);
    for (const dev of [true, false]) {
        const modules = await server(root, { dev });
        for (const url of ["/elsewhere.js", "/app/lib/deep/d.js", "/app/a.b.js"]) {
            await assert.rejects(modules.versioned(url), { name: "TypeError", message: `not a file this module server serves: ${url}` });
        }
    }
});

test("versioned: in development the hash follows the disk; in production it is the snapshot's", async (t) => {
    const root = await appDir(t, FILES);
    const dev = await server(root, { dev: true });
    const prod = await server(root);
    const [devBefore, prodBefore] = [await dev.versioned("/app/b.js"), await prod.versioned("/app/b.js")];
    await put(root, { "app/b.js": "export const b = 'edited';\n" });
    assert.notEqual(await dev.versioned("/app/b.js"), devBefore);
    assert.equal(await prod.versioned("/app/b.js"), prodBefore);
});

// ---- an asset that is also under a mount ------------------------------------------------------

test("an asset at a URL a mount also serves is refused, or served the same in production as in development", async (t) => {
    const root = await appDir(t, { "app/a.js": "export const from = 'asset';\n", "lib/a.js": "export const from = 'mount';\n" });
    const options = { root, build: "b1", mounts: [{ url: "/app/", dir: "lib" }], assets: ["/app/a.js"], minify: false };
    const built = await Promise.all([createModuleServer({ ...options, dev: true }), createModuleServer(options)]).catch((error) => error);
    if (built instanceof TypeError) return;           // refused at construction: one answer per URL
    const [dev, prod] = built;
    assert.equal((await ask(prod, "/app/a.js")).text, (await ask(dev, "/app/a.js")).text);
    assert.equal((await listModules(options)).filter((entry) => entry.url === "/app/a.js").length, 1, "one URL, one file");
});

// ---- a mount under another mount --------------------------------------------------------------

test("a mount under another that also reaches its URLs is refused, in either order; one it cannot reach is served the same in production as in development", async (t) => {
    const root = await appDir(t, { "app/lib/c.js": "export const from = 'app';\n", "lib/c.js": "export const from = 'lib';\n" });
    const outer = { url: "/app/", dir: "app", depth: 1 };
    const inner = { url: "/app/lib/", dir: "lib" };
    const message = 'createModuleServer: mount "/app/lib/": served twice (the mount /app/ reaches its URLs too)';
    for (const mounts of [[outer, inner], [inner, outer]]) {
        for (const dev of [true, false]) {
            await assert.rejects(createModuleServer({ root, dev, build: "b1", mounts }), { name: "TypeError", message });
        }
        await assert.rejects(listModules({ root, mounts }), { name: "TypeError", message });
    }
    // Too shallow to reach it, or serving none of its extensions: no URL is both mounts'.
    for (const mounts of [[{ ...outer, depth: 0 }, inner], [{ ...outer, only: [".css"] }, inner]]) {
        const options = { root, build: "b1", mounts, minify: false };
        const [dev, prod] = [await createModuleServer({ ...options, dev: true }), await createModuleServer(options)];
        assert.equal((await ask(dev, "/app/lib/c.js")).text, "export const from = 'lib';\n");
        assert.equal((await ask(prod, "/app/lib/c.js")).text, "export const from = 'lib';\n");
        assert.deepEqual((await listModules(options)).filter((entry) => !entry.url.startsWith("/src/")), [{ url: "/app/lib/c.js", file: path.join(root, "lib", "c.js") }]);
    }
});

// ---- listModules ------------------------------------------------------------------------------

test("listModules: every file the mounts and assets name, the framework's flat files first among them, sorted by URL", async (t) => {
    const root = await appDir(t, { ...FILES, "app/.hidden.js": "", "app/sub.dir/e.js": "", "app/notes.txt": "" });
    const listed = await listModules({ root, mounts: MOUNTS, assets: ["/boot.js", "/site.css"] });
    const urls = listed.map((entry) => entry.url);
    assert.deepEqual(urls, [...urls].sort(), "sorted by URL");
    const framework = (await readdir(JURIS_DIR)).filter((name) => /^[\w-]+\.js$/.test(name)).map((name) => `/src/${name}`).sort();
    assert.ok(framework.length > 10);
    assert.deepEqual(urls.filter((url) => url.startsWith("/src/")), framework);
    assert.deepEqual(urls.filter((url) => !url.startsWith("/src/")), [
        "/app/a.js", "/app/b.js", "/app/lib/c.js", "/app/style.css", "/app/twin.js", "/boot.js", "/site.css",
    ]);
    assert.deepEqual(listed.find((entry) => entry.url === "/app/lib/c.js"), { url: "/app/lib/c.js", file: path.join(root, "app", "lib", "c.js") });
    assert.deepEqual(listed.find((entry) => entry.url === "/src/juris.js"), { url: "/src/juris.js", file: path.join(JURIS_DIR, "juris.js") });
});

test("listModules: a mount with no directory behind it lists nothing, and only the framework is listed unless told", async (t) => {
    const root = await appDir(t, FILES);
    const bare = await listModules({ root });
    assert.ok(bare.length > 10);
    assert.ok(bare.every((entry) => entry.url.startsWith("/src/")));
    assert.deepEqual(await listModules({ root, mounts: [{ url: "/later/", dir: "not-yet" }] }), bare);
});

test("listModules: the construction's refusals hold, its root included", async (t) => {
    const root = await appDir(t, FILES);
    await assert.rejects(listModules(), { name: "TypeError", message: /`root` is the directory/ });
    await assert.rejects(listModules({ root, mounts: [{ url: "/src/x/", dir: "app" }] }), { name: "TypeError", message: /\/src\/ is the framework's/ });
    await assert.rejects(listModules({ root, assets: ["/boot.mjs"] }), { name: "TypeError", message: /an asset is served as a module is/ });
});

