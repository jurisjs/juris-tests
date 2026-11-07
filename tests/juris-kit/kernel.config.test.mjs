// server/kernel.js, createJurisServer's construction, held to REFERENCE.md's "server/kernel.js": every
// option it refuses, at the top and inside one that takes its own (a misspelt option would leave a
// page unguarded without a word), the entry checked against the module server, a cluster worker
// refused beside live queries unless allowed, setup awaited before every route's code is loaded,
// and a server that cannot be built closing the dispatcher it made. A temporary app directory,
// removed afterwards; nothing here listens.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createJurisServer } from "juris-kit/server/kernel.js";
import { createPageCache } from "juris-kit/server/page-cache.js";
import { appRoot, MODULES, register } from "../support/kernel-app.mjs";

const app = await appRoot();
after(() => app.remove());

const base = () => ({ root: app.root, build: "b1", services: {}, routes: [], modules: { ...MODULES } });
const handlerApi = (names = []) => Object.assign(async () => false, { names });
const devReloadLike = () => ({ script: "1;", handle: () => false, close: () => {} });

// createJurisServer(config) refuses with a TypeError whose message matches.
const refuses = (config, message, label) => assert.rejects(createJurisServer(config), { name: "TypeError", message }, label);

// Builds, and closes what it built.
async function builds(config) {
    const server = await createJurisServer(config);
    await server.close();
    return server;
}

// A bus that records whether its subscription was let go.
function watchedBus() {
    const bus = { subscribed: 0, unsubscribed: 0 };
    bus.publish = async () => {};
    bus.subscribe = () => { bus.subscribed++; return () => { bus.unsubscribed++; }; };
    return bus;
}

// ---- the top level ----------------------------------------------------------------------------

test("the config is an object, of the options it names: any other is refused, not ignored", async () => {
    for (const config of [null, [], "app", 5]) await refuses(config, /^createJurisServer: config is an object$/, JSON.stringify(config));
    await refuses({ ...base(), pages: {} }, /createJurisServer: pages is not an option \(root, dev, build, services, routes, router, setup, layout, juris, exposeError, api, handlers, modules, page, cache, devReload, trustProxy, allowWorkers, instance, instanceHeader, health, jobs, closeTimeoutMs, onShutdown, onError, cluster\)/);
    await refuses({ ...base(), guard: () => null }, /guard is not an option/);
    await refuses(undefined, /root, the app's directory/, "no config at all: the first thing missing is the root");
});

test("root, build, services and routes are required", async () => {
    for (const root of [undefined, "", 5, {}]) await refuses({ ...base(), root }, /root, the app's directory \(a path or a file: URL\), is required/, String(root));
    for (const build of [undefined, "", 7, () => "", () => 7, () => null]) await refuses({ ...base(), build }, /build, this deploy's name \(a non-empty string, or a function answering one\), is required/, String(build));
    for (const services of [undefined, null, [], "svc"]) await refuses({ ...base(), services }, /services, the app's services \(\{ name: function \}\), are required/, String(services));
    for (const routes of [undefined, {}, "routes"]) await refuses({ ...base(), routes }, /routes, a list of route records, are required/, String(routes));
});

test("router is the router's options beside the routes, which are an option of their own; the router refuses what it does not know", async () => {
    for (const router of [null, [], "guard"]) await refuses({ ...base(), router }, /router is the router's options beside its routes/, JSON.stringify(router));
    await refuses({ ...base(), router: { routes: [] } }, /router\.routes: the routes are an option of their own, routes/);
    await assert.rejects(createJurisServer({ ...base(), router: { gaurd: () => null } }), { name: "TypeError", message: /gaurd/ });
});

test("setup, exposeError, handlers, onShutdown and onError are what they say", async () => {
    await refuses({ ...base(), setup: "register" }, /setup is a function, given the server's Juris instance/);
    await refuses({ ...base(), exposeError: true }, /exposeError is a function/);
    for (const handlers of [{}, [() => true, "upload"], "x"]) await refuses({ ...base(), handlers }, /handlers is a list of the app's own routes/, String(handlers));
    for (const onShutdown of [() => {}, [null]]) await refuses({ ...base(), onShutdown }, /onShutdown is a list of what the app closes last/, String(onShutdown));
    await refuses({ ...base(), onError: "console" }, /onError is a function/);
});

test("juris takes only the instance options the browser is given too, checked by sharedOptions", async () => {
    await refuses(
        { ...base(), juris: { allowTag: ["iframe"] } },
        /createJurisServer: juris\.allowTag is not an option \(allowTags, allowSchemes, allowInnerHTML, components\)/,
    );
    await refuses({ ...base(), juris: "strict" }, /createJurisServer: juris is the instance's options, a plain object/);
    await refuses({ ...base(), juris: { allowInnerHTML: "false" } }, /allowInnerHTML is true or false/);
});

test("juris.components is checked by sharedOptions before anything is built, setup included", async () => {
    let setUp = false;
    const setup = () => {
        setUp = true;
    };
    await refuses(
        { ...base(), setup, juris: { components: "Home" } },
        /^createJurisServer: juris\.components is an object of components by name/,
    );
    await refuses(
        { ...base(), setup, juris: { components: [() => ({ p: {} })] } },
        /^createJurisServer: juris\.components\[0\] is a function with no name/,
    );
    assert.equal(setUp, false);
});

test("juris.components are registered on the server's instance before the router and setup", async () => {
    const order = [];
    const Home = () => ({ p: {} });
    const server = await builds({
        ...base(),
        juris: { components: [Home] },
        setup: (juris) => {
            order.push(["setup", juris.hasComponent("Home"), juris.hasComponent("RouterView")]);
        },
    });
    assert.deepEqual(order, [["setup", true, true]]);
    assert.equal(server.juris.componentManager.get("Home"), Home);
    const names = server.juris.componentManager.names();
    assert.ok(names.indexOf("Home") < names.indexOf("RouterView"), "registered with the instance, before the router's");
});

test("a name juris.components registers is refused a second time, as registerComponent refuses it", async () => {
    const Home = () => ({ p: {} });
    await assert.rejects(
        createJurisServer({ ...base(), juris: { components: { Home } }, setup: register({ Home }) }),
        { name: "Error", message: 'ComponentManager.registerComponent: "Home" is already registered' },
    );
    await assert.rejects(
        createJurisServer({ ...base(), juris: { components: { Link: Home } } }),
        { name: "Error", message: 'ComponentManager.registerComponent: "Link" is already registered' },
        "the router's own names are taken when it is installed",
    );
});

test("api is the dispatcher's options or a handler the app built, and the dispatcher refuses what it does not know", async () => {
    for (const api of [[], "dispatch", 5, null]) await refuses({ ...base(), api }, /api is the dispatcher's options, or a handler \(req, res, url\) → boolean/, JSON.stringify(api));
    await assert.rejects(createJurisServer({ ...base(), api: { lve: {} } }), { name: "TypeError", message: /lve/ });
});

test("a cache is a page cache, and only beside a handler the app built, which carries the invalidations to it", async () => {
    for (const cache of [{}, { get() {}, put() {}, snapshot() {} }, "lru", new Map()]) {
        await refuses({ ...base(), api: handlerApi(), cache }, /cache is a page cache \(page-cache\.js createPageCache\), or null for none/, String(cache));
    }
    await refuses({ ...base(), cache: createPageCache() }, /a page cache is kept up to date by the services' invalidations, which a dispatcher built here does not carry to it/);
    await builds({ ...base(), api: handlerApi(), cache: createPageCache() });
});

test("devReload is development's reload, and refused outside development", async () => {
    for (const devReload of [{}, { script: 1, handle() {}, close() {} }, { script: "", handle: 1, close() {} }, { script: "", handle() {} }, "reload"]) {
        await refuses({ ...base(), dev: true, devReload }, /devReload is development's reload \(dev-reload\.js devReload\), or null/, JSON.stringify(devReload));
    }
    await refuses({ ...base(), devReload: devReloadLike() }, /devReload is development's, and this server is not in development/);
    await builds({ ...base(), dev: true, devReload: devReloadLike() });
});

test("trustProxy is false, true or { hops }, a whole number from 1, and only beside a dispatcher built here", async () => {
    await refuses({ ...base(), trustProxy: { hop: 2 } }, /createJurisServer: trustProxy\.hop is not an option \(hops\)/);
    for (const trustProxy of ["yes", 1, null, { hops: 0 }, { hops: 1.5 }, { hops: "2" }]) {
        await refuses({ ...base(), trustProxy }, /trustProxy is false, true, or \{ hops \}, a whole number of proxies, at least 1/, JSON.stringify(trustProxy));
    }
    await refuses({ ...base(), api: handlerApi(), trustProxy: true }, /trustProxy says how a dispatcher built here counts its callers, and api is a handler the app built/);
    for (const trustProxy of [true, {}, { hops: 3 }, false]) await builds({ ...base(), trustProxy });
});

test("allowWorkers is a boolean, and cluster is Node's cluster or one like it", async () => {
    await refuses({ ...base(), allowWorkers: "yes" }, /allowWorkers is true or false/);
    for (const cluster of [{}, null, { isWorker: "no" }]) await refuses({ ...base(), cluster }, /cluster is Node's cluster/, JSON.stringify(cluster));
});

test("modules and page take only the keys they name", async () => {
    for (const modules of [[], "app", null]) await refuses({ ...base(), modules }, /modules is \{ mounts, assets, rootFiles, minify, entry \}/, JSON.stringify(modules));
    await refuses({ ...base(), modules: { ...MODULES, mount: [] } }, /createJurisServer: modules\.mount is not an option \(mounts, assets, rootFiles, static, minify, entry\)/);
    for (const page of [[], "page", null]) await refuses({ ...base(), page }, /page is an object of the page pipeline's hooks/, JSON.stringify(page));
    await refuses({ ...base(), page: { guard: () => null } }, /createJurisServer: page\.guard is not an option \(origin, viewer, extra, before, personal, preload, state, notFound, title, head, headers, cacheParams, onRender, serviceNames\)/);
    // What the kernel sets itself is not a page option.
    for (const key of ["juris", "router", "cache", "dev", "entry", "layout", "devReload", "onError"]) await refuses({ ...base(), page: { [key]: null } }, new RegExp(`page\\.${key} is not an option`), key);
});

test("closeTimeoutMs is a whole number of milliseconds from 0, which cuts at once, to 2^31 - 1", async () => {
    for (const closeTimeoutMs of [-1, 1.5, 2 ** 31, Infinity, NaN, "8000", null]) {
        await refuses({ ...base(), closeTimeoutMs }, /closeTimeoutMs is a whole number of milliseconds, 0 \(cut at once\) to 2147483647/, String(closeTimeoutMs));
    }
    for (const closeTimeoutMs of [0, 2 ** 31 - 1]) await builds({ ...base(), closeTimeoutMs });
});

test("modules.entry is required, and must be a file the module server serves", async () => {
    for (const modules of [{ mounts: MODULES.mounts }, { ...MODULES, entry: "" }, { ...MODULES, entry: 5 }]) {
        await refuses({ ...base(), modules }, /modules\.entry, the URL of the app's browser entry, is required/, JSON.stringify(modules.entry));
    }
    await refuses({ ...base(), modules: { ...MODULES, entry: "/app/missing.js" } }, /^createJurisServer: modules\.entry \/app\/missing\.js is not a file the module server serves: a mount or an asset names it, and it exists$/);
    await refuses({ ...base(), modules: { ...MODULES, entry: "/elsewhere/boot.js" } }, /modules\.entry \/elsewhere\/boot\.js is not a file the module server serves/);
});

test("page.serviceNames is a list of names or false, and a handler the app built says its names unless the page does", async () => {
    for (const serviceNames of ["all", [1], true, null]) await refuses({ ...base(), page: { serviceNames } }, /page\.serviceNames is a list of service names, or false for none/, JSON.stringify(serviceNames));
    const nameless = Object.assign(async () => false, {});
    await refuses({ ...base(), api: nameless }, /api is a handler that does not say which services it answers to \(its `names`\), so the page cannot either/);
    await refuses({ ...base(), api: Object.assign(async () => false, { names: "items" }) }, /does not say which services it answers to/);
    await builds({ ...base(), api: nameless, page: { serviceNames: false } });
    await builds({ ...base(), api: nameless, page: { serviceNames: ["items"] } });
    await builds({ ...base(), api: handlerApi(["items"]) });
});

test("the options inside health and a job are refused by the lifecycle", async () => {
    await refuses({ ...base(), health: { timeoutMS: 10 } }, /createLifecycle: health\.timeoutMS is not an option/);
    await refuses({ ...base(), jobs: [{ name: "j", every: 0, run() {} }] }, /createLifecycle: job "j" needs an interval/);
});

// ---- a server that cannot be built ------------------------------------------------------------

test("a server that cannot be built closes the dispatcher it made, so its bus subscription does not outlive it", async () => {
    const services = { async items() { return []; } };
    const live = (bus) => ({ live: { queries: ["items"], public: true, bus } });
    const missing = watchedBus();
    await refuses({ ...base(), services, api: live(missing), modules: { ...MODULES, entry: "/app/missing.js" } }, /is not a file the module server serves/);
    assert.deepEqual({ subscribed: missing.subscribed, unsubscribed: missing.unsubscribed }, { subscribed: 1, unsubscribed: 1 });
    // The module server itself refusing (a mount outside the root) closes it too.
    const outside = watchedBus();
    await assert.rejects(createJurisServer({ ...base(), services, api: live(outside), modules: { mounts: [{ url: "/app/", dir: "../../elsewhere" }], entry: "/app/boot.js" } }), /outside the root/);
    assert.deepEqual({ subscribed: outside.subscribed, unsubscribed: outside.unsubscribed }, { subscribed: 1, unsubscribed: 1 });
    // A lifecycle that refuses its options does too.
    const lifecycle = watchedBus();
    await refuses({ ...base(), services, api: live(lifecycle), jobs: [{ name: "j", every: 10 }] }, /has nothing to run/);
    assert.equal(lifecycle.unsubscribed, 1);
});

test("a server that cannot be built leaves a handler the app built to the app", async () => {
    let closed = 0;
    const api = Object.assign(async () => false, { names: [], close: () => { closed++; } });
    await refuses({ ...base(), api, modules: { ...MODULES, entry: "/app/missing.js" } }, /is not a file the module server serves/);
    assert.equal(closed, 0);
});

test("a route whose code cannot be loaded is a server that cannot start", async () => {
    const routes = [{ path: "/", name: "home", component: "Home", load: async () => { throw new Error("chunk missing"); } }];
    await assert.rejects(createJurisServer({ ...base(), routes, setup: register({ Home: () => ({ p: {} }) }) }), /chunk missing/);
});

test("setup is awaited, after the router is installed, before every route's code is loaded", async () => {
    const order = [];
    const routes = [{ path: "/", name: "home", component: "Home", load: async (juris) => { order.push(["load", juris.isServer]); } }];
    const server = await builds({
        ...base(), routes,
        setup: async (juris) => {
            order.push(["setup", juris.hasComponent("RouterView"), juris.isServer]);
            await new Promise((resolve) => setTimeout(resolve, 5));
            register({ Home: () => ({ p: {} }) })(juris);
            order.push(["setup done"]);
        },
    });
    assert.deepEqual(order, [["setup", true, true], ["setup done"], ["load", true]]);
    assert.equal(server.router.routePath, "$route");
    assert.equal(server.juris.isServer, true);
});

// ---- cluster workers --------------------------------------------------------------------------

test("in a cluster worker, a server beside live queries is refused unless allowWorkers says otherwise", async () => {
    const worker = { isWorker: true };
    const services = { async items() { return []; }, async save() {} };
    const message = /this is a cluster worker, and live queries do not survive workers on one port/;
    await assert.rejects(createJurisServer({ ...base(), services, cluster: worker, api: { live: { queries: ["items"], public: true } } }), { name: "Error", message });
    await assert.rejects(createJurisServer({ ...base(), services, cluster: worker, api: { live: { touches: { save: ["items"] }, public: true } } }), { name: "Error", message });
    // A handler the app built is taken to serve live queries: the kernel cannot see inside it.
    await assert.rejects(createJurisServer({ ...base(), cluster: worker, api: handlerApi() }), { name: "Error", message });
    await builds({ ...base(), services, cluster: worker, allowWorkers: true, api: { live: { queries: ["items"], public: true } } });
    await builds({ ...base(), cluster: worker, allowWorkers: true, api: handlerApi() });
});

test("in a cluster worker, a server with no live queries serves", async () => {
    const worker = { isWorker: true };
    await builds({ ...base(), cluster: worker });
    await builds({ ...base(), cluster: worker, api: { live: { queries: [], touches: {} } } });
    await builds({ ...base(), cluster: { isWorker: false }, api: handlerApi() });
});

test("root may be a file: URL", async () => {
    const server = await builds({ ...base(), root: pathToFileURL(`${app.root}/`) });
    assert.match(server.codeId, /\S/);
});
