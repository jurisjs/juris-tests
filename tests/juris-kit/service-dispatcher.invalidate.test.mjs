// serviceDispatcher's invalidations: which groups a target re-runs ("name", { name }, { name, args },
// { name, where: {...} }, { name, where: fn }), live.onInvalidate (told first, of everything, failures
// reported), the bus (what is published, what arrives, and their failures), ALL, and a re-run that
// cannot even report its failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { serviceDispatcher, ALL } from "juris-kit/server/service-dispatcher.js";
import { flush, deferred, driver } from "../support/service-dispatcher-harness.mjs";

// A dispatcher with one live query `q` that records each run's arguments, and a stream subscribed to
// every argument list given. `runs` is cleared once the subscriptions' own first runs are done.
async function withGroups(argLists, options, run, { services = {} } = {}) {
    const runs = [];
    const { live: liveOptions = {}, ...rest } = options;
    const handler = serviceDispatcher({ q: (...args) => { runs.push(args); return runs.length; }, other: () => 0, ...services }, "/api", {
        ...rest,
        live: { queries: ["q", "other"], public: true, ...liveOptions },
    });
    try {
        const d = driver(handler);
        const stream = await d.open();
        for (const args of argLists) assert.equal((await d.subscribe(stream.id, "q", args)).status, 200, JSON.stringify(args));
        await d.subscribe(stream.id, "other");
        runs.length = 0;
        await run({ handler, runs, stream, d });
    } finally {
        handler.close();
    }
}
const sorted = (runs) => runs.map((args) => JSON.stringify(args)).sort();

// ---- what a target re-runs --------------------------------------------------------------------------

test("a name, or { name }, re-runs every group of that query and no other query's", async () => {
    await withGroups([[1], [2], []], {}, async ({ handler, runs }) => {
        await handler.invalidate("q");
        assert.deepEqual(sorted(runs), ["[1]", "[2]", "[]"]);
        runs.length = 0;
        await handler.invalidate([{ name: "q" }]);
        assert.equal(runs.length, 3);
    });
});

test("{ name, args } matches position by position, compared as strings, and ignores arguments past its end", async () => {
    await withGroups([[7], ["7"], [8], [7, "x"], [7, "y"], []], {}, async ({ handler, runs }) => {
        await handler.invalidate({ name: "q", args: [7] });
        assert.deepEqual(sorted(runs), ['["7"]', "[7,\"x\"]", "[7,\"y\"]", "[7]"]);
        runs.length = 0;
        await handler.invalidate({ name: "q", args: [7, "y"] });
        assert.deepEqual(sorted(runs), ['[7,"y"]']);
        runs.length = 0;
        await handler.invalidate({ name: "q", args: [] });
        assert.equal(runs.length, 6, "args: [] is every group of that name");
    });
});

test("an undefined slot in { name, args } matches any argument there", async () => {
    await withGroups([[1, "a"], [2, "a"], [3, "b"]], {}, async ({ handler, runs }) => {
        await handler.invalidate({ name: "q", args: [undefined, "a"] });
        assert.deepEqual(sorted(runs), ['[1,"a"]', '[2,"a"]']);
    });
});

test("{ name, where: { … } } matches the groups whose first argument is an object with those fields, as strings", async () => {
    await withGroups([[{ room: 7, page: 1 }], [{ room: "7" }], [{ room: 8 }], [7], [null], ["room"], []], {}, async ({ handler, runs }) => {
        await handler.invalidate({ name: "q", where: { room: 7 } });
        assert.deepEqual(sorted(runs), ['[{"room":"7"}]', '[{"room":7,"page":1}]']);
        runs.length = 0;
        await handler.invalidate({ name: "q", where: { room: 7, page: 1 } });
        assert.deepEqual(sorted(runs), ['[{"room":7,"page":1}]']);
    });
});

test("{ name, where: fn } re-runs the groups the function accepts, given each group's whole argument list", async () => {
    const seen = [];
    await withGroups([[1, 2], [3, 4], [5]], {}, async ({ handler, runs }) => {
        await handler.invalidate({ name: "q", where: (args) => { seen.push(args); return args.length === 2 ? args[0] > 1 : 0; } });
        assert.deepEqual(sorted(runs), ["[3,4]"]);
    });
    assert.deepEqual(sorted(seen), ["[1,2]", "[3,4]", "[5]"]);
});

test("{ name, where: null } is every group of that name", async () => {
    await withGroups([[1], [2]], {}, async ({ handler, runs }) => {
        await handler.invalidate({ name: "q", where: null });
        assert.equal(runs.length, 2);
    });
});

test("a target that is null, or names a query nobody watches, re-runs nothing", async () => {
    await withGroups([[1]], {}, async ({ handler, runs }) => {
        await handler.invalidate([null, "nobody", { name: "nobody", args: [1] }, { args: [1] }]);
        await handler.invalidate([]);
        assert.deepEqual(runs, []);
    });
});

test("a mutation's object targets re-run only the groups they name: a message in chat 7 re-runs chat 7", async () => {
    await withGroups([[{ chat: 7 }], [{ chat: 8 }]], { live: { touches: { send: (message) => [{ name: "q", where: { chat: message.chat } }] } } }, async ({ handler, runs }) => {
        assert.deepEqual(await handler.invoke("send", [{ chat: 7, text: "hi" }]), { ok: true, result: "sent" });
        await flush();
        assert.deepEqual(sorted(runs), ['[{"chat":7}]']);
    }, { services: { send: () => "sent" } });
});

test("ALL re-runs no live query", async () => {
    await withGroups([[1]], {}, async ({ handler, runs }) => {
        await handler.invalidate(ALL);
        assert.deepEqual(runs, []);
    });
});

// ---- onInvalidate ---------------------------------------------------------------------------------------

test("onInvalidate is told of every invalidation before anything is awaited, function targets included", async () => {
    const told = [];
    const where = () => true;
    await withGroups([[1]], { live: { onInvalidate: (targets, info) => told.push({ targets, info }) } }, async ({ handler }) => {
        const pending = handler.invalidate(["q", { name: "q", where }]);
        assert.equal(told.length, 1, "told before invalidate returned");
        assert.deepEqual(told[0], { targets: ["q", { name: "q", where }], info: { remote: false } });
        await pending;
        handler.invalidate(ALL);
        assert.deepEqual(told[1].targets, [ALL], "one target is told as a list of one");
        await handler.invalidate([]);
        assert.equal(told.length, 2, "an empty list tells nothing");
    });
});

test("an onInvalidate that throws or rejects goes to onError as live.onInvalidate and stops nothing", async () => {
    const errors = [];
    const thrown = new Error("cache gone");
    const rejected = new Error("cache slow");
    let mode = "throw";
    await withGroups([[1]], {
        live: { onInvalidate: () => { if (mode === "throw") throw thrown; return Promise.reject(rejected); } },
        onError: (error, where, targets) => errors.push([error, where, targets]),
    }, async ({ handler, runs }) => {
        await handler.invalidate("q");
        assert.equal(runs.length, 1, "the re-run happened");
        mode = "reject";
        await handler.invalidate(["q"]);
        await flush();
        assert.equal(runs.length, 2);
    });
    assert.deepEqual(errors, [[thrown, "live.onInvalidate", ["q"]], [rejected, "live.onInvalidate", ["q"]]]);
});

test("an onInvalidate that fails is fine without onError", async () => {
    await withGroups([[1]], { live: { onInvalidate: () => { throw new Error("no"); } } }, async ({ handler, runs }) => {
        await handler.invalidate("q");
        assert.equal(runs.length, 1);
    });
});

// ---- the bus: publishing ------------------------------------------------------------------------------------

test("every local invalidation's data targets are published; a function target stays local and is counted", async () => {
    const published = [];
    const where = () => true;
    await withGroups([[1]], { live: { bus: { publish: (targets) => { published.push(targets); }, subscribe: () => { } } } }, async ({ handler, runs }) => {
        await handler.invalidate(["q", { name: "q", args: [1] }, { name: "q", where: { a: 1 } }, { name: "q", where }, null, ALL]);
        assert.deepEqual(published, [["q", { name: "q", args: [1] }, { name: "q", where: { a: 1 } }, ALL]]);
        assert.deepEqual(handler.stats().bus, { published: 4, received: 0, unpublishable: 2, errors: 0 });
        assert.equal(runs.length, 1, "re-run here too, once");
        await handler.invalidate({ name: "q", where });
        assert.equal(published.length, 1, "nothing to publish, so no publish");
        assert.deepEqual(handler.stats().bus, { published: 4, received: 0, unpublishable: 3, errors: 0 });
    });
});

test("ALL crosses the bus as { name: \"$pages\" }", async () => {
    const wire = [];
    await withGroups([], { live: { bus: { publish: (targets) => wire.push(JSON.stringify(targets)), subscribe: () => { } } } }, async ({ handler }) => {
        await handler.invalidate(ALL);
        assert.deepEqual(wire, ['[{"name":"$pages"}]']);
    });
});

test("a publish that throws or rejects is counted, told to onError as live.bus.publish, and the re-runs still happen", async () => {
    const errors = [];
    const thrown = new Error("pool closed");
    const rejected = new Error("pool timeout");
    let mode = "throw";
    await withGroups([[1]], {
        live: { bus: { publish: () => { if (mode === "throw") throw thrown; return Promise.reject(rejected); }, subscribe: () => { } } },
        onError: (error, where, wire) => errors.push([error, where, wire]),
    }, async ({ handler, runs }) => {
        await handler.invalidate("q");
        mode = "reject";
        await handler.invalidate([{ name: "q", args: [1] }]);
        assert.equal(runs.length, 2);
        assert.deepEqual(handler.stats().bus, { published: 2, received: 0, unpublishable: 0, errors: 2 });
    });
    assert.deepEqual(errors, [[thrown, "live.bus.publish", ["q"]], [rejected, "live.bus.publish", [{ name: "q", args: [1] }]]]);
});

test("a publish that fails with no onError is still counted", async () => {
    await withGroups([[1]], { live: { bus: { publish: () => { throw new Error("no"); } } } }, async ({ handler }) => {
        await handler.invalidate("q");
        assert.equal(handler.stats().bus.errors, 1);
    });
});

test("handler.invalidate resolves once both the publish and the local re-runs are done, the re-runs not waiting for the publish", async () => {
    const publish = deferred();
    await withGroups([[1]], { live: { bus: { publish: () => publish.promise, subscribe: () => { } } } }, async ({ handler, runs }) => {
        let settled = false;
        const pending = handler.invalidate("q").then(() => { settled = true; });
        await flush();
        assert.equal(runs.length, 1, "the re-run did not wait for the publish");
        assert.equal(settled, false, "invalidate waits for the publish");
        publish.resolve();
        await pending;
        assert.equal(settled, true);
    });
});

// ---- the bus: what arrives -----------------------------------------------------------------------------------

test("what arrives off the bus re-runs groups here without being published again, and onInvalidate hears it as remote", async () => {
    let deliver;
    const published = [];
    const told = [];
    await withGroups([[1], [2]], {
        live: { bus: { publish: (targets) => published.push(targets), subscribe: (fn) => { deliver = fn; } }, onInvalidate: (targets, info) => told.push({ targets, info }) },
    }, async ({ handler, runs }) => {
        assert.equal(deliver([{ name: "q", args: [2] }]), undefined, "the bus is answered at once");
        await flush();
        assert.deepEqual(sorted(runs), ["[2]"]);
        deliver("q");
        await flush();
        assert.equal(runs.length, 3, "one target needs no list");
        assert.deepEqual(published, []);
        assert.deepEqual(told, [
            { targets: [{ name: "q", args: [2] }], info: { remote: true } },
            { targets: ["q"], info: { remote: true } },
        ]);
        assert.deepEqual(handler.stats().bus, { published: 0, received: 2, unpublishable: 0, errors: 0 });
    });
});

test("the bus's handler returns before the re-runs it starts have finished", async () => {
    let deliver;
    const gate = deferred();
    let calls = 0;
    const handler = serviceDispatcher({ q: () => (++calls === 1 ? 1 : gate.promise) }, "/api", {
        live: { queries: ["q"], public: true, bus: { publish: () => { }, subscribe: (fn) => { deliver = fn; } } },
    });
    const d = driver(handler);
    const stream = await d.open();
    await d.subscribe(stream.id, "q");
    deliver(["q"]);
    await flush();
    assert.equal(calls, 2, "the re-run was started");
    assert.equal(stream.res.patches.length, 1, "and is still going");
    gate.resolve(2);
    await flush();
    assert.deepEqual(stream.res.patches.at(-1), { key: "q:[]", set: [["", 2]], del: [] });
    handler.close();
});

test("a remote invalidation that fails to apply is counted and told to onError as live.bus.apply", async () => {
    let deliver;
    const errors = [];
    const failure = new Error("where broke");
    await withGroups([[1]], {
        live: { bus: { publish: () => { }, subscribe: (fn) => { deliver = fn; } } },
        onError: (error, where, list) => errors.push([error, where, list]),
    }, async ({ handler }) => {
        // An in-process bus can carry what JSON cannot: here a where function that throws.
        const target = { name: "q", where: () => { throw failure; } };
        deliver([target]);
        await flush();
        assert.deepEqual(handler.stats().bus, { published: 0, received: 1, unpublishable: 0, errors: 1 });
        assert.deepEqual(errors, [[failure, "live.bus.apply", [target]]]);
    });
});

test("a remote invalidation that fails with no onError is still counted", async () => {
    let deliver;
    await withGroups([[1]], { live: { bus: { publish: () => { }, subscribe: (fn) => { deliver = fn; } } } }, async ({ handler }) => {
        deliver({ name: "q", where: () => { throw new Error("no"); } });
        await flush();
        assert.equal(handler.stats().bus.errors, 1);
    });
});

test("after close, the bus's handler is unsubscribed", async () => {
    let unsubscribed = 0;
    await withGroups([[1]], { live: { bus: { publish: () => { }, subscribe: () => () => { unsubscribed += 1; } } } }, async ({ handler }) => {
        handler.close();
        assert.equal(unsubscribed, 1);
    });
});

// ---- re-runs that cannot run, or cannot report ------------------------------------------------------------------

test("a group whose service was taken off the services object re-runs nothing and fails nothing", async () => {
    const given = { q: () => 1 };
    const errors = [];
    const handler = serviceDispatcher(given, "/api", { live: { queries: ["q"], public: true }, onError: (...args) => errors.push(args) });
    const d = driver(handler);
    const stream = await d.open();
    await d.subscribe(stream.id, "q");
    delete given.q;
    await handler.invalidate("q");
    assert.deepEqual(stream.res.patches, [{ key: "q:[]", full: 1 }]);
    assert.deepEqual(errors, []);
    handler.close();
});

test("an onError that throws while a failed re-run is reported is told of that too, and nothing rejects", async () => {
    const told = [];
    const dbDown = new Error("db down");
    const loggerDown = new Error("logger down");
    let fail = false;
    const handler = serviceDispatcher({ q: (n) => { if (fail) throw dbDown; return n; } }, "/api", {
        live: { queries: ["q"], public: true },
        onError: (error, where, args) => { told.push([error, where, args]); if (error === dbDown) throw loggerDown; },
    });
    const d = driver(handler);
    const stream = await d.open();
    await d.subscribe(stream.id, "q", [3]);
    fail = true;
    await handler.invalidate("q");
    assert.deepEqual(told, [[dbDown, "q", [3]], [loggerDown, "q", [3]]]);
    handler.close();
});

// ---- bugs ------------------------------------------------------------------------------------------------------------

test("a group whose arguments cannot be made strings does not stop an args target re-running the other groups",
    async () => {
        await withGroups([[1], [{ toString: 0 }], [1, 2]], {}, async ({ handler, runs }) => {
            await handler.invalidate({ name: "q", args: [1] });
            assert.deepEqual(sorted(runs), ["[1,2]", "[1]"]);
        });
    });

test("a group whose first argument has a field that cannot be made a string does not stop a where target re-running the others",
    async () => {
        await withGroups([[{ room: 1 }], [{ room: { toString: 0 } }], [{ room: 1, page: 2 }]], {}, async ({ handler, runs }) => {
            await handler.invalidate({ name: "q", where: { room: 1 } });
            assert.deepEqual(sorted(runs), ['[{"room":1,"page":2}]', '[{"room":1}]']);
        });
    });

test("a where function that throws for one group does not stop the others re-running, and the invalidation rejects with the first error", async () => {
    const first = new Error("no room");
    const second = new Error("no page");
    await withGroups([[1], [2], [3], [4]], {}, async ({ handler, runs }) => {
        const where = (args) => { if (args[0] === 1) throw first; if (args[0] === 3) throw second; return true; };
        await assert.rejects(handler.invalidate([{ name: "q", where }, { name: "q", args: [3] }]), (error) => error === first);
        assert.deepEqual(sorted(runs), ["[2]", "[3]", "[4]"], "a group another target names re-runs even where the function threw");
    });
});

test("a remote where function that throws for one group is still applied to the others, counted and told to onError once", async () => {
    let deliver;
    const errors = [];
    const failure = new Error("where broke");
    await withGroups([[1], [2]], {
        live: { bus: { publish: () => { }, subscribe: (fn) => { deliver = fn; } } },
        onError: (error, where, list) => errors.push([error, where, list]),
    }, async ({ handler, runs }) => {
        const target = { name: "q", where: (args) => { if (args[0] === 1) throw failure; return true; } };
        deliver([target]);
        await flush();
        assert.deepEqual(sorted(runs), ["[2]"]);
        assert.equal(handler.stats().bus.errors, 1);
        assert.deepEqual(errors, [[failure, "live.bus.apply", [target]]]);
    });
});

test("a target built from a caller's argument that cannot be made a string matches nothing, and the call's other targets still re-run", async () => {
    const touches = { post: (room) => [{ name: "q", args: [room] }, { name: "q", where: { room } }, { name: "q", args: [2] }] };
    const errors = [];
    await withGroups([[1], [{ room: 1 }], [2]], { live: { touches }, onError: (error, where) => errors.push(where) }, async ({ handler, runs }) => {
        assert.deepEqual(await handler.invoke("post", [{ toString: 0 }]), { ok: true, result: "posted" });
        await flush();
        assert.deepEqual(sorted(runs), ["[2]"]);
    }, { services: { post: () => "posted" } });
    assert.deepEqual(errors, []);
});

test("a service named after an Object.prototype member, with no touches entry of its own, invalidates nothing",
    async () => {
        const told = [];
        const errors = [];
        const handler = serviceDispatcher({ q: () => 1, toString: () => "s", constructor: () => "c", valueOf: () => "v" }, "/api", {
            live: { queries: ["q"], public: true, touches: {}, onInvalidate: (targets) => told.push(targets) },
            onError: (error, where) => errors.push(where),
        });
        await handler.invoke("toString", []);
        await handler.invoke("constructor", [5]);
        await handler.invoke("valueOf", []);
        await flush();
        handler.close();
        assert.deepEqual(told, []);
        assert.deepEqual(errors, []);
    });
