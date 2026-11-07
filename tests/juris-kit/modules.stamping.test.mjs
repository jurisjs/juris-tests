// Import stamping (server/modules.js): every import a served module makes of a relative specifier,
// or of an absolute one under a mount or naming a module asset, carries ?v=<code id>, in every form
// a browser follows and however it is spaced; nothing else in the text changes, and a string, a
// comment, a regex or a template that only spells an import is left as it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createModuleServer } from "juris-kit/server/modules.js";
import { minifyJs } from "juris-kit/server/minify.js";
import { appDir, ask } from "../support/modules-app.mjs";

// Each line imports one specifier, which is stamped.
const STAMPED = [
    ['import { a } from "./a.js";', "./a.js"],
    ["import b from '../shared/b.js';", "../shared/b.js"],
    ['import "./side.js";', "./side.js"],
    ['export { c } from "./c.js";', "./c.js"],
    ['export * from "/app/d.js";', "/app/d.js"],
    ['export * as ns from "/app/lib/ns.js";', "/app/lib/ns.js"],
    ['import * as juris from "/src/juris.js";', "/src/juris.js"],
    ['import { start } from "/boot.js";', "/boot.js"],
    ['import{e}from"./e.js";', "./e.js"],
    ['import f from\n    "./f.js";', "./f.js"],
    ['import /* why */ "./side2.js";', "./side2.js"],
    ['const g = () => import("./g.js");', "./g.js"],
    ['const h = () => import("./h.js", { with: {} });', "./h.js"],
    ["const i = () => import(`./i.js`);", "./i.js"],
    ['const j = () => import (\n    "./j.js"\n);', "./j.js"],
    ['const k = `${await import("./k.js")}`;', "./k.js"],
    ["const l = import('/app/l.js');", "/app/l.js"],
];

// Lines that only spell an import, or import what is not stamped: left exactly as they are.
const LEFT = [
    'import x from "https://cdn.example.com/x.js";',
    'import y from "bare-package";',
    'import z from "/elsewhere/z.js";',
    'import "/site.css";',
    'import w from "./w.json";',
    'const name = "./a.js";',
    'const list = Array.from("./a.js");',
    'loader.import("./a.js");',
    "const m = () => import(name);",
    "const n = () => import(`./${name}.js`);",
    'const o = () => import("./o" + ".js");',
    'const p = new URL("./p.js", import.meta.url);',
    '// import q from "./q.js";',
    '/* import("./r.js") */',
    'const s = /import "\\.\\/s\\.js"/;',
    'const t = `import "./t.js"`;',
    'const u = "import v from \\"./v.js\\"";',
];

const SOURCE = [...STAMPED.map(([line]) => line), ...LEFT].join("\n") + "\n";
const stamped = (id) => [...STAMPED.map(([line, spec]) => line.replace(spec, `${spec}?v=${id}`)), ...LEFT].join("\n") + "\n";

const FILES = {
    "app/main.js": SOURCE,
    "app/style.css": '@import "./other.css";\n@import url("/app/other.css");\n',
    "boot.js": "export function start() {}\n",
    "site.css": "body{}\n",
};
const server = (root, options) => createModuleServer({
    root, build: "b1", mounts: [{ url: "/app/", dir: "app", depth: 1, only: [".js", ".css"] }], assets: ["/boot.js", "/site.css"], ...options,
});

test("stamping: every import form a browser follows is stamped, and nothing else in the text changes", async (t) => {
    const root = await appDir(t, FILES);
    for (const dev of [true, false]) {
        const modules = await server(root, { dev, minify: false });
        const { text } = await ask(modules, "/app/main.js");
        assert.equal(text, stamped(modules.codeId), `dev: ${dev}`);
    }
});

test("stamping: in production the stamped text is what is minified", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root);
    assert.equal((await ask(modules, "/app/main.js")).text, minifyJs(stamped(modules.codeId)));
});

test("stamping: a stylesheet is never stamped", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root, { dev: true });
    assert.equal((await ask(modules, "/app/style.css")).text, FILES["app/style.css"]);
});

test("stamping: an asset imported gets the code id alone, not the URL versioned() gives it", async (t) => {
    const root = await appDir(t, FILES);
    const modules = await server(root, { minify: false });
    const { text } = await ask(modules, "/app/main.js");
    assert.ok(text.includes(`from "/boot.js?v=${modules.codeId}"`));
    assert.notEqual(await modules.versioned("/boot.js"), `/boot.js?v=${modules.codeId}`);
});

test("stamping: each server stamps with its own code id", async (t) => {
    const root = await appDir(t, FILES);
    const [one, two] = [await server(root, { minify: false }), await server(root, { minify: false, build: "b2" })];
    assert.notEqual(one.codeId, two.codeId);
    assert.ok((await ask(two, "/app/main.js")).text.includes(`"./a.js?v=${two.codeId}"`));
    assert.ok(!(await ask(two, "/app/main.js")).text.includes(one.codeId));
});

test("stamping: an import spaced with whitespace outside ASCII is stamped too", async (t) => {
    const root = await appDir(t, { "app/main.js": 'import { a } from\u00a0"./a.js";\nimport\u00a0"./b.js";\n' });
    const modules = await server(root, { dev: true });
    const { text } = await ask(modules, "/app/main.js");
    assert.equal(text, `import { a } from\u00a0"./a.js?v=${modules.codeId}";\nimport\u00a0"./b.js?v=${modules.codeId}";\n`);
});
