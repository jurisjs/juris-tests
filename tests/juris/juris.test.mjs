// juris.js, the instance itself (REFERENCE.md, "The Juris instance", "juris.js", "What the server
// and the browser are given alike"): its options and what it refuses at construction, the shared
// options check, features, devMode's window.$juris, the api, plugins (use, extendApi), registering
// once (registerComponent, hasComponent, install), unknown components, and the built-in Await.
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris, { BUILTIN_COMPONENTS, SHARED_OPTIONS, sharedOptions, FallbackSignal } from "juris/juris.js";
import { FallbackSignal as ErrorsFallbackSignal, defaultExposeError } from "juris/errors.js";
import { withGlobals, capture } from "../support/juris-harness.mjs";
import { withSSR, SSRRenderer } from "../support/ssr-renderer.mjs";

const server = (options = {}) => new Juris(withSSR({ isServer: true, ...options }));

// ---- construction and options ----------------------------------------------------------------------

test("an instance built with no options at all is a server instance (no document) with the defaults", () => {
    const juris = new Juris();
    assert.equal(juris.isServer, true);
    assert.equal(juris.devMode, false);
    assert.equal(juris.requirePreload, false);
    assert.equal(juris.ssrPath, "$ssr");
    assert.equal(juris.localPath, "$local");
    assert.equal(juris.unknownComponents, "element");
    assert.equal(juris.exposeError, defaultExposeError);
    assert.equal(juris.reportError, null);
    assert.equal(juris.allowInnerHTML, false);
    assert.deepEqual([...juris.allowTags], []);
    assert.deepEqual([...juris.allowSchemes], []);
    assert.deepEqual([...juris.privatePaths].sort(), ["$async", "$server"]);
});

test("isServer defaults to whether there is a document", async () => {
    await withGlobals({ document: {} }, () => {
        assert.equal(new Juris({}).isServer, false);
    });
    assert.equal(new Juris({}).isServer, true);
});

test("isServer given wins over the document's presence", async () => {
    await withGlobals({ document: {} }, () => {
        assert.equal(new Juris({ isServer: true }).isServer, true);
    });
    assert.equal(new Juris({ isServer: false }).isServer, false);
});

test("the initial state is the instance's state", () => {
    const juris = server({ state: { user: { name: "Ada" } } });
    assert.equal(juris.getState("user.name"), "Ada");
});

test("asyncPath must be a root name: a nested, empty or non-string one is refused", () => {
    for (const wrong of ["app.async", "", 5, null]) {
        assert.throws(() => server({ asyncPath: wrong }), (error) => error instanceof TypeError && error.message.includes(JSON.stringify(wrong)), `asyncPath ${JSON.stringify(wrong)}`);
    }
});

test("a renamed asyncPath is private, as $async is", () => {
    const juris = server({ asyncPath: "$jobs", state: { a: 1 } });
    juris.setValue("$jobs.pending", 1);
    assert.ok(juris.privatePaths.has("$jobs"));
    assert.deepEqual(JSON.parse(juris.serializeState()), { a: 1 });
});

test("privatePaths must be a list of root names", () => {
    assert.throws(() => server({ privatePaths: "user" }), { name: "TypeError", message: "Juris: privatePaths is a list of the state's root names" });
    for (const wrong of ["user.token", "", 3]) {
        assert.throws(() => server({ privatePaths: [wrong] }), (error) => error instanceof TypeError && error.message.includes(JSON.stringify(wrong)));
    }
});

test("privatePaths given are left out of the page's state, beside $async and $server", () => {
    const juris = server({ privatePaths: ["session"], state: { session: { token: "t" }, $server: { db: 1 }, open: 1 } });
    assert.deepEqual([...juris.privatePaths].sort(), ["$async", "$server", "session"]);
    assert.deepEqual(JSON.parse(juris.serializeState()), { open: 1 });
});

test("a server instance refuses a call cache", () => {
    assert.throws(() => server({ callCache: { dedupe: true } }), /callCache is for a browser instance/);
    assert.throws(() => server({ callCache: { ttl: 1000 } }), /callCache is for a browser instance/);
});

test("a server instance takes a call cache that caches nothing", () => {
    assert.deepEqual(server({ callCache: { dedupe: false, ttl: 0 } }).callCacheOptions, { dedupe: false, ttl: 0 });
});

test("a browser instance takes a call cache, the rest defaulted", () => {
    assert.deepEqual(new Juris({ isServer: false, callCache: { ttl: 50 } }).callCacheOptions, { dedupe: false, ttl: 50 });
});

test("unknownComponents is one of element, warn and throw", () => {
    for (const value of ["element", "warn", "throw"]) assert.equal(server({ unknownComponents: value }).unknownComponents, value);
    assert.throws(() => server({ unknownComponents: "ignore" }), { name: "TypeError", message: 'Juris: unknownComponents is one of "element", "warn", "throw"' });
});

test("exposeError and reportError are taken only when they are functions", () => {
    const expose = () => true;
    const report = () => { };
    const juris = server({ exposeError: expose, reportError: report });
    assert.equal(juris.exposeError, expose);
    assert.equal(juris.reportError, report);
    const defaults = server({ exposeError: true, reportError: "log" });
    assert.equal(defaults.exposeError, defaultExposeError);
    assert.equal(defaults.reportError, null);
});

test("allowTags and allowSchemes are checked and lower-cased once, at construction", () => {
    const juris = server({ allowTags: ["IFrame"], allowSchemes: ["Magnet"] });
    assert.deepEqual([...juris.allowTags], ["iframe"]);
    assert.deepEqual([...juris.allowSchemes], ["magnet"]);
    assert.throws(() => server({ allowTags: "iframe" }), TypeError);
    assert.throws(() => server({ allowSchemes: ["javascript"] }), TypeError);
});

test("allowInnerHTML is a boolean, false unless given; anything else is refused naming the value", () => {
    assert.equal(server().allowInnerHTML, false);
    assert.equal(server({ allowInnerHTML: true }).allowInnerHTML, true);
    assert.throws(() => server({ allowInnerHTML: "false" }), { name: "TypeError", message: 'Juris: allowInnerHTML is true or false, not "false"' });
    assert.throws(() => server({ allowInnerHTML: 1 }), { name: "TypeError", message: "Juris: allowInnerHTML is true or false, not 1" });
});

test("the services are a frozen copy of the ones given", () => {
    const given = { a: () => 1 };
    const juris = server({ services: given });
    given.b = () => 2;
    assert.deepEqual(Object.keys(juris.services), ["a"]);
    assert.ok(Object.isFrozen(juris.services));
});

test("onChange given is told of a write", () => {
    const changes = [];
    const juris = server({ onChange: (path) => changes.push(path) });
    juris.setValue("a.b", 1);
    assert.ok(changes.includes("a.b"));
});

// ---- the api ------------------------------------------------------------------------------------------

test("the api is frozen, carries services and isServer, and its methods act on the instance", () => {
    const services = { ping: () => "pong" };
    const juris = server({ services });
    const { api } = juris;
    assert.ok(Object.isFrozen(api));
    assert.equal(api.isServer, true);
    assert.equal(api.services, juris.services);
    api.setValue("count", 1);
    api.updateState("count", (n) => n + 1);
    assert.equal(juris.getState("count"), 2);
    assert.equal(api.getState("count"), 2);
    assert.equal(api.batch(() => "done"), "done");
    api.deleteState("count");
    assert.equal(api.peek("count"), undefined);
    assert.equal(api.renderToString({ p: "x" }), "<p>x</p>");
});

test("the api names every method the reference lists for a component", () => {
    const names = "getState toRaw setValue updateState deleteState peek compute batch clearState bindState render mount renderToString enhance unenhance registerComponent disposeTree onCleanup onMount onError useState ref prop call preloaded invalidate group assign live liveState liveMessage markRender".split(" ");
    const { api } = server();
    for (const name of names) assert.equal(typeof api[name], "function", name);
});

// ---- sharedOptions --------------------------------------------------------------------------------------

test("SHARED_OPTIONS names allowTags, allowSchemes, allowInnerHTML and components, frozen", () => {
    assert.deepEqual(SHARED_OPTIONS, ["allowTags", "allowSchemes", "allowInnerHTML", "components"]);
    assert.ok(Object.isFrozen(SHARED_OPTIONS));
});

test("sharedOptions of nothing is nothing", () => {
    assert.deepEqual(sharedOptions(undefined, "hydrate"), {});
});

test("sharedOptions answers the given options, as given, leaving out the undefined ones", () => {
    const allowSchemes = ["magnet"];
    const out = sharedOptions({ allowTags: undefined, allowSchemes, allowInnerHTML: false }, "createJurisServer");
    assert.deepEqual(out, { allowSchemes: ["magnet"], allowInnerHTML: false });
    assert.equal(out.allowSchemes, allowSchemes);
});

test("sharedOptions takes an object with no prototype", () => {
    const value = Object.assign(Object.create(null), { allowTags: ["iframe"] });
    assert.deepEqual(sharedOptions(value, "hydrate"), { allowTags: ["iframe"] });
});

test("sharedOptions refuses anything but a plain object, naming where", () => {
    class Options { }
    for (const wrong of [null, "x", 1, [], new Date(), new Options()]) {
        assert.throws(
            () => sharedOptions(wrong, "hydrate"),
            (error) => error instanceof TypeError
                && error.message === "hydrate: juris is the instance's options, a plain object"
                    + " ({ allowTags, allowSchemes, allowInnerHTML, components })",
            String(wrong),
        );
    }
});

test("sharedOptions refuses an option the instance is not given through it, naming where", () => {
    assert.throws(() => sharedOptions({ isServer: true }, "createJurisServer"), {
        name: "TypeError",
        message: "createJurisServer: juris.isServer is not an option (allowTags, allowSchemes, allowInnerHTML, components)",
    });
});

test("sharedOptions checks each value as the constructor would", () => {
    assert.throws(() => sharedOptions({ allowTags: "iframe" }, "hydrate"), TypeError);
    assert.throws(() => sharedOptions({ allowSchemes: ["data"] }, "hydrate"), TypeError);
    assert.throws(() => sharedOptions({ allowInnerHTML: "yes" }, "hydrate"), { name: "TypeError", message: 'hydrate: allowInnerHTML is true or false, not "yes"' });
});

test("sharedOptions answers the components as given, the same object", () => {
    const components = { Header: () => ({ header: "Shop" }) };
    const out = sharedOptions({ components }, "hydrate");
    assert.deepEqual(Object.keys(out), ["components"]);
    assert.equal(out.components, components);
});

test("sharedOptions checks the components as the constructor would, naming where", () => {
    assert.throws(() => sharedOptions({ components: "Header" }, "hydrate"), {
        name: "TypeError",
        message: "hydrate: juris.components is an object of components by name ({ Header, Footer }),"
            + " or a list of named functions ([Header, Footer])",
    });
    assert.throws(() => sharedOptions({ components: [() => null] }, "createJurisServer"), {
        name: "TypeError",
        message: "createJurisServer: juris.components[0] is a function with no name, and a list registers each by its"
            + " function's name: name the function, or use the object form, components: { Header: … }",
    });
});

test("the components sharedOptions answers register alike on a server instance and a browser one", async () => {
    function Price(props) {
        return { span: { class: "price", textContent: `${props.amount} €` } };
    }
    const options = sharedOptions({ components: [Price] }, "test");
    const html = server(options).renderToString({ Price: { amount: 3 } });
    assert.equal(html, '<span class="price">3 €</span>');
    await withGlobals({ document: {} }, () => {
        const browser = new Juris(options);
        assert.equal(browser.isServer, false);
        assert.equal(browser.componentManager.get("Price"), Price);
    });
});

test("what sharedOptions answers builds an instance that draws alike", () => {
    const options = sharedOptions({ allowSchemes: ["magnet"] }, "test");
    const html = server(options).renderToString({ a: { href: "magnet:?xt=urn:btih:abc", textContent: "get" } });
    assert.match(html, /href="magnet:\?xt=urn:btih:abc"/);
    assert.doesNotMatch(server().renderToString({ a: { href: "magnet:?xt=urn:btih:abc", textContent: "get" } }), /href/);
});

// ---- features -------------------------------------------------------------------------------------------

test("a feature is constructed with the instance, whole, and the config", () => {
    const seen = [];
    class Feature {
        constructor(juris, config) {
            seen.push({ api: typeof juris.api.getState, await: juris.hasComponent("Await"), config });
            juris.registerComponent("Extra", () => ({ p: "extra" }));
        }
    }
    const config = withSSR({ isServer: true, features: { extra: Feature } });
    const juris = new Juris(config);
    assert.deepEqual(seen, [{ api: "function", await: true, config }]);
    assert.equal(juris.renderToString({ Extra: {} }), "<p>extra</p>");
});

test("a feature that is not a class is refused, naming it", () => {
    assert.throws(() => server({ features: { headless: {} } }), { name: "TypeError", message: "Juris: features.headless is a class, constructed with (juris, config)" });
});

// ---- the string renderer: the kit's feature -----------------------------------------------------------
// juris.js has no string renderer of its own: the kit's (server/ssr-renderer.js) is given as
// `features: { ssr: SSRRenderer }`. An instance without it keeps the api, and says what is missing.

const refusedWithout = (method) => ({
    name: "TypeError",
    message: `Juris.${method}: rendering to a string is the kit's: features: { ssr: SSRRenderer }, from juris-kit/server/ssr-renderer.js`,
});

test("without features.ssr, renderToString and api.renderToString throw a TypeError that names the fix, on a server or in a browser", () => {
    for (const juris of [new Juris({ isServer: true }), new Juris({ isServer: false })]) {
        assert.equal(juris.ssrRenderer, null);
        assert.equal(typeof juris.api.renderToString, "function", "the api keeps the name");
        assert.throws(() => juris.renderToString({ p: "x" }), refusedWithout("renderToString"));
        assert.throws(() => juris.api.renderToString({ p: "x" }), refusedWithout("renderToString"));
    }
});

test("without features.ssr, renderRequest rejects with that TypeError before it preloads anything", async () => {
    const asked = [];
    const juris = new Juris({ isServer: true, services: { rows: async (...args) => { asked.push(args); return []; } } });
    await assert.rejects(juris.renderRequest({ preload: [["rows", 1]], layout: { p: "x" } }), refusedWithout("renderRequest"));
    await assert.rejects(juris.renderRequest({}), refusedWithout("renderRequest"), "the missing renderer is said before a missing layout");
    assert.deepEqual(asked, [], "no service was called");
});

test("without features.ssr, markRender does nothing and renderTrace() is null, whatever the trace hooks are given", () => {
    const juris = new Juris({ isServer: true, services: { rows: (n) => [n] } });
    assert.equal(juris.renderTrace(), null);
    assert.doesNotThrow(() => juris.markRender("clock"));
    assert.doesNotThrow(() => juris.api.markRender("random"));
    // The calls, reads and tags a traced render records, made with no renderer to record them.
    juris.clearState({ $ssr: { calls: { [juris.callKey("rows", [1])]: [1] } } });
    assert.deepEqual(juris.call("rows", 1).value, [1], "a preloaded call");
    assert.deepEqual(juris.call("rows", 2).value, [2], "a call nobody preloaded, answered at once (a settled value)");
    assert.deepEqual(juris.preloaded("rows", 1), [1]);
    juris.live("list", "rows", 3);
    assert.deepEqual(juris.toRaw(juris.getState("list")), [3]);
    assert.doesNotThrow(() => juris.unknownComponent("Missing"));
    assert.equal(juris.renderTrace(), null);
});

test("with features.ssr the same instance draws: the kit's renderer installs itself as ssrRenderer", () => {
    const juris = new Juris(withSSR({ isServer: true }));
    assert.equal(juris.ssrRenderer instanceof SSRRenderer, true);
    assert.equal(juris.renderToString({ p: "x" }, null, { trace: true }), "<p>x</p>");
    juris.markRender("clock");
    assert.deepEqual(juris.renderTrace().flags, []);
    // On an instance already made, as the other features may be given.
    const later = new Juris({ isServer: true });
    const renderer = new SSRRenderer(later);
    assert.equal(later.ssrRenderer, renderer);
    assert.equal(later.renderToString({ b: "y" }), "<b>y</b>");
});

// ---- devMode and window.$juris ---------------------------------------------------------------------------

test("devMode in a browser exposes the instance as window.$juris[n] and says so", async () => {
    const window = {};
    await withGlobals({ window }, async () => {
        const said = await capture("info", () => {
            const first = new Juris({ isServer: false, devMode: true });
            const second = new Juris({ isServer: false, devMode: true });
            assert.equal(window.$juris[first.devIndex], first);
            assert.equal(window.$juris[second.devIndex], second);
            assert.equal(second.devIndex, first.devIndex + 1);
        });
        assert.equal(said.length, 2);
        assert.match(said[0][0], /devMode is on, so this instance is exposed as window\.\$juris\[\d+\]; turn devMode off for production/);
    });
});

test("devMode keeps whatever window.$juris already holds", async () => {
    const window = { $juris: { keep: "me" } };
    await withGlobals({ window }, async () => {
        await capture("info", () => {
            const juris = new Juris({ isServer: false, devMode: true });
            assert.equal(window.$juris.keep, "me");
            assert.equal(window.$juris[juris.devIndex], juris);
        });
    });
});

test("without devMode, or without a window, nothing goes on window", async () => {
    const window = {};
    await withGlobals({ window }, () => {
        new Juris({ isServer: false });
        assert.equal(window.$juris, undefined);
    });
    await withGlobals({ window: null }, async () => {
        const said = await capture("info", () => {
            assert.equal(new Juris({ isServer: false, devMode: true }).devIndex, undefined);
        });
        assert.deepEqual(said, []);
    });
});

test("devMode skips a window.$juris index another copy of the core took, so neither puts its instance over the other's", async () => {
    const window = {};
    await withGlobals({ window }, async () => {
        await capture("info", () => {
            const first = new Juris({ isServer: false, devMode: true });
            window.$juris[first.devIndex + 1] = "another copy's instance";
            window.$juris[first.devIndex + 2] = "another copy's instance";
            const second = new Juris({ isServer: false, devMode: true });
            assert.equal(second.devIndex, first.devIndex + 3);
            assert.equal(window.$juris[first.devIndex + 1], "another copy's instance");
            assert.equal(window.$juris[second.devIndex], second);
        });
    });
});

test("refused(rule, reason, detail) writes the console line both renderers wrote for a refusal", async () => {
    const juris = new Juris({ isServer: true });
    const said = await capture("warn", () => {
        juris.refused(undefined, "<iframe> is not allowed in a layout", { name: "iframe" });
        juris.refused(null, "<style>: its text contains </style, which would end the element");
        juris.refused("layout-in-value", 'a layout was returned for "title", which only accepts text-like values', { name: "title", value: { b: "x" } });
    });
    assert.deepEqual(said, [
        ["Juris: dropped <iframe> is not allowed in a layout"],
        ["Juris: dropped <style>: its text contains </style, which would end the element"],
        ['Juris: a layout was returned for "title", which only accepts text-like values; ignored', { b: "x" }],
    ]);
});

test("a server instance in devMode is never put on window, even where one exists", async () => {
    const window = {};
    await withGlobals({ window }, async () => {
        await capture("info", () => {
            const juris = new Juris({ isServer: true, devMode: true });
            assert.equal(juris.devIndex, undefined);
            assert.equal(window.$juris, undefined);
        });
    });
});

// ---- plugins: use and extendApi --------------------------------------------------------------------------

test("a function plugin is called with the instance and options, and what it returns joins the api", () => {
    const juris = server();
    const seen = [];
    const returned = juris.use((instance, options) => {
        seen.push([instance, options]);
        return { greet: (name) => `hi ${name}` };
    }, { loud: true });
    assert.equal(returned, juris, "use() chains");
    assert.deepEqual(seen, [[juris, { loud: true }]]);
    assert.equal(juris.api.greet("Ada"), "hi Ada");
    assert.ok(Object.isFrozen(juris.api));
});

test("an object plugin's install is called as its method", () => {
    const juris = server();
    const plugin = {
        word: "hello",
        install(instance) { return { say: () => this.word }; },
    };
    juris.use(plugin);
    assert.equal(juris.api.say(), "hello");
});

test("a component drawn after use() is handed the extended api", () => {
    const juris = server();
    juris.registerComponent("Hello", (props, api) => ({ p: api.greeting() }));
    juris.use(() => ({ greeting: () => "hello" }));
    assert.equal(juris.renderToString({ Hello: {} }), "<p>hello</p>");
});

test("a plugin that returns nothing, or something that is not an object, leaves the api as it was", () => {
    const juris = server();
    const before = juris.api;
    juris.use(() => undefined);
    juris.use(() => "not an extension");
    juris.use({ install: () => null });
    assert.equal(juris.api, before);
});

test("a plugin must be a function or have an install method", () => {
    const juris = server();
    for (const wrong of [null, undefined, {}, { install: null }, 3]) {
        assert.throws(() => juris.use(wrong), { message: "Juris.use: plugin must be a function or have an install(juris) method" });
    }
});

test("a plugin whose install is not a function is refused with the same words", () => {
    const juris = server();
    for (const wrong of [{ install: "x" }, { install: 3 }]) {
        assert.throws(() => juris.use(wrong), { message: "Juris.use: plugin must be a function or have an install(juris) method" });
    }
});

test("the api takes each name once: an extension naming an existing one is refused whole", () => {
    const juris = server();
    const before = juris.api;
    assert.throws(() => juris.extendApi({ fresh: () => 1, getState: () => 2 }), { message: 'Juris.extendApi: the api already has "getState"' });
    assert.equal(juris.api, before);
    assert.equal("fresh" in juris.api, false);
    juris.extendApi({ fresh: () => 1 });
    assert.throws(() => juris.extendApi({ fresh: () => 3 }), /already has "fresh"/);
    assert.throws(() => juris.extendApi({ services: {} }), /already has "services"/);
});

// ---- registering: registerComponent, hasComponent, BUILTIN_COMPONENTS --------------------------------------

test("every built-in component is registered on a new instance, and nothing else is", () => {
    const juris = server();
    assert.deepEqual(BUILTIN_COMPONENTS, ["Await"]);
    assert.ok(Object.isFrozen(BUILTIN_COMPONENTS));
    for (const name of BUILTIN_COMPONENTS) assert.equal(juris.hasComponent(name), true, name);
    assert.deepEqual(juris.componentManager.names(), [...BUILTIN_COMPONENTS]);
});

test("hasComponent says whether a name is registered", () => {
    const juris = server();
    assert.equal(juris.hasComponent("Card"), false);
    juris.registerComponent("Card", () => ({ p: "card" }));
    assert.equal(juris.hasComponent("Card"), true);
});

test("a name is registered once per instance; a second instance registers it anew", () => {
    const juris = server();
    juris.registerComponent("Card", () => ({ p: "a" }));
    assert.throws(() => juris.registerComponent("Card", () => ({ p: "b" })), /already registered/);
    assert.throws(() => juris.registerComponent("Await", () => ({ p: "b" })), /already registered/);
    assert.doesNotThrow(() => server().registerComponent("Card", () => ({ p: "b" })));
});

test("a component registered through the api is drawn", () => {
    const juris = server();
    juris.api.registerComponent("Hi", () => ({ b: "hi" }));
    assert.equal(juris.renderToString({ Hi: {} }), "<b>hi</b>");
});

test("a component registered ssr: false is a placeholder on the server", () => {
    const juris = server();
    juris.registerComponent("Map", () => ({ canvas: {} }), { ssr: false });
    assert.equal(juris.renderToString({ div: { children: [{ Map: {} }] } }), "<div><!--juris:client Map--></div>");
});

// ---- the components option ---------------------------------------------------------------------------------

const Header = () => ({ header: "Shop" });
const Footer = () => ({ footer: "© 2026" });
function CartView(props) {
    return { p: `${props.count} items` };
}

test("components as an object registers each definition under its key, in order, after the built-ins", () => {
    const juris = server({ components: { Header, Footer, Cart: CartView } });
    assert.deepEqual(juris.componentManager.names(), [...BUILTIN_COMPONENTS, "Header", "Footer", "Cart"]);
    assert.equal(juris.componentManager.get("Cart"), CartView);
    assert.equal(juris.renderToString({ Cart: { count: 2 } }), "<p>2 items</p>");
});

test("components as an object takes any name registerComponent takes, and an object with no prototype", () => {
    const given = Object.assign(Object.create(null), { "Cart": CartView, "order-summary": Footer });
    const juris = server({ components: given });
    assert.equal(juris.hasComponent("Cart"), true);
    assert.equal(juris.hasComponent("order-summary"), true);
});

test("components as a list registers each function under its own name, in order", () => {
    const juris = server({ components: [Header, Footer, CartView] });
    assert.deepEqual(juris.componentManager.names(), [...BUILTIN_COMPONENTS, "Header", "Footer", "CartView"]);
    assert.equal(juris.componentManager.get("Header"), Header);
    assert.equal(juris.renderToString({ Header: {} }), "<header>Shop</header>");
    for (const components of [undefined, {}, []]) {
        assert.deepEqual(server({ components }).componentManager.names(), [...BUILTIN_COMPONENTS], String(components));
    }
});

test("components registered are registered as registerComponent registers them: ssr true, drawn by both renderers", () => {
    const juris = server({ components: [Header] });
    assert.deepEqual(juris.componentManager.getOptions("Header"), { ssr: true });
});

test("components are registered before the features are built", () => {
    const seen = [];
    class Inspector {
        constructor(juris) {
            seen.push(juris.hasComponent("Header"));
        }
    }
    server({ components: [Header], features: { inspector: Inspector } });
    assert.deepEqual(seen, [true]);
});

test("components refuses a value that is neither an object of components nor a list, before anything is built", () => {
    class Registry { }
    const wrong = [null, "Header", 1, true, Header, new Map([["Header", Header]]), new Registry()];
    for (const components of wrong) {
        assert.throws(
            () => new Juris({ components }),
            (error) => error instanceof TypeError
                && error.message === "Juris: components is an object of components by name ({ Header, Footer }),"
                    + " or a list of named functions ([Header, Footer])",
            String(components),
        );
    }
});

test("components as a list refuses an anonymous function, saying to use the object form", () => {
    const anonymous = [() => ({ p: "?" })];
    assert.equal(anonymous[0].name, "");
    assert.throws(() => new Juris({ components: [Header, anonymous[0]] }), {
        name: "TypeError",
        message: "Juris: components[1] is a function with no name, and a list registers each by its function's name:"
            + " name the function, or use the object form, components: { Header: … }",
    });
});

test("components as a list refuses a function whose name is not a component's, naming it", () => {
    const named = (name) => Object.defineProperty(() => null, "name", { value: name });
    const lower = function header() {
        return null;
    };
    const cases = [
        [lower, "header"],
        [Header.bind(null), "bound Header"],
        [named("default"), "default"],
        [named("Order Summary"), "Order Summary"],
        [named("1Header"), "1Header"],
    ];
    for (const [definition, name] of cases) {
        assert.throws(
            () => new Juris({ components: [definition] }),
            (error) => error instanceof TypeError
                && error.message === `Juris: components[0] is a function named "${name}", which is no component's name`
                    + " (a capitalised name, such as Header): name the function, or use the object form,"
                    + " components: { Header: … }",
            name,
        );
    }
});

test("components as a list refuses what is not a function, naming its place", () => {
    const cases = [
        ["Header", '"Header"'],
        [null, "null"],
        [{ Header }, "an object"],
        [[Header], "a list"],
        [undefined, "undefined"],
    ];
    for (const [entry, shown] of cases) {
        assert.throws(
            () => new Juris({ components: [Header, entry] }),
            (error) => error instanceof TypeError
                && error.message === `Juris: components[1] is ${shown}, not a component: a list holds named functions`
                    + " ([Header, Footer])",
            shown,
        );
    }
});

test("components refuses a name already registered as registerComponent refuses it", () => {
    assert.throws(() => new Juris({ components: [Header, Header] }), {
        name: "Error",
        message: 'ComponentManager.registerComponent: "Header" is already registered',
    });
    assert.throws(() => new Juris({ components: { Await: Header } }), {
        name: "Error",
        message: 'ComponentManager.registerComponent: "Await" is already registered',
    });
});

test("components as an object refuses a definition that is not a function as registerComponent refuses it", () => {
    assert.throws(() => new Juris({ components: { Header, Footer: { footer: "© 2026" } } }), {
        name: "Error",
        message: 'ComponentManager.registerComponent: definition for "Footer" must be a function',
    });
});

test("a component the components option registered refuses a second registerComponent of its name", () => {
    const juris = server({ components: { Header } });
    assert.throws(() => juris.registerComponent("Header", Footer), /"Header" is already registered/);
});

test("a refused components exposes nothing on window in devMode", async () => {
    const window = {};
    await withGlobals({ window, document: {} }, async () => {
        await capture("info", () => {
            assert.throws(() => new Juris({ devMode: true, components: [() => null] }), TypeError);
        });
    });
    assert.equal(window.$juris, undefined);
});

// ---- install ---------------------------------------------------------------------------------------------

test("install runs the registrar the first time a key is given, and answers whether it ran", () => {
    const juris = server();
    const ran = [];
    const registrar = (instance) => {
        ran.push(instance);
        instance.registerComponent("Card", () => ({ p: "card" }));
    };
    assert.equal(juris.install("cards", registrar), true);
    assert.equal(juris.install("cards", registrar), false);
    assert.equal(juris.install("cards", () => ran.push("another function, same key")), false);
    assert.deepEqual(ran, [juris]);
    assert.equal(juris.hasComponent("Card"), true);
});

test("the once is the instance's: another instance runs the same key again", () => {
    let runs = 0;
    const registrar = () => { runs += 1; };
    server().install("cards", registrar);
    server().install("cards", registrar);
    assert.equal(runs, 2);
});

test("install's key is a non-empty string and its registrar a function", () => {
    const juris = server();
    for (const key of ["", undefined, 1, () => { }]) {
        assert.throws(() => juris.install(key, () => { }), { name: "TypeError", message: "Juris.install: key must be a non-empty string, the name the module registers under" });
    }
    assert.throws(() => juris.install("cards", null), { name: "TypeError", message: 'Juris.install: registrar for "cards" must be a function (juris) => void' });
    assert.equal(juris.install("cards", () => { }), true, "a refused call marked nothing as installed");
});

test("a registrar may install others, and one that reaches its own key while running is not run again", () => {
    const juris = server();
    const order = [];
    const answers = [];
    juris.install("outer", (instance) => {
        order.push("outer");
        answers.push(instance.install("inner", () => order.push("inner")));
        answers.push(instance.install("outer", () => order.push("outer again")));
    });
    assert.deepEqual(order, ["outer", "inner"]);
    assert.deepEqual(answers, [true, false]);
});

test("a registrar that throws is remembered, and its error thrown to every later caller for that key", () => {
    const juris = server();
    const failure = new Error("half registered");
    let runs = 0;
    assert.throws(() => juris.install("cards", () => { runs += 1; throw failure; }), (error) => error === failure);
    assert.throws(() => juris.install("cards", () => { runs += 1; }), (error) => error === failure);
    assert.throws(() => juris.install("cards", () => { runs += 1; }), (error) => error === failure);
    assert.equal(runs, 1);
});

// ---- unknown components -----------------------------------------------------------------------------------

test("by default an unknown capitalised tag is drawn as an element, silently, and named in the trace", async () => {
    const juris = server();
    const said = await capture("warn", () => {
        assert.equal(juris.renderToString({ Widget: { id: "w" } }, null, { trace: true }), '<Widget id="w"></Widget>');
    });
    assert.deepEqual(said, []);
    assert.deepEqual(juris.renderTrace().unknown, ["Widget"]);
});

test("\"warn\" says so on the console, once per name", async () => {
    const juris = server({ unknownComponents: "warn" });
    const said = await capture("warn", () => {
        juris.renderToString({ div: { children: [{ Widget: {} }, { Widget: {} }, { Gadget: {} }] } });
        juris.renderToString({ Widget: {} });
    });
    assert.deepEqual(said.map((args) => args[0]), [
        'Juris: "Widget" is not a registered component; rendering it as an HTML element',
        'Juris: "Gadget" is not a registered component; rendering it as an HTML element',
    ]);
});

test("devMode says so on the console too", async () => {
    const juris = server({ devMode: true });
    const said = await capture("warn", () => juris.renderToString({ Widget: {} }));
    assert.deepEqual(said.map((args) => args[0]), ['Juris: "Widget" is not a registered component; rendering it as an HTML element']);
});

test("a capitalised tag no layout may draw is unknown too, still not drawn, and its warning says nothing is drawn", async () => {
    const juris = server({ unknownComponents: "warn" });
    let html;
    const said = await capture("warn", () => { html = juris.renderToString({ div: { children: [{ Script: {} }] } }, null, { trace: true }); });
    assert.equal(html, "<div></div>");
    assert.deepEqual(juris.renderTrace().unknown, ["Script"]);
    assert.deepEqual(said.map((args) => args[0]), ['Juris: "Script" is not a registered component, nor a tag a layout may draw; nothing is drawn for it']);
});

test("\"throw\" refuses to draw an unknown component, and the trace still names it", () => {
    const juris = server({ unknownComponents: "throw" });
    assert.throws(() => juris.renderToString({ Widget: {} }, null, { trace: true }), { message: 'Juris: "Widget" is not a registered component (unknownComponents: "throw")' });
    assert.deepEqual(juris.renderTrace().unknown, ["Widget"]);
});

test("\"throw\" is an error like any other: a boundary may catch it", () => {
    const juris = server({ unknownComponents: "throw" });
    const caught = [];
    juris.registerComponent("Safe", (props, api) => {
        api.onError((error, info) => {
            caught.push([error.message, info.phase]);
            return { p: "fallback" };
        });
        return { div: { children: [{ Widget: {} }] } };
    });
    assert.equal(juris.renderToString({ Safe: {} }, null, { trace: true }), "<p>fallback</p>");
    assert.deepEqual(caught, [['Juris: "Widget" is not a registered component (unknownComponents: "throw")', "setup"]]);
    assert.deepEqual(juris.renderTrace().unknown, ["Widget"]);
});

test("inside <svg> or <math> a capitalised tag is an element of that namespace, never unknown", async () => {
    for (const mode of ["element", "warn", "throw"]) {
        const juris = server({ unknownComponents: mode, devMode: true });
        const said = await capture("warn", () => {
            juris.renderToString({ svg: { children: [{ linearGradient: {} }, { Path: {} }] } }, null, { trace: true });
            assert.deepEqual(juris.renderTrace().unknown, [], mode);
            juris.renderToString({ math: { children: [{ Mrow: {} }] } }, null, { trace: true });
            assert.deepEqual(juris.renderTrace().unknown, [], mode);
        });
        assert.deepEqual(said, [], mode);
    }
});

test("a lower-case tag is never an unknown component", () => {
    const juris = server({ unknownComponents: "throw" });
    assert.equal(juris.renderToString({ widget: {} }, null, { trace: true }), "<widget></widget>");
    assert.deepEqual(juris.renderTrace().unknown, []);
});

// ---- Await -------------------------------------------------------------------------------------------------

test("Await draws its children in a div while its group is not pending", () => {
    const juris = server();
    const html = juris.renderToString({ Await: { group: "panel", fallback: { p: "Loading" }, children: [{ p: "Ready" }] } });
    assert.equal(html, "<div><div><p>Ready</p></div></div>");
});

test("Await draws its fallback while its group is pending, and hides its children behind it", () => {
    const juris = server();
    juris.setValue("$async.groups.panel.pending", 1);
    const html = juris.renderToString({ Await: { group: "panel", fallback: { p: "Loading" }, children: [{ p: "Ready" }] } });
    assert.equal(html, '<div><p>Loading</p><div hidden=""><p>Ready</p></div></div>');
});

test("Await with no fallback draws nothing in its place while pending", () => {
    const juris = server();
    juris.setValue("$async.groups.panel.pending", 2);
    assert.equal(juris.renderToString({ Await: { group: "panel", children: [{ p: "Ready" }] } }), '<div><div hidden=""><p>Ready</p></div></div>');
});

test("Await's onError function is handed the group's errors, raw, and its layout replaces the children", () => {
    const juris = server();
    juris.setValue("$async.groups.panel.errors", [{ message: "down", at: 1 }]);
    const handed = [];
    const html = juris.renderToString({
        Await: {
            group: "panel",
            onError: (errors) => { handed.push(errors); return { p: `Failed: ${errors[0].message}` }; },
            children: [{ p: "Ready" }],
        },
    });
    assert.equal(html, '<div><p>Failed: down</p><div hidden=""><p>Ready</p></div></div>');
    assert.deepEqual(handed, [[{ message: "down", at: 1 }]]);
    assert.equal(handed[0], juris.toRaw(handed[0]), "the errors are not a tracking proxy");
});

test("Await's onError may be a layout", () => {
    const juris = server();
    juris.setValue("$async.groups.panel.errors", [{ message: "down", at: 1 }]);
    const html = juris.renderToString({ Await: { group: "panel", onError: { p: "Failed" }, children: [{ p: "Ready" }] } });
    assert.equal(html, '<div><p>Failed</p><div hidden=""><p>Ready</p></div></div>');
});

test("Await without onError keeps its children shown when the group has errors", () => {
    const juris = server();
    juris.setValue("$async.groups.panel.errors", [{ message: "down", at: 1 }]);
    assert.equal(juris.renderToString({ Await: { group: "panel", children: [{ p: "Ready" }] } }), "<div><div><p>Ready</p></div></div>");
});

test("Await draws in the tag it is given and passes its other props to the outer element", () => {
    const juris = server();
    const html = juris.renderToString({ Await: { group: "panel", tag: "section", className: "box", id: "p", children: [{ p: "Ready" }] } });
    assert.equal(html, '<section class="box" id="p"><section><p>Ready</p></section></section>');
});

test("Await follows a tracked group: fallback while its promise is pending, children once it settles", async () => {
    const juris = new Juris(withSSR({ isServer: false }));
    const layout = { Await: { group: "panel", fallback: { p: "Loading" }, children: [{ p: "Ready" }] } };
    let resolve;
    const done = juris.api.group("panel").track(new Promise((r) => { resolve = r; }));
    assert.match(juris.renderToString(layout), /Loading/);
    resolve("ok");
    assert.equal(await done, "ok");
    assert.doesNotMatch(juris.renderToString(layout), /Loading/);
});

// ---- FallbackSignal re-export ----------------------------------------------------------------------------

test("juris.js re-exports errors.js's FallbackSignal", () => {
    assert.equal(FallbackSignal, ErrorsFallbackSignal);
});
