// serviceDispatcher's construction: which options it takes (a misspelt one is refused), which names it
// answers to (`names`, `expose`, the two reserved for the live layer), the checks on `live`'s numbers,
// `strictQueries` and `retryMs`, the rule that live queries need `authorize` or `public: true`,
// `forms`' own checks, `strict` (every service says what it changes), and `close`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { serviceDispatcher, ALL } from "juris-kit/server/service-dispatcher.js";
import { EVERYTHING } from "juris-kit/server/page-cache.js";

const MAX_DELAY = 2 ** 31 - 1;
const make = (services, options) => {
    const handler = serviceDispatcher(services, "/api", options);
    handler.close();
    return handler;
};
const services = { q: () => 1, m: () => 2 };

// ---- the options themselves ------------------------------------------------------------------------

test("options that are not an object are refused with a TypeError", () => {
    for (const bad of [null, [], "live", 5, () => { }]) {
        assert.throws(() => serviceDispatcher(services, "/api", bad), { name: "TypeError", message: "serviceDispatcher: options is an object" }, String(bad));
    }
});

test("no options at all builds a dispatcher with no live layer", () => {
    const handler = serviceDispatcher(services);
    assert.deepEqual(handler.names, ["q", "m"]);
    assert.equal(handler.stats().bus, null);
    handler.close();
});

test("a top-level key that is not an option is refused, naming it and the options there are", () => {
    assert.throws(() => make(services, { exposeErrors: () => true }), (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /^serviceDispatcher: "exposeErrors" is not an option \(/);
        for (const known of ["live", "maxBody", "context", "expose", "strict", "forms", "exposeError", "onError"]) assert.ok(error.message.includes(known), known);
        return true;
    });
});

test("a misspelt key inside live, strict or forms is refused, naming the object it is in", () => {
    assert.throws(() => make(services, { live: { queries: ["q"], public: true, strictQuerys: true } }),
        { name: "TypeError", message: /^serviceDispatcher: live\.strictQuerys is not an option \(queries, touches, .*strictQueries, retryMs\)$/ });
    assert.throws(() => make(services, { strict: { name: ["q"] } }),
        { name: "TypeError", message: "serviceDispatcher: strict.name is not an option (names, flushAll, warn)" });
    assert.throws(() => make(services, { forms: { allows: ["q"], redirect: () => "/" } }),
        { name: "TypeError", message: "serviceDispatcher: forms.allows is not an option (allow, maxBody, redirect)" });
});

test("live, strict or forms given as anything but an object is refused", () => {
    assert.throws(() => make(services, { live: true }), { name: "TypeError", message: /^serviceDispatcher: live is an object of options \(queries, / });
    assert.throws(() => make(services, { strict: ["q"] }), { name: "TypeError", message: "serviceDispatcher: strict is an object of options (names, flushAll, warn)" });
    assert.throws(() => make(services, { forms: () => "/" }), { name: "TypeError", message: "serviceDispatcher: forms is an object of options (allow, maxBody, redirect)" });
});

test("live, strict and forms given as null or undefined are not given", () => {
    const handler = make(services, { live: null, strict: undefined, forms: null });
    assert.deepEqual(handler.names, ["q", "m"]);
    assert.equal(handler.stats().bus, null);
});

// ---- the names it answers to ---------------------------------------------------------------------

test("names are the own functions of services, in the order they were found, frozen", () => {
    const proto = { inherited() { return 0; } };
    const given = Object.assign(Object.create(proto), { b: () => 1, notAFunction: 7, a: () => 2, text: "x" });
    const handler = make(given);
    assert.deepEqual(handler.names, ["b", "a"]);
    assert.ok(Object.isFrozen(handler.names));
});

test("a function attached to services after construction is no endpoint", async () => {
    const given = { a: () => 1 };
    const handler = serviceDispatcher(given, "/api");
    given.late = () => "late";
    assert.deepEqual(handler.names, ["a"]);
    assert.deepEqual(await handler.invoke("late", []), { ok: false, status: 404, error: 'unknown service "late"' });
    handler.close();
});

test("expose names the services answered to, in its own order, and nothing else is callable", async () => {
    const handler = serviceDispatcher({ a: () => "a", b: () => "b", helper: () => "secret" }, "/api", { expose: ["b", "a"] });
    assert.deepEqual(handler.names, ["b", "a"]);
    assert.deepEqual(await handler.invoke("b", []), { ok: true, result: "b" });
    assert.equal((await handler.invoke("helper", [])).status, 404);
    handler.close();
});

test("expose naming what is not a function on services is refused, listing every such name", () => {
    assert.throws(() => make({ a: () => 1, data: 5 }, { expose: ["a", "data", "missing"] }),
        { message: "serviceDispatcher: expose names nothing on services: data, missing" });
});

test("a service named events or _live is refused, whether or not live queries are on", () => {
    assert.throws(() => make({ events: () => 1, a: () => 2 }),
        { message: 'serviceDispatcher: "events" is reserved for the live layer\'s endpoints (/api/events, /api/_live), with or without live queries: rename the service' });
    assert.throws(() => serviceDispatcher({ _live: () => 1, events: () => 2 }, "/rpc"),
        { message: 'serviceDispatcher: "events" and "_live" are reserved for the live layer\'s endpoints (/rpc/events, /rpc/_live), with or without live queries: rename the service' });
    assert.throws(() => make({ _live: () => 1, q: () => 1 }, { live: { queries: ["q"], public: true } }), /"_live" is reserved/);
    assert.throws(() => make({ events: () => 1, a: () => 1 }, { expose: ["events"] }), /"events" is reserved/);
});

test("a reserved name on services that is not exposed is no endpoint, and so no conflict", () => {
    const handler = make({ events: () => 1, a: () => 2 }, { expose: ["a"] });
    assert.deepEqual(handler.names, ["a"]);
});

// ---- live queries need a decision about who may have them ----------------------------------------

test("live queries without authorize or public: true are refused at construction", () => {
    const message = "serviceDispatcher: live queries need live.authorize(name, args, info), or live.public: true if every one of them is for everybody";
    assert.throws(() => make(services, { live: { queries: ["q"] } }), { message });
    assert.throws(() => make(services, { live: { queries: ["q"], public: false } }), { message });
    // A name an array-valued touches entry lists is a live query by default too.
    assert.throws(() => make(services, { live: { touches: { m: ["q"] } } }), { message });
    assert.throws(() => make(services, { live: { touches: { m: [{ name: "q", args: [1] }] } } }), { message });
    make(services, { live: { queries: ["q"], public: true } });
    make(services, { live: { queries: ["q"], authorize: () => true } });
});

test("touches that name no query (ALL, a function, a target with no name) need no authorize", () => {
    make(services, { live: { touches: { m: [ALL] } } });
    make(services, { live: { touches: { m: ALL } } });
    make(services, { live: { touches: { m: () => ["q"] } } });
    make(services, { live: { touches: { m: [{ args: [1] }, { name: 7 }] } } });
    make(services, { live: { touches: { m: [] } } });
});

test("with strictQueries, a touches target is an invalidation name only, so it needs no authorize", () => {
    make(services, { live: { strictQueries: true, touches: { m: ["q", { name: "q", where: { id: 1 } }] } } });
    assert.throws(() => make(services, { live: { strictQueries: false, touches: { m: ["q"] } } }), /need live\.authorize/);
});

test("strictQueries that is not a boolean is refused, naming the value", () => {
    assert.throws(() => make(services, { live: { strictQueries: "true", public: true } }),
        { name: "TypeError", message: 'serviceDispatcher: live.strictQueries is true or false, not "true"' });
    assert.throws(() => make(services, { live: { strictQueries: 1, public: true } }),
        { name: "TypeError", message: "serviceDispatcher: live.strictQueries is true or false, not 1" });
    assert.throws(() => make(services, { live: { strictQueries: null, public: true } }),
        { name: "TypeError", message: "serviceDispatcher: live.strictQueries is true or false, not null" });
    const fn = () => true;
    assert.throws(() => make(services, { live: { strictQueries: fn, public: true } }),
        { name: "TypeError", message: `serviceDispatcher: live.strictQueries is true or false, not ${String(fn)}` });
});

// ---- live's numbers ---------------------------------------------------------------------------------

const withLive = (extra) => make(services, { live: { queries: ["q"], public: true, ...extra } });

test("keepAlive and graceMs are whole numbers of milliseconds a timer can wait", () => {
    assert.throws(() => withLive({ keepAlive: 0 }),
        { name: "TypeError", message: `serviceDispatcher: live.keepAlive is a whole number of milliseconds from 1 to ${MAX_DELAY}, not 0` });
    assert.throws(() => withLive({ keepAlive: "1000" }),
        { name: "TypeError", message: `serviceDispatcher: live.keepAlive is a whole number of milliseconds from 1 to ${MAX_DELAY}, not "1000"` });
    assert.throws(() => withLive({ keepAlive: MAX_DELAY + 1 }), { name: "TypeError", message: /live\.keepAlive .* not 2147483648$/ });
    assert.throws(() => withLive({ keepAlive: Infinity }), { name: "TypeError", message: /live\.keepAlive .* not Infinity$/ });
    assert.throws(() => withLive({ graceMs: -1 }),
        { name: "TypeError", message: `serviceDispatcher: live.graceMs is a whole number of milliseconds from 0 to ${MAX_DELAY}, not -1` });
    assert.throws(() => withLive({ graceMs: 2 ** 31 }), { name: "TypeError", message: /live\.graceMs/ });
    withLive({ keepAlive: 1, graceMs: 0 });
    withLive({ keepAlive: MAX_DELAY, graceMs: MAX_DELAY });
});

test("the ceilings from 1 are whole numbers from 1, or Infinity", () => {
    for (const key of ["maxKeysPerClient", "maxGroups", "maxBufferBytes"]) {
        assert.throws(() => withLive({ [key]: 0 }),
            { name: "TypeError", message: `serviceDispatcher: live.${key} is a whole number from 1, or Infinity, not 0` }, key);
        assert.throws(() => withLive({ [key]: "5" }),
            { name: "TypeError", message: `serviceDispatcher: live.${key} is a whole number from 1, or Infinity, not "5"` }, key);
        assert.throws(() => withLive({ [key]: 2.5 }), TypeError, key);
        withLive({ [key]: 1 });
        withLive({ [key]: Infinity });
    }
});

test("the per-caller ceilings are whole numbers from 0 (no ceiling), or Infinity", () => {
    for (const key of ["maxStreamsPerCaller", "maxGroupsPerCaller", "maxPostsPerMinute"]) {
        assert.throws(() => withLive({ [key]: -1 }),
            { name: "TypeError", message: `serviceDispatcher: live.${key} is a whole number from 0, or Infinity, not -1` }, key);
        assert.throws(() => withLive({ [key]: NaN }), TypeError, key);
        assert.throws(() => withLive({ [key]: "256" }), TypeError, key);
        withLive({ [key]: 0 });
        withLive({ [key]: Infinity });
    }
});

test("recheckMs is a whole number from 0, with no Infinity", () => {
    assert.throws(() => withLive({ recheckMs: 1.5 }),
        { name: "TypeError", message: "serviceDispatcher: live.recheckMs is a whole number from 0, not 1.5" });
    assert.throws(() => withLive({ recheckMs: Infinity }), { name: "TypeError", message: /live\.recheckMs .* not Infinity$/ });
    withLive({ recheckMs: 0 });
    withLive({ recheckMs: 10 * MAX_DELAY });
});

test("a live number given as null means its default", () => {
    withLive({ keepAlive: null, graceMs: null, maxGroups: null, maxKeysPerClient: null, maxBufferBytes: null,
        maxStreamsPerCaller: null, maxGroupsPerCaller: null, maxPostsPerMinute: null, recheckMs: null });
});

test("retryMs is a whole number of milliseconds from 1 that a timer can wait", () => {
    for (const bad of [0, -1, 1.5, MAX_DELAY + 1, NaN, Infinity]) {
        assert.throws(() => withLive({ retryMs: bad }),
            { name: "TypeError", message: `serviceDispatcher: live.retryMs is a whole number of milliseconds from 1 to ${MAX_DELAY}, not ${String(bad)}` }, String(bad));
    }
    assert.throws(() => withLive({ retryMs: "2000" }),
        { name: "TypeError", message: `serviceDispatcher: live.retryMs is a whole number of milliseconds from 1 to ${MAX_DELAY}, not "2000"` });
    withLive({ retryMs: 1 });
    withLive({ retryMs: MAX_DELAY });
});

// ---- forms' own checks ----------------------------------------------------------------------------

test("forms without a redirect function is refused", () => {
    assert.throws(() => make(services, { forms: { allow: ["m"] } }),
        { name: "TypeError", message: "serviceDispatcher: forms.redirect(name, { ok, message, … }) must say where a form's answer sends the browser" });
    assert.throws(() => make(services, { forms: { allow: ["m"], redirect: "/done" } }), TypeError);
});

test("forms.allow naming what is not a service is refused, listing every such name", () => {
    assert.throws(() => make(services, { forms: { allow: ["m", "nope", "gone"], redirect: () => "/" } }),
        { name: "TypeError", message: "serviceDispatcher: forms.allow names what is not a service: nope, gone" });
});

test("forms.maxBody is a whole number of bytes from 0", () => {
    for (const bad of [-1, 1.5, "16"]) {
        assert.throws(() => make(services, { forms: { allow: ["m"], maxBody: bad, redirect: () => "/" } }),
            { name: "TypeError", message: `serviceDispatcher: forms.maxBody must be a number of bytes, not ${String(bad)}` }, String(bad));
    }
    make(services, { forms: { allow: ["m"], maxBody: 0, redirect: () => "/" } });
    make(services, { forms: { redirect: () => "/" } });
});

// ---- strict ------------------------------------------------------------------------------------------

test("strict builds when every service says what it changes", () => {
    const warned = [];
    const handler = make({ q: () => 1, m: () => 2, n: () => 3, admin: () => 4 }, {
        live: { queries: ["q"], public: true, touches: { m: ["q", { name: "q", args: [1] }], n: [] } },
        strict: { names: ["q", "m", "n", "admin"], flushAll: ["admin"], warn: (...args) => warned.push(args) },
    });
    assert.deepEqual(handler.names, ["q", "m", "n", "admin"]);
    assert.deepEqual(warned, [], "every declared query is named by a touches list");
});

test("strict refuses names that differ from the services either way, listing both", () => {
    assert.throws(() => make({ a: () => 1, b: () => 2 }, { strict: { names: ["a", "c"], flushAll: ["a", "b"] } }), (error) => {
        assert.equal(error.message, [
            "serviceDispatcher: strict:",
            "  strict.names names services that do not exist: c",
            "  these services are not in strict.names, so a browser given that list cannot call them: b",
        ].join("\n"));
        return true;
    });
});

test("strict without names does not compare names", () => {
    make({ a: () => 1 }, { strict: { flushAll: ["a"] } });
});

test("strict refuses live.queries, touches keys and targets, and flushAll naming what is no service", () => {
    assert.throws(() => make({ q: () => 1, m: () => 2 }, {
        live: { queries: ["q", "ghost"], public: true, touches: { m: ["q", "phantom", { name: "spectre" }, ALL, EVERYTHING], wraith: [], fn: () => ["x"] } },
        strict: { flushAll: ["m", "nobody"] },
    }), (error) => {
        const lines = error.message.split("\n").slice(1).map((line) => line.trim());
        assert.deepEqual(lines, [
            'live.queries names "ghost", which is not a service',
            'live.touches["m"] names "phantom", which is not a service',
            'live.touches["m"] names "spectre", which is not a service',
            'live.touches names "wraith", which is not a service',
            'live.touches names "fn", which is not a service',
            'strict.flushAll names "nobody", which is not a service',
        ]);
        return true;
    });
});

test("strict refuses a service that is no query, no touches entry and no flushAll member", () => {
    assert.throws(() => make({ q: () => 1, m: () => 2, quiet: () => 3, loud: () => 4 }, {
        live: { queries: ["q"], public: true, touches: { m: ["q"] } },
        strict: {},
    }), { message: "serviceDispatcher: strict:\n  these services do not say what they change (a live query, a live.touches entry, [] for nothing, or strict.flushAll): quiet, loud" });
});

test("strict with no live classifies services by flushAll alone", () => {
    make({ a: () => 1 }, { strict: { flushAll: ["a"] } });
    assert.throws(() => make({ a: () => 1, b: () => 2 }, { strict: { flushAll: ["a"] } }), /do not say what they change .*: b$/);
});

test("strict.warn is told once of the declared queries no touches list names, a function entry's included", () => {
    const warned = [];
    make({ q: () => 1, r: () => 2, s: () => 3, m: () => 4, f: () => 5 }, {
        live: { queries: ["q", "r", "s"], public: true, touches: { m: [{ name: "q", where: { a: 1 } }], f: () => ["r"] } },
        strict: { warn: (message, names) => warned.push({ message, names }) },
    });
    assert.deepEqual(warned, [{
        message: "live queries no live.touches list names, so a subscriber sees only the value it subscribed to: r, s",
        names: ["r", "s"],
    }]);
});

test("strict.warn is not asked when problems refuse construction", () => {
    const warned = [];
    assert.throws(() => make({ q: () => 1, odd: () => 2 }, { live: { queries: ["q"], public: true }, strict: { warn: () => warned.push(1) } }));
    assert.deepEqual(warned, []);
});

// ---- ALL, and close -------------------------------------------------------------------------------

test("ALL is the page cache's every-page target, frozen", () => {
    assert.deepEqual(ALL, { name: "$pages" });
    assert.equal(ALL.name, EVERYTHING);
    assert.ok(Object.isFrozen(ALL));
});

test("close unsubscribes from the bus once, and a bus with no unsubscribe or no subscribe is fine", () => {
    let unsubscribed = 0;
    const subscribed = [];
    const handler = serviceDispatcher(services, "/api", {
        live: { queries: ["q"], public: true, bus: { publish: () => { }, subscribe: (fn) => { subscribed.push(fn); return () => { unsubscribed += 1; }; } } },
    });
    assert.equal(subscribed.length, 1);
    assert.equal(typeof subscribed[0], "function");
    handler.close();
    handler.close();
    assert.equal(unsubscribed, 1);
    serviceDispatcher(services, "/api", { live: { queries: ["q"], public: true, bus: { publish: () => { }, subscribe: () => "not a function" } } }).close();
    const publishOnly = serviceDispatcher(services, "/api", { live: { queries: ["q"], public: true, bus: { publish: () => { } } } });
    assert.deepEqual(publishOnly.stats().bus, { published: 0, received: 0, unpublishable: 0, errors: 0 });
    publishOnly.close();
});

test("stats start at zero", () => {
    const handler = serviceDispatcher(services, "/api", { live: { queries: ["q"], public: true } });
    assert.deepEqual(handler.stats(), { clients: 0, groups: 0, subscriptions: 0, connected: 0, droppedForLag: 0, bus: null });
    handler.close();
});
