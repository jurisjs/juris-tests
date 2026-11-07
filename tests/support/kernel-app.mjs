// What the tests of server/kernel.js share (tests/juris-kit/kernel.*.test.mjs): a small app's server
// instance and router, a temporary app directory with a browser entry, HTTP servers on port 0, and
// requests that answer { status, headers, body }.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import Juris from "juris/juris.js";
import { createRouter } from "juris/router.js";
import { withSSR } from "./ssr-renderer.mjs";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A promise and the functions that settle it, for a test that decides when something finishes.
export function gate() {
    let open, fail;
    const promise = new Promise((resolve, reject) => { open = resolve; fail = reject; });
    return { promise, open, fail };
}

// A server instance with `routes`, the App layout around a RouterView, and `components`: what
// createPagePipeline is given. It renders with the kit's string renderer, as the kernel's does.
export async function pipelineApp({ services = {}, routes, components = {}, router: routerOptions = {}, juris: jurisOptions = {} }) {
    const juris = new Juris(withSSR({ services, isServer: true, requirePreload: true, ...jurisOptions }));
    const router = createRouter({ ...routerOptions, routes });
    juris.use(router);
    juris.registerComponent("App", () => ({ main: { children: [{ RouterView: {} }] } }));
    for (const [name, component] of Object.entries(components)) juris.registerComponent(name, component);
    await router.loadAll();
    return { juris, router };
}

// The App layout and the components, registered on the instance createJurisServer hands to setup.
export const register = (components = {}) => (juris) => {
    juris.registerComponent("App", () => ({ main: { children: [{ RouterView: {} }] } }));
    for (const [name, component] of Object.entries(components)) juris.registerComponent(name, component);
};

// A temporary app directory: app/boot.js (the browser entry) and whatever else `files` names.
export async function appRoot(files = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "juris-tests-kernel-"));
    const all = { "app/boot.js": "export const start = () => {};\n", ...files };
    for (const [name, text] of Object.entries(all)) {
        await mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await writeFile(path.join(root, name), text);
    }
    return { root, remove: () => rm(root, { recursive: true, force: true }) };
}

// The module options of an app whose entry is app/boot.js.
export const MODULES = Object.freeze({ mounts: [{ url: "/app/", dir: "app" }], entry: "/app/boot.js" });

// A server on port 0 around `handler`, and a way to close it.
export async function serve(handler) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        port: server.address().port,
        server,
        close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
    };
}

// One request: { status, headers, body (text) }, or { error } when the connection failed.
export function request(port, pathname = "/", { method = "GET", headers = {}, body = null, agent = false } = {}) {
    return new Promise((resolve) => {
        const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers, agent }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { text += chunk; });
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
            res.on("error", (error) => resolve({ status: res.statusCode, error }));
        });
        req.on("error", (error) => resolve({ error }));
        if (body !== null) req.write(body);
        req.end();
    });
}

// A request whose headers arrive and whose body never ends, for answers given while one is open (an
// event stream): answers { status, headers, first (the first chunk), close() }.
export function openStream(port, pathname, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path: pathname, headers, agent: false }, (res) => {
            res.setEncoding("utf8");
            let ended = false;
            const end = new Promise((done) => { res.on("end", () => { ended = true; done(); }); res.on("close", () => done()); });
            res.once("data", (first) => resolve({ status: res.statusCode, headers: res.headers, first, ended: () => ended, end, close: () => { req.destroy(); res.destroy(); } }));
            if (res.statusCode !== 200) res.resume();
        });
        req.on("error", (error) => { if (error.code !== "ECONNRESET") reject(error); });
    });
}

export const titleIn = (html) => /<title>([^<]*)<\/title>/.exec(html)?.[1];
export const canonicalIn = (html) => /<link rel="canonical" href="([^"]*)">/.exec(html)?.[1];
export const stateIn = (html) => JSON.parse(/<script type="application\/json" id="state">([\s\S]*?)<\/script>/.exec(html)[1]);
export const servicesIn = (html) => {
    const match = /<script type="application\/json" id="services">([\s\S]*?)<\/script>/.exec(html);
    return match ? JSON.parse(match[1]) : null;
};

// A response that records what it is told, for handle() called with no socket.
export function recorder() {
    const res = {
        statusCode: 200, headers: {}, body: "", ended: false, headersSent: false,
        setHeader(name, value) { res.headers[name.toLowerCase()] = value; },
        getHeader(name) { return res.headers[name.toLowerCase()]; },
        writeHead(status, headers = {}) {
            res.statusCode = status;
            for (const [name, value] of Object.entries(headers)) res.headers[name.toLowerCase()] = value;
            res.headersSent = true;
            return res;
        },
        write(chunk) { res.headersSent = true; res.body += String(chunk); return true; },
        end(chunk) { if (chunk !== undefined) res.body += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk); res.ended = true; res.headersSent = true; },
    };
    return res;
}
