// clock.js (REFERENCE.md, "clock.js"): the plugin that gives every component api.now(), answered
// by the clock the app passes (or Date.now()), and that marks a traced server render "clock".
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import { clock } from "juris/clock.js";
import { withSSR } from "../support/ssr-renderer.mjs";

const server = () => new Juris(withSSR({ isServer: true }));

test("api.now() answers the clock the app passed", () => {
    const juris = server().use(clock(() => 1_700_000_000_000));
    assert.equal(juris.api.now(), 1_700_000_000_000);
});

test("a component reads the time through api.now(), so a frozen clock freezes what it draws", () => {
    const juris = server().use(clock(() => Date.UTC(2026, 0, 2)));
    juris.registerComponent("Today", (props, api) => ({ p: new Date(api.now()).toISOString().slice(0, 10) }));
    assert.equal(juris.renderToString({ Today: {} }), "<p>2026-01-02</p>");
});

test("api.now() asks the clock on every read, not once", () => {
    let t = 10;
    const juris = server().use(clock(() => t++));
    assert.deepEqual([juris.api.now(), juris.api.now(), juris.api.now()], [10, 11, 12]);
});

test("without a clock given, api.now() is Date.now()", (t) => {
    mock.timers.enable({ apis: ["Date"], now: 86_400_000 });
    t.after(() => mock.timers.reset());
    const juris = server().use(clock());
    assert.equal(juris.api.now(), 86_400_000);
    mock.timers.tick(1500);
    assert.equal(juris.api.now(), 86_401_500);
});

test("a read during a traced render marks that render with the flag \"clock\"", () => {
    const juris = server().use(clock(() => 0));
    juris.registerComponent("Stamp", (props, api) => ({ time: String(api.now()) }));
    juris.renderToString({ Stamp: {} }, null, { trace: true });
    assert.deepEqual(juris.renderTrace().flags, ["clock"]);
});

test("a read in a reactive function of a traced render marks it too", () => {
    const juris = server().use(clock(() => 5));
    const html = juris.renderToString({ p: () => String(juris.api.now()) }, null, { trace: true });
    assert.equal(html, "<p>5</p>");
    assert.ok(juris.renderTrace().flags.includes("clock"));
});

test("a traced render that never reads the clock carries no flag", () => {
    const juris = server().use(clock(() => 0));
    juris.renderToString({ p: "static" }, null, { trace: true });
    assert.deepEqual(juris.renderTrace().flags, []);
});

test("renderRequest's trace says the page depends on the clock, so a page cache will not keep it", async () => {
    const juris = server().use(clock(() => 0));
    juris.registerComponent("Page", (props, api) => ({ p: `now ${api.now()}` }));
    const { html, trace } = await juris.renderRequest({ layout: { Page: {} }, trace: true });
    assert.equal(html, "<p>now 0</p>");
    assert.deepEqual(trace.flags, ["clock"]);
    assert.equal(trace.static, true, "the flag, not `static`, is what tells the cache");
});

test("a read outside any traced render marks nothing and still answers", () => {
    const juris = server().use(clock(() => 7));
    assert.equal(juris.api.now(), 7);
    juris.renderToString({ p: () => String(juris.api.now()) });
    assert.equal(juris.renderTrace(), null, "an untraced render leaves no trace to mark");
});

test("a read in a browser instance answers the clock as on the server", () => {
    const juris = new Juris({ isServer: false }).use(clock(() => 42));
    assert.equal(juris.api.now(), 42);
});

test("the api takes the name now once: a second clock is refused", () => {
    const juris = server().use(clock(() => 1));
    assert.throws(() => juris.use(clock(() => 2)), /already has "now"/);
    assert.equal(juris.api.now(), 1);
});
