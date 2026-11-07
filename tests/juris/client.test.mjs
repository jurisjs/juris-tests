// client.js, the client boot: hydrate(options) on a server-rendered page, in a stand-in browser
// (tests/support/client-browser.mjs). The options it refuses before the page is read, what it reads
// from the page (only the server's JSON scripts), the instance it builds, the order of its steps
// (plugins, register, the route's code, beforeMount, mount, the title), and what it answers. The skew
// guard is in client.skew-guard.test.mjs, and the idle steps (prefetch, the service worker) in
// client.idle.test.mjs. Held to REFERENCE.md ("client.js", "The page contract").
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import hydrateDefault, { hydrate } from "juris/client.js";
import { Devtools } from "juris/devtools.js";
import { liveKey } from "juris/live-protocol.js";
import { ServiceError } from "juris/errors.js";
import { serialize } from "../support/dom.mjs";
import { withPage, fakePage, fakeWindow } from "../support/client-browser.mjs";
import { flush, deferred, eventSources } from "../support/remote-services-fakes.mjs";
import { withSSR } from "../support/ssr-renderer.mjs";

const routes = [{ path: "/", name: "home" }, { path: "/about", name: "about" }];
const home = { $route: { path: "/", name: "home" } };
const SERVER_MARKUP = '<div id="app">the server\'s markup</div>';

// register(juris) for an App component drawing `layout` (a function of the api, or a layout).
const app = (layout) => (juris) => juris.registerComponent("App", (props, api) => (typeof layout === "function" ? layout(api) : layout));

// ---- the options it refuses --------------------------------------------------------------------

const SHARED = "allowTags, allowSchemes, allowInnerHTML, components";
const ALL = "routes, router, register, services, apiBase, fallback, live, plugins, beforeMount, title, skewGuard, prefetch, serviceWorker, expose, stateId, rootId, root, juris, devMode";
const refused = [
    [null, "hydrate: options is an object"],
    ["routes", "hydrate: options is an object"],
    [{ routes, colour: "blue" }, `hydrate: "colour" is not an option (${ALL})`],
    [undefined, "hydrate: routes is the route table, an array"],
    [{ routes: { "/": {} } }, "hydrate: routes is the route table, an array"],
    ...[null, [], "guard"].map((router) => [{ routes, router }, "hydrate: router is the router's options beside its routes ({ guard, context, … })"]),
    [{ routes, router: { routes: [] } }, "hydrate: router.routes: the routes are an option of their own, routes"],
    ...["register", "fallback", "beforeMount"].map((name) => [{ routes, [name]: "yes" }, `hydrate: ${name} is a function`]),
    ...[null, [], "Shop", 5].map((title) => [{ routes, title }, "hydrate: title is a function, or { fallback, suffix, max, decorate }"]),
    [{ routes, title: { prefix: "x" } }, "hydrate: title.prefix is not an option (fallback, suffix, max, decorate)"],
    [{ routes, title: { fallback: 1 } }, "hydrate: title.fallback is a string"],
    [{ routes, title: { suffix: null } }, "hydrate: title.suffix is a string"],
    ...[-1, "3", NaN].map((max) => [{ routes, title: { max } }, "hydrate: title.max is a number of characters"]),
    [{ routes, title: { decorate: "!" } }, "hydrate: title.decorate is a function, decorate(text, juris)"],
    ...["save", [""], [1], ["save", null]].map((services) => [{ routes, services }, "hydrate: services is a list of service names"]),
    [{ routes, plugins: {} }, "hydrate: plugins is a list"],
    ...[null, "yes", 1].map((live) => [{ routes, live }, "hydrate: live is true, false, or the live client's options"]),
    ...[true, "eager"].map((prefetch) => [{ routes, prefetch }, 'hydrate: prefetch is "idle" or false']),
    ...["apiBase", "expose", "stateId", "rootId"].flatMap((name) => ["", 1].map((value) => [{ routes, [name]: value }, `hydrate: ${name} is a non-empty string`])),
    ...[null, "on", true].map((skewGuard) => [{ routes, skewGuard }, "hydrate: skewGuard is { storageKey, reload } or false"]),
    [{ routes, skewGuard: { storageKey: "k", wait: 1 } }, "hydrate: skewGuard.wait is not an option (storageKey, reload)"],
    ...[{}, { storageKey: "" }, { storageKey: 1 }].map((skewGuard) => [{ routes, skewGuard }, "hydrate: skewGuard.storageKey names the sessionStorage key the guard keeps its mark in"]),
    [{ routes, skewGuard: { storageKey: "k", reload: "now" } }, "hydrate: skewGuard.reload is a function"],
    ...[null, [], "App", new Map()].map((root) => [{ routes, root }, "hydrate: root is the layout mounted into the page's root element, a plain object ({ App: {} })"]),
    ...["", 5, null, {}, { url: "" }].map((serviceWorker) => [{ routes, serviceWorker }, "hydrate: serviceWorker is a script URL, or { url, onMessage }"]),
    [{ routes, serviceWorker: { url: "/sw.js", scope: "/" } }, "hydrate: serviceWorker.scope is not an option (url, onMessage)"],
    [{ routes, serviceWorker: { url: "/sw.js", onMessage: "log" } }, "hydrate: serviceWorker.onMessage is a function"],
    [{ routes, juris: "strict" }, `hydrate: juris is the instance's options, a plain object ({ ${SHARED} })`],
    [{ routes, juris: { isServer: true } }, `hydrate: juris.isServer is not an option (${SHARED})`],
    [
        { routes, juris: { components: "App" } },
        "hydrate: juris.components is an object of components by name ({ Header, Footer }),"
            + " or a list of named functions ([Header, Footer])",
    ],
    [
        { routes, juris: { components: [() => ({ p: "?" })] } },
        "hydrate: juris.components[0] is a function with no name, and a list registers each by its function's name:"
            + " name the function, or use the object form, components: { Header: … }",
    ],
    [{ routes, router: { mood: "good" } }, /^Router: "mood" is not an option/],
    [{ routes, live: { idleMS: 0 } }, /^sseClient: "idleMS" is not an option/],
    ...["true", 1, null, {}].map((devMode) => [{ routes, devMode }, "hydrate: devMode is true or false (left out, the page's #juris-dev turns it on)"]),
];

test("hydrate refuses each malformed option with a TypeError before the page is read", async () => {
    for (const [options, words] of refused) {
        await withPage({ page: fakePage({ state: home }) }, async ({ page }) => {
            await assert.rejects(hydrate(options), (error) => {
                assert.ok(error instanceof TypeError, `${String(error)} for ${JSON.stringify(options)}`);
                if (typeof words === "string") assert.equal(error.message, words);
                else assert.match(error.message, words);
                return true;
            }, `refused: ${JSON.stringify(options)}`);
            assert.deepEqual(page.document.reads, [], `the page was not read for ${JSON.stringify(options)}`);
            assert.equal(serialize(page.root), SERVER_MARKUP);
        });
    }
});

test("hydrate refuses a live that is a list, as the live client refuses one, before the page is read", async () => {
    await withPage({ page: fakePage({ state: home }) }, async ({ page }) => {
        await assert.rejects(hydrate({ routes, live: [], register: app({ p: "x" }) }), TypeError);
        assert.deepEqual(page.document.reads, []);
    });
});

test("hydrate takes every option it names, each in the shape it says", async () => {
    await withPage({ page: fakePage({ state: home }), extra: { __clientTestTakesAll: undefined } }, async ({ page }) => {
        const juris = await hydrate({
            routes,
            router: { scroll: false },
            register: app({ p: "drawn" }),
            services: [],
            apiBase: "/svc",
            fallback: () => "no words",
            live: { idleMs: 0 },
            plugins: [],
            beforeMount: () => { },
            title: { fallback: "Shop", suffix: "", max: Infinity, decorate: (text) => text },
            skewGuard: false,
            prefetch: false,
            serviceWorker: { url: "/sw.js", onMessage: () => { } },
            expose: "__clientTestTakesAll",
            stateId: "state",
            rootId: "app",
            root: Object.assign(Object.create(null), { App: {} }),
            juris: { allowTags: [], allowSchemes: [], allowInnerHTML: false, components: {} },
            devMode: false,
        });
        assert.ok(juris);
        assert.equal(serialize(page.root), '<div id="app"><p>drawn</p></div>');
        assert.equal(globalThis.__clientTestTakesAll, juris);
    });
});

// ---- reading the page --------------------------------------------------------------------------

test("hydrate boots the server's page: the state from #state, the root layout drawn into #app in place of the markup", async () => {
    const page = fakePage({ state: { ...home, greeting: "hello" } });
    await withPage({ page }, async () => {
        const juris = await hydrate({ routes, register: app((api) => ({ p: () => api.getState("greeting") })) });
        assert.equal(juris.isServer, false);
        assert.equal(juris.getState("greeting"), "hello");
        assert.equal(serialize(page.root), '<div id="app"><p>hello</p></div>');
        juris.setValue("greeting", "hi again");
        assert.equal(serialize(page.root), '<div id="app"><p>hi again</p></div>', "and it is live");
    });
});

test("hydrate draws a classList function as the server wrote it, and it follows the state from there", async () => {
    const register = (juris) => juris.registerComponent("App", (props, api) => ({
        nav: { className: "menu", classList: () => api.getState("menu") },
    }));
    const state = () => ({ ...home, menu: { open: true, wide: false } });
    const server = new Juris(withSSR({ isServer: true, state: state() }));
    register(server);
    const markup = server.renderToString({ App: {} });
    assert.equal(markup, '<nav class="menu open"></nav>');
    const page = fakePage({ state: state(), markup });
    await withPage({ page }, async () => {
        const juris = await hydrate({ routes, register });
        assert.equal(serialize(page.root), `<div id="app">${markup}</div>`, "the first frame is the server's");
        juris.setValue("menu", { wide: true });
        assert.equal(serialize(page.root), '<div id="app"><nav class="menu wide"></nav></div>');
    });
});

test("hydrate's first frame is the server's markup for class, className and classList, and stays it", async () => {
    const register = (juris) => juris.registerComponent("App", (props, api) => ({
        main: {
            children: [
                {
                    nav: {
                        className: () => api.getState("base"),
                        classList: { open: false, x: () => api.getState("x") },
                    },
                },
                { p: { classList: { "a b": true, b: false } } },
                { p: { classList: { "a b": true, b: true } } },
                { p: { classList: () => api.getState("menu"), class: "card" } },
                { p: { class: "unused", className: () => api.getState("base") } },
            ],
        },
    }));
    const state = (changes = {}) => ({
        ...home,
        base: "menu open",
        x: true,
        menu: { wide: true, card: false },
        ...changes,
    });
    const serverMarkup = (changes) => {
        const server = new Juris(withSSR({ isServer: true, state: state(changes) }));
        register(server);
        return server.renderToString({ App: {} });
    };
    const markup = serverMarkup();
    assert.equal(
        markup,
        '<main><nav class="menu x"></nav><p class="a"></p><p class="a b"></p><p class="wide"></p>'
            + '<p class="menu open"></p></main>',
    );
    const page = fakePage({ state: state(), markup });
    await withPage({ page }, async () => {
        const juris = await hydrate({ routes, register });
        assert.equal(serialize(page.root), `<div id="app">${markup}</div>`, "the first frame is the server's");
        juris.setValue("base", "bar open");
        assert.equal(serialize(page.root), `<div id="app">${serverMarkup({ base: "bar open" })}</div>`);
        juris.setValue("x", false);
        juris.setValue("base", "bar x");
        assert.equal(serialize(page.root), `<div id="app">${serverMarkup({ base: "bar x", x: false })}</div>`);
    });
});

test("hydrate reads the state and the service names only from the server's JSON scripts, never from content with the same ids (JR-F15)", async () => {
    const page = fakePage({
        state: { ...home, who: "the server" },
        services: ["save"],
        decoys: [
            ["div", { id: "state" }, '{"who":"a member\'s content"}'],
            ["script", { type: "text/plain", id: "state" }, '{"who":"a script of another type"}'],
            ["p", { id: "services" }, '["deleteEverything"]'],
            ["script", { type: "application/json", id: "other" }, '{"who":"another script"}'],
        ],
    });
    await withPage({ page }, async () => {
        const juris = await hydrate({ routes, register: app({ p: "x" }) });
        assert.equal(juris.getState("who"), "the server");
        assert.deepEqual(Object.keys(juris.services), ["save"]);
    });
});

test("hydrate takes the service names from #services when not given them, and none when the page has none", async () => {
    await withPage({ page: fakePage({ state: home, services: ["save", "load"] }) }, async () => {
        const juris = await hydrate({ routes, register: app({ p: "x" }) });
        assert.deepEqual(Object.keys(juris.services), ["save", "load"]);
    });
    await withPage({ page: fakePage({ state: home }) }, async () => {
        const juris = await hydrate({ routes, register: app({ p: "x" }) });
        assert.deepEqual(Object.keys(juris.services), []);
    });
});

test("hydrate given the service names does not read #services", async () => {
    await withPage({ page: fakePage({ state: home, services: ["fromThePage"] }) }, async () => {
        assert.deepEqual(Object.keys((await hydrate({ routes, services: ["given"], register: app({ p: "x" }) })).services), ["given"]);
        assert.deepEqual(Object.keys((await hydrate({ routes, services: [], register: app({ p: "x" }) })).services), []);
    });
});

test("hydrate reads the state from stateId and draws root into rootId", async () => {
    const page = fakePage({ state: { ...home, n: 3 }, stateId: "boot", rootId: "main" });
    await withPage({ page }, async () => {
        const juris = await hydrate({
            routes, stateId: "boot", rootId: "main", root: { Shell: {} },
            register: (j) => j.registerComponent("Shell", (props, api) => ({ main: () => `n=${api.getState("n")}` })),
        });
        assert.equal(juris.getState("n"), 3);
        assert.equal(serialize(page.root), '<div id="main"><main>n=3</main></div>');
    });
});

// A page with no state script to boot on (the page contract's #state) rejected with "Cannot read
// properties of null (reading 'textContent')", which named neither the script nor the id.
const noStateScript = (id) => `hydrate: the page has no <script type="application/json" id="${id}">,`
    + ' the state the server rendered it with ("The page contract");'
    + ` a <script id="${id}"> without that type is not read`;

test("hydrate on a page with no state script, or one without its type, rejects naming it, and draws nothing", async () => {
    const scriptOf = (page) => page.body.childNodes.find((node) => node.localName === "script");
    const withoutScript = (page) => page.body.removeChild(scriptOf(page));
    const untyped = (page) => scriptOf(page).removeAttribute("type");
    const cases = [
        ["no script", "state", withoutScript],
        ["a script without its type", "state", untyped],
        ["no script under stateId", "boot", withoutScript],
    ];
    for (const [label, stateId, spoil] of cases) {
        const page = fakePage({ state: home, stateId });
        spoil(page);
        let registered = 0;
        const register = () => {
            registered += 1;
        };
        await withPage({ page }, async () => {
            await assert.rejects(
                hydrate({ routes, stateId, register }),
                (error) => error.constructor === Error && error.message === noStateScript(stateId),
                label,
            );
        });
        assert.equal(serialize(page.root), SERVER_MARKUP, label);
        assert.equal(registered, 0, label);
    }
});

// ---- the instance ------------------------------------------------------------------------------

test("each service stub posts to <apiBase>/<name> with the global fetch, and a refusal with no words takes fallback's", async () => {
    const requests = [];
    const fetch = async (url, init) => {
        requests.push([url, JSON.parse(init.body)]);
        return url.endsWith("/fail")
            ? { ok: false, status: 500, statusText: "Internal Server Error", json: async () => ({}) }
            : { ok: true, status: 200, json: async () => ({ saved: true }) };
    };
    await withPage({ page: fakePage({ state: home, services: ["save", "fail"] }), fetch }, async () => {
        const juris = await hydrate({ routes, apiBase: "/svc", fallback: ({ name, response }) => `${name} failed (${response.status})`, register: app({ p: "x" }), live: false });
        assert.deepEqual(await juris.call("save", { a: 1 }), { saved: true });
        await assert.rejects(juris.call("fail"), (error) => error instanceof ServiceError && error.message === "fail failed (500)" && error.status === 500);
        assert.deepEqual(requests, [["/svc/save", [{ a: 1 }]], ["/svc/fail", []]]);
    });
});

test("hydrate gives the instance its own options, the ones the server's kernel is given", async () => {
    const page = fakePage({ state: home });
    await withPage({ page }, async () => {
        const juris = await hydrate({ routes, juris: { allowInnerHTML: true, allowTags: ["iframe"] }, register: app({ div: { innerHTML: "<b>trusted</b>" } }) });
        assert.equal(juris.allowInnerHTML, true);
        assert.ok(juris.allowTags.has("iframe"));
        assert.equal(serialize(page.root), '<div id="app"><div><b>trusted</b></div></div>');
    });
    await withPage({ page: fakePage({ state: home }) }, async () => {
        const juris = await hydrate({ routes, register: app({ p: "x" }) });
        assert.equal(juris.allowInnerHTML, false, "and nothing beyond the defaults unless given");
        assert.equal(juris.allowTags.size, 0);
    });
});

test("hydrate registers juris.components on the instance it builds, so the page draws them", async () => {
    function Cart(props, api) {
        return { p: () => `${api.getState("cart.count")} items` };
    }
    const App = () => ({ main: { children: [{ Cart: {} }] } });
    const page = fakePage({ state: { ...home, cart: { count: 2 } } });
    await withPage({ page }, async () => {
        const juris = await hydrate({ routes, juris: { components: [App, Cart] } });
        assert.equal(juris.componentManager.get("Cart"), Cart);
        assert.equal(serialize(page.root), '<div id="app"><main><p>2 items</p></main></div>');
    });
});

test("hydrate's juris.components are registered with the instance, before the plugins and register", async () => {
    const seen = [];
    const Header = () => ({ header: "Shop" });
    const plugin = (juris) => {
        seen.push(["plugin", juris.hasComponent("Header")]);
    };
    await withPage({ page: fakePage({ state: home }) }, async () => {
        await hydrate({
            routes,
            plugins: [plugin],
            juris: { components: { Header } },
            register: (juris) => {
                seen.push(["register", juris.hasComponent("Header")]);
                app({ p: "x" })(juris);
            },
        });
    });
    assert.deepEqual(seen, [["plugin", true], ["register", true]]);
});

test("a name hydrate's juris.components registers is refused to register as registerComponent refuses it", async () => {
    const Header = () => ({ header: "Shop" });
    await withPage({ page: fakePage({ state: home }) }, async () => {
        await assert.rejects(
            hydrate({
                routes,
                juris: { components: { Header } },
                register: (juris) => juris.registerComponent("Header", () => ({ header: "again" })),
            }),
            { name: "Error", message: 'ComponentManager.registerComponent: "Header" is already registered' },
        );
    });
});

test("hydrate installs the router, then the live client, then the app's plugins in order, then registers the components", async () => {
    const seen = [];
    const plugin = (name) => (juris) => {
        seen.push([name, "navigate" in juris.api, "liveStatus" in juris.api, Object.keys(juris.api).filter((key) => key.startsWith("from_"))]);
        return { [`from_${name}`]: () => name };
    };
    await withPage({ page: fakePage({ state: home }) }, async () => {
        const juris = await hydrate({
            routes,
            plugins: [plugin("a"), plugin("b")],
            register: (j) => { seen.push(["register", Object.keys(j.api).filter((key) => key.startsWith("from_"))]); app({ p: "x" })(j); },
        });
        assert.deepEqual(seen, [["a", true, true, []], ["b", true, true, ["from_a"]], ["register", ["from_a", "from_b"]]]);
        assert.equal(juris.api.from_b(), "b");
    });
});

test("hydrate's router is made from routes and the router's own options, and adopts the route the server rendered", async () => {
    const asked = [];
    const guard = (to, ctx) => { asked.push([to.path, ctx]); return to.path === "/about" ? "/" : undefined; };
    await withPage({ page: fakePage({ state: home }) }, async ({ window: win }) => {
        const juris = await hydrate({ routes, router: { guard, context: () => ({ viewer: "u1" }) }, register: app({ p: "x" }) });
        assert.equal(juris.getState("$route.name"), "home");
        assert.equal(win.location.pathname, "/");
        await juris.api.navigate("/about");
        assert.deepEqual(asked[0], ["/about", { viewer: "u1" }], "navigate asks the guard with context(api)");
        assert.equal(juris.getState("$route.path"), "/", "and goes where it says");
    });
});

test("hydrate installs the live client at apiBase, with the options it is given", async () => {
    const sources = eventSources();
    await withPage({ page: fakePage({ state: home }) }, async () => {
        const juris = await hydrate({ routes, apiBase: "/svc", live: { EventSourceImpl: sources.FakeEventSource, statePath: "$conn" }, register: app({ p: "x" }) });
        juris.live("rows", "rows");
        assert.equal(sources.last.url, "/svc/events");
        sources.last.hello("c1");
        assert.equal(juris.peek("$conn.connected"), true);
        assert.equal(juris.api.liveStatus(), true);
    });
});

test("hydrate's live client is the browser's EventSource at /api unless told", async () => {
    await withPage({ page: fakePage({ state: home }) }, async ({ sources }) => {
        const juris = await hydrate({ routes, register: app({ p: "x" }) });
        juris.live("rows", "rows");
        assert.equal(sources.last.url, "/api/events");
        assert.equal(juris.api.liveStatus(), false);
    });
});

test("hydrate's live client gives its stream back on pagehide, and takes it again on a pageshow from the cache", async () => {
    const win = fakeWindow("/");
    await withPage({ page: fakePage({ state: home }), window: win }, async ({ sources }) => {
        const juris = await hydrate({ routes, register: app({ p: "x" }) });
        juris.live("rows", "rows");
        const first = sources.last;
        first.hello("c1");
        win.dispatch("pagehide", { persisted: true });
        assert.equal(first.closed, true, "given back as the page is put away");
        assert.equal(juris.api.liveStatus(), false);
        assert.equal(juris.api.liveState("rows"), "offline");
        win.dispatch("pageshow", { persisted: true });
        assert.equal(sources.opened.length, 2, "a new stream once the page is shown from the cache");
        sources.last.hello("c2");
        assert.equal(juris.api.liveState("rows"), "pending");
    });
});

test("with live: false there is no live client, and api.live is a call", async () => {
    const requests = [];
    const fetch = async (url) => { requests.push(url); return { ok: true, status: 200, json: async () => ["by call"] }; };
    await withPage({ page: fakePage({ state: home, services: ["rows"] }), fetch }, async ({ sources }) => {
        const juris = await hydrate({ routes, live: false, register: app({ p: "x" }) });
        assert.equal("liveStatus" in juris.api, false);
        assert.equal(juris.liveTransport ?? null, null);
        juris.live("list", "rows");
        await flush();
        assert.deepEqual(requests, ["/api/rows"]);
        assert.deepEqual(juris.toRaw(juris.peek("list")), ["by call"]);
        assert.equal(sources.opened.length, 0);
    });
});

// ---- the order of the steps --------------------------------------------------------------------

test("hydrate runs its steps in order: plugins, register, the route's code, beforeMount, mount, the title", async () => {
    const log = [];
    await withPage({ page: fakePage({ state: home }) }, async () => {
        await hydrate({
            routes: [{ path: "/", name: "home", load: async () => { log.push("load"); } }],
            plugins: [() => { log.push("plugin"); }],
            register: (juris) => { log.push("register"); juris.registerComponent("App", () => { log.push("mount"); return { p: "x" }; }); },
            beforeMount: async () => { log.push("beforeMount"); },
            title: () => { log.push("title"); return "T"; },
        });
        assert.deepEqual(log, ["plugin", "register", "load", "beforeMount", "mount", "title"]);
    });
});

test("hydrate waits for the route's code, so a component it registers is drawn, not an unknown tag", async () => {
    const loaded = deferred();
    const page = fakePage({ state: home });
    await withPage({ page }, async () => {
        const booting = hydrate({
            routes: [{ path: "/", name: "home", load: async (juris) => { await loaded.promise; juris.registerComponent("Home", () => ({ h1: "Home" })); } }],
            register: app({ Home: {} }),
        });
        await flush();
        assert.equal(serialize(page.root), SERVER_MARKUP, "nothing drawn while the route's code loads");
        loaded.resolve();
        await booting;
        assert.equal(serialize(page.root), '<div id="app"><h1>Home</h1></div>');
    });
});

test("hydrate loads every matched record's code, the parent's and the child's", async () => {
    const loaded = [];
    const nested = [{ path: "/shop", name: "shop", load: async () => { loaded.push("shop"); }, children: [{ path: "item", name: "item", load: async () => { loaded.push("item"); } }] }];
    await withPage({ page: fakePage({ state: { $route: { path: "/shop/item", name: "item" } } }), address: "/shop/item" }, async () => {
        await hydrate({ routes: nested, register: app({ p: "x" }), prefetch: false });
        assert.deepEqual(loaded.sort(), ["item", "shop"]);
    });
});

test("a route whose code fails rejects the boot and leaves the server's page as it was, with nothing exposed", async () => {
    const failure = new Error("chunk failed to load");
    const page = fakePage({ state: home });
    let before = 0;
    await withPage({ page, extra: { __clientTestFailed: undefined } }, async () => {
        await assert.rejects(hydrate({
            routes: [{ path: "/", name: "home", load: async () => { throw failure; } }],
            register: app({ p: "x" }),
            beforeMount: () => { before += 1; },
            expose: "__clientTestFailed",
        }), (error) => error === failure);
        assert.equal(serialize(page.root), SERVER_MARKUP);
        assert.equal(globalThis.__clientTestFailed, undefined);
        assert.equal(before, 0);
    });
});

test("beforeMount is awaited when it returns a promise, and what it sets is read by the first render", async () => {
    const ready = deferred();
    const page = fakePage({ state: home });
    await withPage({ page }, async () => {
        const booting = hydrate({
            routes,
            register: app((api) => ({ p: () => api.getState("theme", "light") })),
            beforeMount: async (juris) => { await ready.promise; juris.setValue("theme", "dark"); },
        });
        await flush();
        assert.equal(serialize(page.root), SERVER_MARKUP);
        ready.resolve();
        await booting;
        assert.equal(serialize(page.root), '<div id="app"><p>dark</p></div>');
    });
});

test("beforeMount that answers no promise is not waited on", async () => {
    const page = fakePage({ state: home });
    await withPage({ page }, async () => {
        await hydrate({ routes, register: app((api) => ({ p: () => api.getState("theme") })), beforeMount: (juris) => { juris.setValue("theme", "sync"); return { then: "not a function" }; } });
        assert.equal(serialize(page.root), '<div id="app"><p>sync</p></div>');
    });
});

test("the first render answers from the preloaded calls, live from the start, and the mount releases them", async () => {
    const page = fakePage({ state: { ...home, $ssr: { calls: { [liveKey("rows", [])]: [1, 2] } } }, services: ["rows"] });
    await withPage({ page }, async () => {
        const juris = await hydrate({
            routes,
            register: app((api) => { api.live("list", "rows"); return { p: () => `${api.getState("list", []).length} ${api.liveState("list")}` }; }),
        });
        assert.equal(serialize(page.root), '<div id="app"><p>2 live</p></div>');
        assert.equal(juris.peek("$ssr"), undefined, "released after the first mount");
    });
});

// ---- the title ---------------------------------------------------------------------------------

test("without title the server's title stands", async () => {
    await withPage({ page: fakePage({ state: home }) }, async ({ page }) => {
        await hydrate({ routes, register: app({ p: "x" }) });
        assert.equal(page.document.title, "Server title");
    });
});

test("a title function answers the whole title, and is re-run when what it reads changes", async () => {
    await withPage({ page: fakePage({ state: { ...home, unread: 2 } }) }, async ({ page }) => {
        const juris = await hydrate({ routes, register: app({ p: "x" }), title: (j) => `Inbox (${j.getState("unread")})` });
        assert.equal(page.document.title, "Inbox (2)");
        juris.setValue("unread", 5);
        assert.equal(page.document.title, "Inbox (5)");
    });
});

test("a title that answers no string leaves the title as it is", async () => {
    await withPage({ page: fakePage({ state: { ...home, name: null } }) }, async ({ page }) => {
        const juris = await hydrate({ routes, register: app({ p: "x" }), title: (j) => j.getState("name") });
        assert.equal(page.document.title, "Server title");
        juris.setValue("name", "Named");
        assert.equal(page.document.title, "Named");
        juris.setValue("name", 42);
        assert.equal(page.document.title, "Named");
    });
});

test("title options name the page as the server did: titleFrom on the data at head.dataPath, cut to max, with the suffix", async () => {
    const things = [{ path: "/", name: "home", head: { title: "Home" } }, { path: "/things/:id", name: "thing", head: { title: "A thing", titleFrom: (data) => data.name, dataPath: "page.thing" } }];
    const state = { $route: { path: "/things/1", name: "thing" }, page: { thing: { name: "A very long lamp" } } };
    await withPage({ page: fakePage({ state }), address: "/things/1" }, async ({ page }) => {
        const juris = await hydrate({ routes: things, register: app({ p: "x" }), title: { suffix: " · Shop", max: 6 } });
        assert.equal(page.document.title, "A very · Shop");
        juris.setValue("page.thing.name", "Desk");
        assert.equal(page.document.title, "Desk · Shop", "re-run when the data changes");
        await juris.api.navigate("/");
        assert.equal(page.document.title, "Home", "and when the route does");
    });
});

test("title options fall back to the route's title, then to fallback, and decorate(text, juris) has the last word", async () => {
    const table = [{ path: "/", name: "home" }, { path: "/about", name: "about", head: { title: "About" } }];
    await withPage({ page: fakePage({ state: { $route: { path: "/about", name: "about" }, env: "staging" } }), address: "/about" }, async ({ page }) => {
        const juris = await hydrate({ routes: table, register: app({ p: "x" }), title: { fallback: "Shop", decorate: (text, j) => `[${j.getState("env")}] ${text}` } });
        assert.equal(page.document.title, "[staging] About");
        await juris.api.navigate("/");
        assert.equal(page.document.title, "[staging] Shop");
    });
});

// ---- what it answers ---------------------------------------------------------------------------

test("hydrate answers the live instance, and exposes it under a global name only when asked", async () => {
    await withPage({ page: fakePage({ state: home }), extra: { __clientTestApp: undefined } }, async () => {
        const juris = await hydrate({ routes, register: app({ p: "x" }), expose: "__clientTestApp" });
        assert.equal(globalThis.__clientTestApp, juris);
        assert.equal(typeof juris.mount, "function");
    });
    assert.equal(globalThis.__clientTestApp, undefined, "put back after the test");
});

// ---- devMode: #juris-dev, and the devtools feature --------------------------------------------

// The browser's console line for a devMode instance, kept off the test's output.
async function quietly(fn) {
    const info = console.info;
    console.info = () => { };
    try {
        return await fn();
    } finally {
        console.info = info;
    }
}

test("hydrate turns devMode on where the page carries #juris-dev, and gives the instance the devtools feature", async () => {
    const page = fakePage({ state: home, extraScripts: [["juris-dev", {}]] });
    const window = { ...fakeWindow("/"), dispatchEvent: () => true };
    await withPage({ page, window }, async () => {
        const juris = await quietly(() => hydrate({ routes, register: app({ p: "drawn" }) }));
        assert.equal(juris.devMode, true);
        assert.ok(juris.devtools instanceof Devtools);
        assert.equal(window.$juris[juris.devIndex], juris);
        const [entry] = window.__JURIS_DEVTOOLS__.list();
        assert.deepEqual(entry, { id: juris.devIndex, protocol: 1, juris: entry.juris, codeId: null, root: "app" });
        const endpoint = window.__JURIS_DEVTOOLS__.get(juris.devIndex);
        const connection = endpoint.connect();
        assert.deepEqual(endpoint.request(connection, "hello").result.dev, { render: null });
        assert.equal(endpoint.request(connection, "hello").result.mounted, true);
        endpoint.disconnect(connection);
        assert.equal(serialize(page.root), '<div id="app"><p>drawn</p></div>');
    });
});

test("hydrate({ devMode: false }) says no to #juris-dev, and devMode: true needs none", async () => {
    const refusing = fakePage({ state: home, extraScripts: [["juris-dev", {}]] });
    const window = fakeWindow("/");
    await withPage({ page: refusing, window }, async () => {
        const juris = await hydrate({ routes, register: app({ p: "x" }), devMode: false });
        assert.equal(juris.devMode, false);
        assert.equal(juris.devtools, undefined);
        assert.equal(window.$juris, undefined);
        assert.equal(window.__JURIS_DEVTOOLS__, undefined);
        assert.equal(refusing.document.reads.filter(([how]) => how === "querySelectorAll").length, 2, "the state and the service names: given, devMode is not looked up");
    });
    await withPage({ page: fakePage({ state: home }) }, async () => {
        const juris = await quietly(() => hydrate({ routes, register: app({ p: "x" }), devMode: true }));
        assert.equal(juris.devMode, true);
        assert.ok(juris.devtools instanceof Devtools);
    });
    const plain = fakePage({ state: home });
    await withPage({ page: plain }, async () => {
        const juris = await hydrate({ routes, register: app({ p: "x" }) });
        assert.equal(juris.devMode, false, "a page without #juris-dev");
        assert.equal(juris.devtools, undefined);
        assert.equal(plain.document.reads.filter(([how]) => how === "querySelectorAll").length, 3, "the state, the service names, and #juris-dev looked for");
    });
});

test("client.js's default export is hydrate", () => {
    assert.equal(hydrateDefault, hydrate);
});
