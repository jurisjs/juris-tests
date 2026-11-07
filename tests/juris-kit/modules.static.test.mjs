// What the module server serves that is not a module (server/modules.js): root files (sent as on
// disk, no-cache, typed by extension or `type`, with the app's headers, snapshotted in production)
// and static files (a directory's files or one file, cached as each entry says, gzipped when text,
// ETagged by their bytes, read on first use in production and every time in development).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm, mkdir, chmod } from "node:fs/promises";
import { createModuleServer } from "juris-kit/server/modules.js";
import { appDir, put, ask } from "../support/modules-app.mjs";

const SW = '// the service worker, comments and all\nimport "./a.js";\nself.addEventListener("fetch", () => {});\n';
const CHART = "// a vendored library, byte for byte\nimport { x } from './x.js';\nexport const chart = x;\n";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const FILES = {
    "app/a.js": "export const a = 1;\n",
    "web/sw.js": SW,
    "web/manifest.webmanifest": '{ "name": "App" }\n',
    "web/data.json": "{}\n",
    "web/aasa": '{ "applinks": {} }\n',
    "robots.txt": "User-agent: *\n",
    ".well-known/security.txt": "Contact: mailto:security@example.com\n",
    "assets/logo.png": PNG,
    "assets/notes.txt": "notes ".repeat(200),
    "assets/icons/i.svg": `<svg xmlns="http://www.w3.org/2000/svg">${"<g/>".repeat(100)}</svg>`,
    "assets/chart-4.1.0/chart.js": CHART,
    "assets/fonts/deep/f.woff2": "woff2",
    "assets/.hidden.png": PNG,
    "assets/readme.md": "# no\n",
    "pub/favicon.ico": "ico",
    "pub/long.css": "a { color: red; }\n",
    "pub/short.css": "b { color: blue; }\n",
    "data/blob.bin": "bytes",
};
const ROOT_FILES = {
    "/sw.js": { file: "web/sw.js", headers: { "service-worker-allowed": "/" } },
    "/manifest.webmanifest": "web/manifest.webmanifest",
    "/data.json": "web/data.json",
    "/robots.txt": "robots.txt",
    "/.well-known/security.txt": ".well-known/security.txt",
    "/.well-known/apple-app-site-association": { file: "web/aasa", type: "application/json" },
};
const STATIC = [
    { url: "/assets/", dir: "assets", depth: 1, only: [".png", ".svg", ".txt", ".js", ".woff2"] },
    { url: "/favicon.ico", file: "pub/favicon.ico", maxAge: 86400 },
    { url: "/long.css", file: "pub/long.css", immutable: true },
    { url: "/short.css", file: "pub/short.css", maxAge: 60 },
    { url: "/data/", dir: "data", only: [".bin"], type: "application/octet-stream" },
];
const server = (root, options = {}) => createModuleServer({
    root, build: "b1", mounts: [{ url: "/app/", dir: "app" }], rootFiles: ROOT_FILES, static: STATIC, ...options,
});
const NOT_FOUND = { status: 404, headers: { "content-type": "text/plain", "cache-control": "no-store" }, text: "not found" };
const notFound = ({ status, headers, text }) => ({ status, headers, text });

// ---- root files -------------------------------------------------------------------------------

test("root files: each goes out as it is on disk, never stamped or minified, no-cache, with the app's headers", async (t) => {
    const root = await appDir(t, FILES);
    for (const dev of [true, false]) {
        const modules = await server(root, { dev });
        const sw = await ask(modules, "/sw.js");
        assert.equal(sw.handled, true);
        assert.equal(sw.status, 200);
        assert.equal(sw.text, SW, `dev: ${dev}: the bytes on disk`);
        assert.deepEqual(sw.headers, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": "/" });
    }
});

test("root files: typed by extension unless type says, and a dot-led folder is a name like any other", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root);
    for (const [url, type, file] of [
        ["/manifest.webmanifest", "application/manifest+json", "web/manifest.webmanifest"],
        ["/data.json", "application/json; charset=utf-8", "web/data.json"],
        ["/robots.txt", "text/plain; charset=utf-8", "robots.txt"],
        ["/.well-known/security.txt", "text/plain; charset=utf-8", ".well-known/security.txt"],
        ["/.well-known/apple-app-site-association", "application/json", "web/aasa"],
    ]) {
        const answer = await ask(modules, url);
        assert.deepEqual(answer.headers, { "content-type": type, "cache-control": "no-cache" }, url);
        assert.equal(answer.text, FILES[file], url);
    }
});

test("root files: no ?v makes one immutable; it is asked again on every use", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root);
    assert.equal((await ask(modules, `/sw.js?v=${modules.codeId}`)).headers["cache-control"], "no-cache");
});

test("root files: production serves what it started with, a change or a removal on disk notwithstanding", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root);
    await put(root, { "web/sw.js": "self.next = 1;\n" });
    await rm(path.join(root, "robots.txt"));
    for (const clear of [false, true]) {
        if (clear) modules.clear();
        assert.equal((await ask(modules, "/sw.js")).text, SW);
        assert.equal((await ask(modules, "/robots.txt")).text, FILES["robots.txt"]);
    }
});

test("root files: development reads the disk on every request, and one missing or a directory is a 404", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root, { dev: true, rootFiles: { ...ROOT_FILES, "/folder.txt": "web" } });
    await put(root, { "web/sw.js": "self.next = 1;\n" });
    assert.equal((await ask(modules, "/sw.js")).text, "self.next = 1;\n");
    await rm(path.join(root, "robots.txt"));
    assert.deepEqual(notFound(await ask(modules, "/robots.txt")), NOT_FOUND);
    assert.deepEqual(notFound(await ask(modules, "/folder.txt")), NOT_FOUND);
});

test("root files: in development one whose path runs through a file, not a directory, is a 404 too", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root, { dev: true, rootFiles: { "/x.txt": "robots.txt/x.txt" } });
    assert.deepEqual(notFound(await ask(modules, "/x.txt")), NOT_FOUND);
});

// ---- static files: what is served -------------------------------------------------------------

test("static: a directory's files with the extensions in only, down depth levels, typed by extension", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root);
    for (const [url, type, file] of [
        ["/assets/logo.png", "image/png", "assets/logo.png"],
        ["/assets/notes.txt", "text/plain; charset=utf-8", "assets/notes.txt"],
        ["/assets/icons/i.svg", "image/svg+xml", "assets/icons/i.svg"],
        ["/assets/chart-4.1.0/chart.js", "text/javascript; charset=utf-8", "assets/chart-4.1.0/chart.js"],
        ["/data/blob.bin", "application/octet-stream", "data/blob.bin"],
    ]) {
        const answer = await ask(modules, url);
        assert.deepEqual([answer.handled, answer.status, answer.headers["content-type"]], [true, 200, type], url);
        assert.deepEqual(answer.body, Buffer.from(FILES[file]), url);
    }
    for (const url of ["/assets/fonts/deep/f.woff2", "/assets/.hidden.png", "/assets/readme.md", "/assets/logo.PNG", "/assets/", "/assets/a b.png", "/assets/x%2Flogo.png", "/data/blob.txt"]) {
        assert.equal((await ask(modules, url)).handled, false, url);
    }
});

test("static: a file entry serves one file at one URL", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root);
    const answer = await ask(modules, "/favicon.ico");
    assert.deepEqual([answer.status, answer.headers["content-type"], answer.text], [200, "image/x-icon", "ico"]);
    assert.equal((await ask(modules, "/favicon.ico/x")).handled, false);
    assert.equal((await ask(modules, "/pub/favicon.ico")).handled, false, "only at its URL");
});

test("static: a file goes out as it is on disk, in production too: never stamped or minified", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root);
    assert.equal((await ask(modules, "/assets/chart-4.1.0/chart.js")).text, CHART);
    assert.equal((await ask(modules, "/long.css")).text, FILES["pub/long.css"]);
});

test("static: a declared name with no file behind it is a 404, a directory or a path through a file included", async (t) => {
    const root = await appDir(t, FILES);
    await mkdir(path.join(root, "assets", "folder.png"));
    for (const dev of [true, false]) {
        const modules = await server(root, { dev });
        for (const url of ["/assets/missing.png", "/assets/folder.png", "/assets/logo.png/x.png"]) {
            const answer = await ask(modules, url);
            assert.equal(answer.handled, true, url);
            assert.deepEqual(notFound(answer), NOT_FOUND, `${url} (dev: ${dev})`);
        }
    }
    const missing = await server(root, { static: [{ url: "/gone.png", file: "pub/gone.png" }] });
    assert.deepEqual(notFound(await ask(missing, "/gone.png")), NOT_FOUND);
});

// ---- static files: caching --------------------------------------------------------------------

test("static: kept immutable, for maxAge seconds, or revalidated on every use; no-store in development", async (t) => {
    const root = await appDir(t, FILES);
    const prod = await server(root);
    const dev = await server(root, { dev: true });
    for (const [url, cache] of [
        ["/long.css", "public, max-age=31536000, immutable"],
        ["/favicon.ico", "public, max-age=86400"],
        ["/short.css", "public, max-age=60"],
        ["/assets/logo.png", "public, max-age=0, must-revalidate"],
    ]) {
        assert.equal((await ask(prod, url)).headers["cache-control"], cache, url);
        assert.equal((await ask(dev, url)).headers["cache-control"], "no-store", url);
    }
});

test("static: text is gzipped for a browser that asks and varies by encoding; a picture goes one way", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root);
    for (const url of ["/assets/notes.txt", "/assets/icons/i.svg", "/assets/chart-4.1.0/chart.js"]) {
        const asked = await ask(modules, url, { "accept-encoding": "gzip, deflate" });
        assert.equal(asked.headers["content-encoding"], "gzip", url);
        assert.equal(asked.headers.vary, "Accept-Encoding", url);
        const plain = await ask(modules, url, { "accept-encoding": "br" });
        assert.equal(plain.headers["content-encoding"], undefined, url);
        assert.equal(plain.headers.vary, "Accept-Encoding", url);
        assert.equal(plain.text, asked.text, url);
    }
    const png = await ask(modules, "/assets/logo.png", { "accept-encoding": "gzip" });
    assert.equal(png.headers["content-encoding"], undefined);
    assert.equal(png.headers.vary, undefined, "one encoding, so nothing to vary by");
    assert.deepEqual(png.body, PNG);
});

test("static: the ETag names the bytes, and a 304 repeats the ETag and Cache-Control", async (t) => {
    const root = await appDir(t, FILES);
    const one = await server(root);
    const two = await server(root);
    const png = await ask(one, "/assets/logo.png");
    assert.equal((await ask(two, "/assets/logo.png")).headers.etag, png.headers.etag, "the same bytes, the same tag, on any instance");
    assert.notEqual((await ask(one, "/assets/notes.txt")).headers.etag, png.headers.etag);

    const again = await ask(one, "/assets/logo.png", { "if-none-match": png.headers.etag });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
    assert.deepEqual(again.headers, { etag: png.headers.etag, "cache-control": "public, max-age=0, must-revalidate" });

    const text = await ask(one, "/long.css");
    const textAgain = await ask(one, "/long.css", { "if-none-match": text.headers.etag });
    assert.deepEqual([textAgain.status, textAgain.headers], [304, { etag: text.headers.etag, "cache-control": "public, max-age=31536000, immutable", vary: "Accept-Encoding" }]);
    assert.equal((await ask(one, "/long.css", { "if-none-match": png.headers.etag })).status, 200, "another tag is another body");
});

// RFC 9110, 13.1.2 and 13.2.1: only a GET or a HEAD is answered 304, and If-None-Match is a list
// of tags compared weakly.
test("static: only a GET or a HEAD is a 304, and If-None-Match is read as a list compared weakly", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root);
    const png = await ask(modules, "/assets/logo.png");
    const held = { "if-none-match": png.headers.etag };
    assert.equal((await ask(modules, "/assets/logo.png", held, { method: "HEAD" })).status, 304);
    for (const method of ["POST", "DELETE"]) {
        const answer = await ask(modules, "/assets/logo.png", held, { method });
        assert.equal(answer.status, 200, method);
        assert.deepEqual(answer.body, PNG, method);
    }
    const listed = { "if-none-match": `"other", ${png.headers.etag.slice(2)}` };
    assert.equal((await ask(modules, "/assets/logo.png", listed)).status, 304);
    const module = await ask(modules, "/app/a.js");
    const posted = await ask(modules, "/app/a.js", { "if-none-match": module.headers.etag }, { method: "POST" });
    assert.equal(posted.status, 200, "a module, sent by send, the same");
});

test("static: production reads a file the first time it is asked for and keeps it until clear(); development reads it every time", async (t) => {
    const root = await appDir(t, FILES);
    const prod = await server(root);
    const dev = await server(root, { dev: true });
    await put(root, { "assets/notes.txt": "second" });
    assert.equal((await ask(prod, "/assets/notes.txt")).text, "second", "not in the snapshot: read when first asked for");
    await put(root, { "assets/notes.txt": "third" });
    assert.equal((await ask(prod, "/assets/notes.txt")).text, "second", "then kept");
    assert.equal((await ask(dev, "/assets/notes.txt")).text, "third");
    prod.clear();
    assert.equal((await ask(prod, "/assets/notes.txt")).text, "third", "clear() forgot it");
    await rm(path.join(root, "assets", "notes.txt"));
    assert.equal((await ask(prod, "/assets/notes.txt")).text, "third", "kept, even once removed");
    assert.equal((await ask(dev, "/assets/notes.txt")).status, 404);
});

// ---- what cannot be read ----------------------------------------------------------------------

test("a root file or a static file that cannot be read for another reason is an error, not a 404", { skip: process.getuid?.() === 0 && "root reads any file" }, async (t) => {
    const root = await appDir(t, FILES);
    const dev = await server(root, { dev: true });
    const prod = await server(root);
    const files = [path.join(root, "web", "sw.js"), path.join(root, "assets", "logo.png")];
    for (const file of files) await chmod(file, 0o000);
    try {
        await assert.rejects(ask(dev, "/sw.js"), { code: "EACCES" });
        await assert.rejects(ask(dev, "/assets/logo.png"), { code: "EACCES" });
        await assert.rejects(ask(prod, "/assets/logo.png"), { code: "EACCES" });
        assert.equal((await ask(prod, "/sw.js")).text, SW, "production's copy was read at start");
    } finally {
        for (const file of files) await chmod(file, 0o644);
    }
});
