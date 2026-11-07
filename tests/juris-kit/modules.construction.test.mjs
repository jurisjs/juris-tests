// The module server's construction (server/modules.js): what createModuleServer refuses rather
// than half-honours, for its root and build, each mount, asset, root file and static entry, the
// framework's files (served only flat at /src/, and the kit's never), and one URL served twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createModuleServer } from "juris-kit/server/modules.js";
import { appDir, ask, JURIS_DIR, KIT_DIR, ABOVE_BOTH } from "../support/modules-app.mjs";

const FILES = {
    "app/a.js": "export const a = 1;\n",
    "boot.js": "export function start() {}\n",
    "site.css": "a{}\n",
    "pub/logo.png": "png",
    "web/sw.js": "self.x = 1;\n",
    "robots.txt": "User-agent: *\n",
};

// A refusal at construction: a TypeError with exactly `message` (a string) or matching it.
async function refused(options, message) {
    await assert.rejects(createModuleServer({ build: "b1", dev: true, ...options }), { name: "TypeError", message }, JSON.stringify(options, (k, v) => (v === undefined ? "<undefined>" : v)));
}

// ---- root and build ---------------------------------------------------------------------------

test("createModuleServer: root is a path or a file: URL, and anything else is refused", async (t) => {
    const message = "createModuleServer: `root` is the directory the mounts are relative to (a path or a file: URL)";
    for (const root of [undefined, "", 7, null]) await refused({ root }, message);
    await assert.rejects(createModuleServer(), { name: "TypeError", message }, "no options at all");

    const root = await appDir(t, FILES);
    const modules = await createModuleServer({ root: pathToFileURL(root + path.sep), build: "b1", mounts: [{ url: "/app/", dir: "app" }] });
    const answer = await ask(modules, "/app/a.js");
    assert.equal(answer.status, 200, "a file: URL root serves as its path does");
});

test("createModuleServer: build names the deploy, as a non-empty string", async (t) => {
    const root = await appDir(t, FILES);
    const message = "createModuleServer: `build` names this deploy (a non-empty string); it is part of the code id";
    for (const build of [undefined, "", 1, null]) {
        await assert.rejects(createModuleServer({ root, build }), { name: "TypeError", message }, String(build));
    }
});

// ---- mounts -----------------------------------------------------------------------------------

test("createModuleServer: a mount is { url, dir, depth, only }, each checked", async (t) => {
    const root = await appDir(t, FILES);
    await refused({ root, mounts: { url: "/app/", dir: "app" } }, "createModuleServer: `mounts` is a list of { url, dir, depth, only }");
    const where = (url) => `createModuleServer: mount ${JSON.stringify(url)}`;
    for (const url of ["app/", "/app", "/a b/", "/../", "//", "/app/../x/", 5]) {
        await refused({ root, mounts: [{ url, dir: "app" }] }, `${where(url)}: a url is a path of plain names that starts and ends with "/"`);
    }
    await refused({ root, mounts: [null] }, "createModuleServer: mount undefined: a url is a path of plain names that starts and ends with \"/\"");
    for (const url of ["/src/", "/src/app/"]) {
        await refused({ root, mounts: [{ url, dir: "app" }] }, `${where(url)}: /src/ is the framework's, mounted flat by the module server itself`);
    }
    await refused({ root, mounts: [{ url: "/app/", dir: "app" }, { url: "/app/", dir: "web" }] }, `${where("/app/")}: mounted twice`);
    for (const dir of [undefined, "", 5]) await refused({ root, mounts: [{ url: "/app/", dir }] }, `${where("/app/")}: no dir`);
    for (const depth of [-1, 1.5, "1", null]) {
        await refused({ root, mounts: [{ url: "/app/", dir: "app", depth }] }, `${where("/app/")}: depth is a whole number of subdirectory levels`);
    }
    for (const only of [[], [".mjs"], ["js"], [".js", ".ts"], ".js", [".JS"]]) {
        await refused({ root, mounts: [{ url: "/app/", dir: "app", only }] }, `${where("/app/")}: only is a list of the extensions a module is served with, ".css" or ".js"`);
    }
});

test("createModuleServer: a mount's dir is inside the root unless it says outside: true, which is true or left out", async (t) => {
    const root = await appDir(t, FILES);
    const beside = await appDir(t, { "p.js": "export const p = 1;\n" });
    const where = 'createModuleServer: mount "/plugins/"';
    await refused({ root, mounts: [{ url: "/plugins/", dir: beside }] }, `${where}: its dir is outside the root`);
    await refused({ root, mounts: [{ url: "/plugins/", dir: "../elsewhere" }] }, `${where}: its dir is outside the root`);
    for (const outside of [false, "yes", 1, null]) {
        await refused({ root, mounts: [{ url: "/plugins/", dir: beside, outside }] }, `${where}: outside is true or left out`);
    }
    const modules = await createModuleServer({ root, build: "b1", mounts: [{ url: "/plugins/", dir: beside, outside: true }] });
    assert.equal((await ask(modules, "/plugins/p.js")).status, 200, "outside: true serves a dir beside the root");
});

test("createModuleServer: a mount inside the framework or the kit, or above either and deep enough to reach it, is refused", async (t) => {
    const message = (url) => `createModuleServer: mount ${JSON.stringify(url)}: its dir reaches the framework, which is served only flat, at /src/`;
    // An app that vendors both under its root.
    for (const mount of [
        { url: "/fw/", dir: path.basename(JURIS_DIR) },
        { url: "/fw/", dir: path.join(path.basename(JURIS_DIR), "tests") },
        { url: "/kit/", dir: path.basename(KIT_DIR) },
        { url: "/kit/", dir: path.join(path.basename(KIT_DIR), "server") },
        { url: "/all/", dir: ".", depth: 1 },
    ]) {
        await refused({ root: ABOVE_BOTH, mounts: [mount] }, message(mount.url));
    }
    // From outside, by its absolute path.
    const root = await appDir(t, FILES);
    await refused({ root, mounts: [{ url: "/fw/", dir: JURIS_DIR, outside: true }] }, message("/fw/"));
    await refused({ root, mounts: [{ url: "/fw/", dir: path.dirname(ABOVE_BOTH), depth: 2, outside: true }] }, message("/fw/"));
    // Above both, but not deep enough to reach a file of either: allowed.
    await createModuleServer({ root: ABOVE_BOTH, dev: true, build: "b1", mounts: [{ url: "/all/", dir: "." }] });
    await createModuleServer({ root, dev: true, build: "b1", mounts: [{ url: "/up/", dir: path.dirname(ABOVE_BOTH), depth: 1, outside: true }] });
});

// ---- assets -----------------------------------------------------------------------------------

test("createModuleServer: an asset is a URL path of plain names naming a .js or .css file outside /src/", async (t) => {
    const root = await appDir(t, FILES);
    await refused({ root, assets: "/boot.js" }, "createModuleServer: `assets` is a list of URL paths");
    for (const url of ["boot.js", "/a/../b.js", "/a b.js", "/a.b.js", "/dir/", "/boot", 5]) {
        await refused({ root, assets: [url] }, `createModuleServer: asset ${JSON.stringify(url)} is not a path of plain names`);
    }
    await refused({ root, assets: ["/src/juris.js"] }, "createModuleServer: asset /src/juris.js: /src/ is the framework's");
    for (const url of ["/boot.mjs", "/data.json", "/index.html"]) {
        await refused({ root, assets: [url] }, `createModuleServer: asset ${url}: an asset is served as a module is, with ".css" or ".js"`);
    }
});

test("createModuleServer: an asset whose file is the framework's or the kit's is refused, by its file", async () => {
    for (const url of [`/${path.basename(JURIS_DIR)}/juris.js`, `/${path.basename(KIT_DIR)}/server/http.js`]) {
        await refused({ root: ABOVE_BOTH, assets: [url] }, `createModuleServer: asset ${url}: its file is the framework's, which is served only flat, at /src/`);
    }
});

// ---- root files -------------------------------------------------------------------------------

test("createModuleServer: rootFiles maps URLs of plain names, a dot-led folder included, to files", async (t) => {
    const root = await appDir(t, { ...FILES, ".well-known/security.txt": "Contact: x\n" });
    for (const rootFiles of [null, ["/sw.js"], "web/sw.js"]) {
        await refused({ root, rootFiles }, "createModuleServer: `rootFiles` maps a URL to a file, or to { file, type, headers }");
    }
    for (const url of ["sw.js", "/", "/a//b.js", "/../x.js", "/a b.txt", "/x/", "/.."]) {
        await refused({ root, rootFiles: { [url]: "web/sw.js" } }, `createModuleServer: root file ${JSON.stringify(url)}: a URL is a path of plain names that starts with "/"`);
    }
    await refused({ root, rootFiles: { "/src/sw.js": "web/sw.js" } }, 'createModuleServer: root file "/src/sw.js": /src/ is the framework\'s');
    const modules = await createModuleServer({ root, build: "b1", rootFiles: { "/.well-known/security.txt": ".well-known/security.txt" } });
    assert.equal((await ask(modules, "/.well-known/security.txt")).status, 200);
});

test("createModuleServer: a root file at a URL a mount or an asset serves is refused rather than shadowed", async (t) => {
    const root = await appDir(t, FILES);
    const options = { root, mounts: [{ url: "/app/", dir: "app" }], assets: ["/boot.js"] };
    await refused({ ...options, rootFiles: { "/app/a.js": "web/sw.js" } }, 'createModuleServer: root file "/app/a.js": a mount or an asset also serves that URL');
    await refused({ ...options, rootFiles: { "/boot.js": "web/sw.js" } }, 'createModuleServer: root file "/boot.js": a mount or an asset also serves that URL');
    // A URL under a mount's prefix that the mount does not serve (another extension) is free.
    await createModuleServer({ ...options, build: "b1", dev: true, rootFiles: { "/app/manifest.json": "robots.txt" } });
});

test("createModuleServer: a root file names a file inside the root that is not the framework's", async (t) => {
    const root = await appDir(t, FILES);
    const where = 'createModuleServer: root file "/sw.js"';
    for (const entry of [null, {}, "", { file: "" }, { file: 5 }, { type: "text/javascript" }]) {
        await refused({ root, rootFiles: { "/sw.js": entry } }, `${where}: no file`);
    }
    await refused({ root, rootFiles: { "/sw.js": "../sw.js" } }, `${where}: its file is outside the root`);
    await refused({ root: ABOVE_BOTH, rootFiles: { "/sw.js": path.join(path.basename(JURIS_DIR), "juris.js") } }, `${where}: its file is the framework's, which is served only flat, at /src/`);
    await refused({ root: ABOVE_BOTH, rootFiles: { "/sw.js": path.join(path.basename(KIT_DIR), "server", "http.js") } }, `${where}: its file is the framework's, which is served only flat, at /src/`);
});

test("createModuleServer: a root file is typed by its extension unless type says, and an unknown one must say", async (t) => {
    const root = await appDir(t, { ...FILES, "data.bin": "x" });
    await refused({ root, rootFiles: { "/data.bin": "data.bin" } }, 'createModuleServer: root file "/data.bin": say its type; its extension names none');
    for (const type of ["", 5]) {
        await refused({ root, rootFiles: { "/data.bin": { file: "data.bin", type } } }, 'createModuleServer: root file "/data.bin": say its type; its extension names none');
    }
    const modules = await createModuleServer({ root, build: "b1", rootFiles: { "/data.bin": { file: "data.bin", type: "application/octet-stream" } } });
    assert.equal((await ask(modules, "/data.bin")).headers["content-type"], "application/octet-stream");
});

test("createModuleServer: a root file's headers are the app's own, never its type or caching, and only ones a response can carry", async (t) => {
    const root = await appDir(t, FILES);
    const where = 'createModuleServer: root file "/sw.js"';
    const withHeaders = (headers) => ({ root, rootFiles: { "/sw.js": { file: "web/sw.js", headers } } });
    for (const headers of [null, ["x"], "service-worker-allowed: /"]) await refused(withHeaders(headers), `${where}: headers are { name: value }`);
    for (const name of ["content-type", "Cache-Control", "CONTENT-TYPE"]) {
        await refused(withHeaders({ [name]: "x" }), `${where}: ${name} is not the app's to set: a root file is typed by \`type\`, and always revalidated`);
    }
    await refused(withHeaders({ "x-n": 1 }), `${where}: header x-n is not a string`);
    await refused(withHeaders({ "bad name": "x" }), `${where}: header "bad name" is not one a response can carry`);
    await refused(withHeaders({ "x-split": "a\r\nset-cookie: x=1" }), `${where}: header "x-split" is not one a response can carry`);
});

test("createModuleServer: in production a declared root file missing at start refuses construction; development reads it later", async (t) => {
    const root = await appDir(t, FILES);
    await assert.rejects(createModuleServer({ root, build: "b1", rootFiles: { "/manifest.webmanifest": "web/manifest.webmanifest" } }), { code: "ENOENT" });
    const modules = await createModuleServer({ root, dev: true, build: "b1", rootFiles: { "/manifest.webmanifest": "web/manifest.webmanifest" } });
    assert.equal((await ask(modules, "/manifest.webmanifest")).status, 404);
});

// ---- static entries ---------------------------------------------------------------------------

test("createModuleServer: a static entry is { url, dir, depth, only } or { url, file }, and not both", async (t) => {
    const root = await appDir(t, FILES);
    await refused({ root, static: { url: "/pub/", dir: "pub" } }, "createModuleServer: `static` is a list of { url, dir, depth, only } or { url, file }");
    for (const entry of [null, ["/pub/"], "/pub/"]) {
        await refused({ root, static: [entry] }, "createModuleServer: a static entry is { url, dir, depth, only } or { url, file }");
    }
    for (const entry of [{ url: "/pub/" }, { url: "/pub/", dir: "pub", file: "pub/logo.png", only: [".png"] }]) {
        await refused({ root, static: [entry] }, 'createModuleServer: static "/pub/": give it a dir (a directory\'s files) or a file (one), not both');
    }
});

test("createModuleServer: a static entry's url is a path of plain names: a directory's ends with /, a file's has an extension", async (t) => {
    const root = await appDir(t, FILES);
    for (const url of ["/pub", "pub/", "/p b/", "/.pub/", 5]) {
        await refused({ root, static: [{ url, dir: "pub", only: [".png"] }] }, `createModuleServer: static ${JSON.stringify(url)}: a url is a path of plain names that starts with "/", and ends with "/"`);
    }
    for (const url of ["/logo", "/pub/", "logo.png", "/.logo.png", "/a/../logo.png"]) {
        await refused({ root, static: [{ url, file: "pub/logo.png" }] }, `createModuleServer: static ${JSON.stringify(url)}: a url is a path of plain names that starts with "/", and names a file with an extension`);
    }
    await refused({ root, static: [{ url: "/src/fonts/", dir: "pub", only: [".png"] }] }, 'createModuleServer: static "/src/fonts/": /src/ is the framework\'s');
    await refused({ root, static: [{ url: "/src/logo.png", file: "pub/logo.png" }] }, 'createModuleServer: static "/src/logo.png": /src/ is the framework\'s');
});

test("createModuleServer: a static entry's dir or file is a path inside the root that does not reach the framework", async (t) => {
    const root = await appDir(t, FILES);
    for (const dir of ["", 5]) await refused({ root, static: [{ url: "/pub/", dir, only: [".png"] }] }, 'createModuleServer: static "/pub/": no dir');
    for (const file of ["", null]) await refused({ root, static: [{ url: "/logo.png", file }] }, 'createModuleServer: static "/logo.png": no file');
    await refused({ root, static: [{ url: "/pub/", dir: "..", only: [".png"] }] }, 'createModuleServer: static "/pub/": its dir is outside the root');
    await refused({ root, static: [{ url: "/logo.png", file: "../logo.png" }] }, 'createModuleServer: static "/logo.png": its file is outside the root');
    for (const depth of [-1, 0.5, "2"]) {
        await refused({ root, static: [{ url: "/pub/", dir: "pub", depth, only: [".png"] }] }, 'createModuleServer: static "/pub/": depth is a whole number of subdirectory levels');
    }
    const reaches = (url) => `createModuleServer: static ${JSON.stringify(url)}: it reaches the framework, which is served only flat, at /src/`;
    await refused({ root: ABOVE_BOTH, static: [{ url: "/fw/", dir: path.basename(JURIS_DIR), only: [".js"] }] }, reaches("/fw/"));
    await refused({ root: ABOVE_BOTH, static: [{ url: "/all/", dir: ".", depth: 1, only: [".js"] }] }, reaches("/all/"));
    await refused({ root: ABOVE_BOTH, static: [{ url: "/kit.json", file: path.join(path.basename(KIT_DIR), "package.json") }] }, reaches("/kit.json"));
});

test("createModuleServer: a static entry is typed by its extension unless type says, and only lists extensions", async (t) => {
    const root = await appDir(t, { ...FILES, "data.bin": "x" });
    for (const type of ["", 5]) {
        await refused({ root, static: [{ url: "/pub/", dir: "pub", only: [".png"], type }] }, 'createModuleServer: static "/pub/": type is a content type');
    }
    for (const only of [undefined, [], ["png"], [".png", 5], ".png", [".a.b"]]) {
        await refused({ root, static: [{ url: "/pub/", dir: "pub", only }] }, 'createModuleServer: static "/pub/": only is a list of extensions such as ".woff2"');
    }
    await refused({ root, static: [{ url: "/pub/", dir: "pub", only: [".png", ".xyz"] }] }, 'createModuleServer: static "/pub/": say its type; .xyz names none');
    await refused({ root, static: [{ url: "/data.bin", file: "data.bin" }] }, 'createModuleServer: static "/data.bin": say its type; .bin names none');
    const modules = await createModuleServer({ root, build: "b1", static: [{ url: "/data.bin", file: "data.bin", type: "application/octet-stream" }] });
    assert.equal((await ask(modules, "/data.bin")).headers["content-type"], "application/octet-stream");
});

test("createModuleServer: a static entry is kept immutable or for maxAge seconds, not both", async (t) => {
    const root = await appDir(t, FILES);
    const entry = (more) => ({ root, static: [{ url: "/pub/", dir: "pub", only: [".png"], ...more }] });
    for (const immutable of ["yes", 1, null]) await refused(entry({ immutable }), 'createModuleServer: static "/pub/": immutable is true or false');
    for (const maxAge of [-1, 1.5, "60", null]) await refused(entry({ maxAge }), 'createModuleServer: static "/pub/": maxAge is a whole number of seconds');
    await refused(entry({ immutable: true, maxAge: 60 }), 'createModuleServer: static "/pub/": immutable or a maxAge, not both');
    await createModuleServer({ ...entry({ immutable: false, maxAge: 0 }), build: "b1" });
});

test("createModuleServer: a static entry that would answer a URL another static entry answers is refused", async (t) => {
    const root = await appDir(t, FILES);
    const dir = (url, only = [".png"]) => ({ url, dir: "pub", only });
    const file = (url) => ({ url, file: "pub/logo.png" });
    await refused({ root, static: [file("/logo.png"), file("/logo.png")] }, "createModuleServer: static /logo.png: served twice (another static entry at /logo.png)");
    await refused({ root, static: [dir("/pub/"), dir("/pub/")] }, "createModuleServer: static /pub/: served twice (another static entry at /pub/)");
    await refused({ root, static: [dir("/pub/"), dir("/pub/img/")] }, "createModuleServer: static /pub/img/: served twice (another static entry at /pub/)");
    await refused({ root, static: [dir("/pub/img/"), dir("/pub/")] }, "createModuleServer: static /pub/: served twice (another static entry at /pub/img/)");
    await refused({ root, static: [dir("/pub/"), file("/pub/logo.png")] }, "createModuleServer: static /pub/logo.png: served twice (another static entry also serves /pub/logo.png)");
    await refused({ root, static: [file("/pub/logo.png"), dir("/pub/")] }, "createModuleServer: static /pub/: served twice (another static entry also serves /pub/logo.png)");
    // Beside each other, with nothing in common: allowed.
    await createModuleServer({ root, build: "b1", static: [dir("/pub/"), dir("/pubs/"), file("/pub/logo.svg"), file("/logo.png")] });
});

test("createModuleServer: a static entry that would answer a URL a mount, an asset or a root file answers is refused", async (t) => {
    const root = await appDir(t, FILES);
    const base = { root, mounts: [{ url: "/app/", dir: "app" }], assets: ["/site.css"], rootFiles: { "/robots.txt": "robots.txt" } };
    await refused({ ...base, static: [{ url: "/app/img/", dir: "pub", only: [".png"] }] }, "createModuleServer: static /app/img/: a module mount (/app/) also serves under it");
    await refused({ ...base, mounts: [{ url: "/a/b/", dir: "app" }], static: [{ url: "/a/", dir: "pub", only: [".png"] }] }, "createModuleServer: static /a/: a module mount (/a/b/) also serves under it");
    await refused({ ...base, assets: ["/x/site.css"], static: [{ url: "/x/", dir: "pub", only: [".css"] }] }, "createModuleServer: static /x/: an asset or a root file also serves /x/site.css");
    await refused({ ...base, static: [{ url: "/r/", dir: "pub", only: [".txt"] }], rootFiles: { "/r/robots.txt": "robots.txt" } }, "createModuleServer: static /r/: an asset or a root file also serves /r/robots.txt");
    for (const url of ["/app/a.js", "/site.css", "/robots.txt"]) {
        await refused({ ...base, static: [{ url, file: "pub/logo.png", type: "image/png" }] }, `createModuleServer: static ${url}: a mount, an asset or a root file also serves that URL`);
    }
    // What none of them serves is free: another extension under a mount, a directory beside an asset.
    await createModuleServer({ ...base, dev: true, build: "b1", assets: ["/site.css", "/x/site.css"], static: [{ url: "/app/logo.png", file: "pub/logo.png" }, { url: "/x/", dir: "pub", only: [".woff2"] }] });
});
