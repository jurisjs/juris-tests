// For the module server's tests (server/modules.js): an app's directory on disk, the directories
// the module server holds as the framework's, and a way to ask a module server for a URL as a
// browser would, recording what it answered.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

// The juris package's directory, and the kit's (one up from its server/), as Node resolves them.
export const JURIS_DIR = path.dirname(fileURLToPath(import.meta.resolve("juris")));
export const KIT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("juris-kit/server/modules.js"))));
// A directory both sit in, which an app that vendors them could be.
export const ABOVE_BOTH = path.dirname(JURIS_DIR);

// A temporary app root holding `files` ({ "app/a.js": "…" }), removed when the test ends.
export async function appDir(t, files = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "juris-tests-modules-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await put(root, files);
    return root;
}

// Writes `files` under `root`, making the directories they need.
export async function put(root, files) {
    for (const [name, content] of Object.entries(files)) {
        const file = path.join(root, name);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content);
    }
}

// What `modules.handle` does with a GET of `pathname` (or the `method` given): { handled, status,
// headers, body, text }, with the body as a Buffer (gunzipped as `text` when it was sent gzipped).
// `status` is null when nothing was written.
export async function ask(modules, pathname, headers = {}, { method = "GET" } = {}) {
    let status = null;
    let written = null;
    const chunks = [];
    const res = {
        writeHead(code, h = {}) {
            status = code;
            written = Object.fromEntries(Object.entries(h).map(([name, value]) => [name.toLowerCase(), value]));
        },
        end(chunk) { if (chunk !== undefined) chunks.push(Buffer.from(chunk)); },
    };
    const handled = await modules.handle({ method, headers }, res, new URL(pathname, "http://localhost"));
    const body = Buffer.concat(chunks);
    const plain = written?.["content-encoding"] === "gzip" ? gunzipSync(body) : body;
    return { handled, status, headers: written, body, text: plain.toString("utf8") };
}
