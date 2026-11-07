// devtools.js, the timeline and the pass ring: what is recorded from the start (each pass's changed
// paths and cause, the pass each binding last ran in, whether a promise it returned is pending), and
// what only while a connection subscribes to `timeline` (every write, every callback of a pass timed,
// what woke it, a frame after the passes). On the stand-in DOM, in a page of
// support/devtools-page.mjs. Held to REFERENCE.md ("devtools.js").
import { test } from "node:test";
import assert from "node:assert/strict";
import { devtoolsPage, withDevtoolsPage, inspect, host } from "../support/devtools-page.mjs";
import { withGlobals, flush } from "../support/remote-services-fakes.mjs";

const timelined = (options) => {
    const inspected = inspect(options);
    inspected.ask("subscribe", { topic: "timeline" });
    return inspected;
};
const passes = (events) => events.filter((event) => event.type === "pass");

test("subscribing to timeline installs observe and timing; the last unsubscribe takes both away", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, endpoint, ask, events, done } = inspect();
    const observers = () => juris.stateManager.observers.size;
    juris.setValue("n", 0);
    assert.equal(observers(), 0, "nothing observed without a subscriber");
    assert.deepEqual(ask("subscribe", { topic: "timeline" }), { topic: "timeline" });
    assert.equal(observers(), 1);
    const other = endpoint.connect();
    endpoint.request(other, "subscribe", { topic: "timeline" });
    assert.equal(observers(), 1, "one observer, however many subscribe");
    juris.setValue("n", 1);
    assert.equal(passes(events()).length, 1);
    assert.equal(passes(endpoint.drain(other).events).length, 1, "each subscriber is told");
    assert.deepEqual(ask("unsubscribe", { topic: "timeline" }), { topic: "timeline" });
    assert.equal(observers(), 1, "another still holds it");
    juris.setValue("n", 2);
    assert.deepEqual(events(), [], "unsubscribed: told nothing");
    endpoint.disconnect(other);
    assert.equal(observers(), 0, "the last one gone");
    juris.setValue("n", 3);
    assert.deepEqual(ask("passes", { since: 0 }).map((pass) => pass.changed), [["n"], ["n"], ["n"], ["n"]], "the ring keeps them all the same");
    done();
}));

test("a pass: its writes, its computeds first, then its bindings by creation order, each timed", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, ask, events, done } = timelined();
    juris.setValue("price", 2);
    juris.setValue("qty", 3);
    juris.compute("total", () => juris.getState("price") * juris.getState("qty"));
    const root = host();
    juris.render(root, { p: { title: () => String(juris.getState("total")), textContent: () => String(juris.getState("price")) } });
    const [title, text] = ask("node", { node: root.childNodes[0] }).bindings;
    const [total] = ask("wakes", { path: "price" }).computeds;
    events();
    juris.setValue("price", 5);
    const [pass] = passes(events());
    assert.deepEqual(pass.cause, { kind: "other" });
    // The computed's write is told at the write, inside the pass; the write that caused the pass,
    // once the pass is done (StateManager.observe).
    assert.deepEqual(pass.writes, [{ path: "total", value: 15, previous: 6, deleted: false }, { path: "price", value: 5, previous: 2, deleted: false }]);
    assert.equal(pass.writeCount, 2);
    assert.deepEqual(pass.ran.map((entry) => entry.binding), [total.id, title.id, text.id]);
    assert.equal(pass.ranCount, 3);
    assert.equal(pass.rounds, 2, "the price, then the total the computed wrote");
    for (const entry of pass.ran) {
        for (const field of ["ms", "readMs", "applyMs"]) assert.ok(typeof entry[field] === "number" && entry[field] >= 0, field);
        assert.ok(entry.ms >= entry.readMs);
        assert.equal(entry.error, null);
    }
    assert.ok(pass.ms >= 0);
    assert.equal(pass.type, "pass");
    assert.equal(typeof pass.at, "number");
    assert.deepEqual(ask("passes", { since: pass.id - 1 }).map((summary) => summary.changed), [["price", "total"]]);
    done();
}));

test("wokeBy: the reads a callback had before the pass that the pass changed", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, ask, events, done } = timelined();
    juris.setValue("user", { first: "Ada", last: "Lovelace", tags: ["a"] });
    juris.setValue("rows", [{ done: false }, { done: true }]);
    const root = host();
    juris.render(root, { p: { title: () => `${juris.getState("user.first")} ${juris.getState("user.last")}`, textContent: () => String(Object.keys(juris.getState("user")).length) } });
    juris.compute("doneCount", () => juris.stateManager.peek("rows").filter((row) => row.done).length, { watch: ["rows.*.done"] });
    const [titleId, keysId] = ask("node", { node: root.childNodes[0] }).bindings.map((binding) => binding.id);
    const [{ id: countId }] = ask("wakes", { path: "rows.0.done" }).computeds;
    const wokeBy = (id) => passes(events()).flatMap((pass) => pass.ran).find((entry) => entry.binding === id)?.wokeBy;
    events();

    juris.setValue("user.first", "Augusta");
    assert.deepEqual(wokeBy(titleId), ["user.first"], "the path itself");
    juris.setValue("user", { first: "Ada", last: "King", tags: [] });
    assert.deepEqual(wokeBy(titleId), ["user.first", "user.last"], "a write above them");
    juris.setValue("user.middle", "Byron");
    assert.deepEqual(wokeBy(keysId), ["user"], "a key came: the readers of its container's shape");
    juris.setValue("rows.1.done", false);
    assert.deepEqual(wokeBy(countId), ["rows.*.done"], "a wildcard");
    juris.deleteState("rows.0");
    assert.deepEqual(wokeBy(countId), ["rows.*.done"], "an index went: the whole array changed");
    juris.batch(() => juris.setValue("rows.0.extra", 1));
    assert.equal(wokeBy(countId), undefined, "a new key beside the watched one wakes no wildcard reader");
    juris.clearState({ user: { first: "x", last: "y" }, rows: [] });
    assert.deepEqual(wokeBy(titleId), ["user.first", "user.last"], "a clear: everything");
    done();
}));

test("a wildcard reader is woken by a shape change at its own depth, not by one above it", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, ask, events, done } = timelined();
    juris.setValue("grid", { a: { x: 1 } });
    juris.compute("cells", () => 0, { watch: ["grid.*.x"] });
    const [{ id }] = ask("wakes", { path: "grid.a.x" }).computeds;
    events();
    juris.setValue("grid.b", { x: 2 });
    const ran = passes(events()).flatMap((pass) => pass.ran).find((entry) => entry.binding === id);
    assert.deepEqual(ran.wokeBy, ["grid.*.x"]);
    done();
}));

test("a cause: a DOM event being dispatched, a clear, a mount, or other", () => withDevtoolsPage(devtoolsPage(), async () => {
    const { juris, ask, events, done } = timelined();
    const button = host();
    await withGlobals({ event: { type: "click", target: button } }, () => juris.setValue("clicked", true));
    juris.clearState({ fresh: true });
    juris.batch(() => { juris.setValue("a", 1); juris.clearState({}); });
    juris.registerComponent("App", (props, api) => { api.setValue("drawing", true); return { p: "x" }; });
    juris.mount(host(), { App: {} });
    await withGlobals({ event: { type: "keydown", target: "not a node" } }, () => juris.setValue("typed", true));
    await withGlobals({ event: null }, () => juris.setValue("plain", 1));
    const causes = passes(events()).map((pass) => pass.cause);
    assert.deepEqual(causes[0], { kind: "event", type: "click", node: causes[0].node });
    assert.equal(causes[0].node.$, "node");
    assert.deepEqual(causes.slice(1), [{ kind: "clear" }, { kind: "clear" }, { kind: "mount" }, { kind: "event", type: "keydown", node: null }, { kind: "other" }]);
    assert.deepEqual(ask("passes", { since: 0 }).map((pass) => pass.cause.kind), ["event", "clear", "clear", "mount", "event", "other"], "kept from the start");
    done();
}));

test("writes: as written, at depth 1; past 50 counted, not kept; a delete says so; a binding's own writes are its pass's", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, events, done } = timelined();
    juris.setValue("deep", { a: { b: { c: 1 } }, n: 1 });
    events();
    juris.batch(() => { for (let i = 0; i < 60; i += 1) juris.setValue(`many.${i}`, i); });
    const [many] = passes(events());
    assert.equal(many.writeCount, 60);
    assert.equal(many.writes.length, 50);
    assert.deepEqual(many.writes[49], { path: "many.49", value: 49, previous: { $: "undefined" }, deleted: false });

    juris.setValue("deep", { a: { b: 2 }, n: 2 });
    const [deep] = passes(events());
    assert.deepEqual(deep.writes[0].value, { a: { $: "more", path: "deep.a" }, n: 2 });
    assert.deepEqual(deep.writes[0].previous, { a: { $: "more", path: "deep.a" }, n: 1 });

    juris.deleteState("deep.n");
    juris.setValue("deep.a", undefined);
    const [deleted, undefinedValue] = passes(events());
    assert.deepEqual(deleted.writes, [{ path: "deep.n", value: { $: "undefined" }, previous: 2, deleted: true }]);
    assert.equal(undefinedValue.writes[0].deleted, false, "a key that holds undefined is not deleted");

    // A binding that writes in its pass: its write is in the same pass, as the next round.
    juris.setValue("source", 1);
    juris.bindState(() => juris.getState("source"), (value) => juris.setValue("mirror", value * 10));
    events();
    juris.setValue("source", 2);
    const [chained] = passes(events());
    assert.deepEqual(chained.writes.map((write) => write.path), ["mirror", "source"], "the binding's write is told at the write; the one that caused the pass after it");
    assert.equal(chained.rounds, 2);
    done();
}));

test("a frame: the passes since the last animation frame, once per frame", () => withDevtoolsPage(devtoolsPage(), (page) => {
    const { juris, ask, events, done } = timelined();
    juris.setValue("n", 1);
    juris.setValue("n", 2);
    assert.equal(page.frames.length, 1, "one frame asked for");
    page.runFrames();
    const sent = events();
    const ids = passes(sent).map((pass) => pass.id);
    const frame = sent.find((event) => event.type === "frame");
    assert.deepEqual(frame.passes, ids);
    page.runFrames();
    assert.deepEqual(events(), [], "no pass, no frame");
    juris.setValue("n", 3);
    ask("unsubscribe", { topic: "timeline" });
    page.runFrames();
    assert.deepEqual(events().map((event) => event.type), ["pass"], "unsubscribed before the frame: the pass sent before, no frame");
    done();
}));

test("ran: the first 500 callbacks kept, every one counted; a callback that throws is named, a plain subscriber has no binding", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, events, done } = timelined();
    juris.setValue("tick", 0);
    for (let i = 0; i < 600; i += 1) juris.bindState(() => juris.getState("tick"), () => { });
    juris.stateManager.subscribe(["tick"], () => { });
    juris.bindState(() => {
        if (juris.getState("tick") > 0) throw new RangeError("too far");
        return 0;
    }, () => { });
    events();
    assert.throws(() => juris.setValue("tick", 1), RangeError);
    const [pass] = passes(events());
    assert.equal(pass.ranCount, 602);
    assert.equal(pass.ran.length, 500);
    assert.equal(pass.ran[0].binding, null, "the plain subscriber, which runs first (it has no order)");
    assert.equal(pass.ran[0].readMs, 0, "it reads nothing through the state manager");
    done();
    // The error, on a smaller pass.
    const second = timelined();
    second.juris.setValue("t", 0);
    second.juris.bindState(() => { if (second.juris.getState("t") > 0) throw new RangeError("too far"); }, () => { });
    second.events();
    assert.throws(() => second.juris.setValue("t", 1), RangeError);
    const [failed] = passes(second.events());
    assert.deepEqual(failed.ran[0].error, { name: "RangeError", message: "too far" });
    second.done();
}));

test("a write under a private root is counted, never listed: in writes, changed, reads and wokeBy", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, ask, events, done } = timelined({ privatePaths: ["vault"], state: { vault: { key: "s3cret" }, $server: { token: "t" } } });
    const root = host();
    juris.render(root, { p: { title: () => `${juris.getState("vault.key")}${juris.getState("$server.token")}${juris.getState("open", "")}` } });
    events();
    juris.batch(() => {
        juris.setValue("vault.key", "n3w");
        juris.setValue("vault.other", "x");
        juris.setValue("$server.token", "u");
        juris.setValue("open", "yes");
        juris.setValue("$async.pending", 0);
    });
    const [pass] = passes(events());
    assert.deepEqual(pass.writes.map((write) => write.path ?? write), [{ root: "vault", count: 2 }, { root: "$server", count: 1 }, "open", "$async.pending"]);
    assert.equal(pass.writeCount, 5);
    assert.ok(!JSON.stringify(pass).includes("s3cret") && !JSON.stringify(pass).includes("n3w"));
    assert.deepEqual(pass.ran[0].wokeBy, [{ root: "$server", count: 1 }, "open", { root: "vault", count: 1 }]);
    const [summary] = ask("passes", { since: pass.id - 1 });
    // A key that came changes its container's shape too: `vault` itself, and `$async`, made for it.
    assert.deepEqual(summary.changed, [{ root: "vault", count: 3 }, { root: "$server", count: 1 }, "open", "$async", "$async.pending"]);
    const [binding] = ask("node", { node: root.childNodes[0] }).bindings;
    assert.deepEqual(binding.reads, [{ root: "$server", count: 1 }, "open", { root: "vault", count: 1 }]);
    // A clear writes the root, whose private roots are counted in its value.
    juris.clearState({ vault: { a: 1, b: 2 }, open: 1 });
    const [cleared] = passes(events());
    assert.deepEqual(cleared.writes[0].value, { vault: { $: "private", count: 2 }, open: 1, $async: { $: "more", path: "$async" } }, "the async root, carried over in a browser, is read like the rest");
    // More private writes than there is room to list, after 50 others: counted.
    juris.batch(() => { for (let i = 0; i < 50; i += 1) juris.setValue(`open${i}`, i); juris.setValue("vault.late", 1); });
    const [full] = passes(events());
    assert.equal(full.writes.length, 50);
    assert.equal(full.writeCount, 51);
    done();
}));

test("pending: a binding whose promise is outstanding, until it settles, resolved or rejected", () => withDevtoolsPage(devtoolsPage(), async () => {
    const { juris, ask, done } = inspect({ pendingDelay: 0 });
    juris.setValue("id", 1);
    let release;
    let refuse;
    const root = host();
    juris.render(root, { p: { title: () => (juris.getState("id") === 1 ? new Promise((resolve) => { release = resolve; }) : new Promise((resolve, reject) => { refuse = reject; })) } });
    const pending = () => ask("node", { node: root.childNodes[0] }).bindings[0].pending;
    assert.equal(pending(), true);
    release("loaded");
    await flush();
    assert.equal(pending(), false);
    juris.setValue("id", 2);
    assert.equal(pending(), true);
    refuse(new Error("no"));
    await flush();
    assert.equal(pending(), false, "a rejection settles it too");
    // A thenable that is not a promise is pending until its binding next runs.
    juris.setValue("thenable", 1);
    const other = host();
    juris.render(other, { p: { title: () => (juris.getState("thenable") === 1 ? { then() { } } : "plain") } });
    const thenable = () => ask("node", { node: other.childNodes[0] }).bindings[0].pending;
    assert.equal(thenable(), true);
    juris.setValue("thenable", 2);
    assert.equal(thenable(), false);
    // A computed or a direct binding that returns a promise.
    juris.compute("later", () => Promise.resolve(juris.getState("id")));
    const [later] = ask("wakes", { path: "id" }).computeds;
    assert.equal(later.pending, true);
    await flush();
    assert.equal(ask("binding", { id: later.id }).pending, false);
    done();
}));

test("a binding disposed twice is forgotten once; a pass inside a pass is the outer pass", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, ask, events, done } = timelined();
    juris.setValue("x", 1);
    const dispose = juris.bindState(() => juris.getState("x"), () => { });
    const [{ id }] = ask("wakes", { path: "x" }).bindings;
    dispose();
    dispose();
    assert.equal(ask("wakes", { path: "x" }).bindings.length, 0);
    assert.equal(id > 0, true);
    // The state manager's run, called inside a pass (nothing in the core does), is part of it.
    juris.bindState(() => juris.getState("x"), (value) => { if (value === 2) juris.stateManager.run(["inner"]); });
    events();
    juris.setValue("x", 2);
    const sent = passes(events());
    assert.equal(sent.length, 1);
    assert.deepEqual(ask("passes", { since: sent[0].id - 1 }).map((pass) => pass.changed), [["x", "inner"]]);
    done();
}));

test("a subscription made inside a pass starts with the next pass", () => withDevtoolsPage(devtoolsPage(), () => {
    const { juris, endpoint, connection, events, done } = inspect();
    juris.setValue("go", 0);
    juris.bindState(() => juris.getState("go"), (value) => { if (value === 1) endpoint.request(connection, "subscribe", { topic: "timeline" }); juris.setValue("echo", value); });
    juris.setValue("go", 1);
    assert.deepEqual(passes(events()), [], "the pass it was made in is not on the timeline");
    juris.setValue("go", 2);
    const [pass] = passes(events());
    assert.ok(pass.writes.some((write) => write.path === "go"));
    done();
}));
