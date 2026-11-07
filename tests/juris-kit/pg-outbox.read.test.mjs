// The Postgres change bus's reading side: where start puts the cursor, how rows become the targets
// delivered to the subscriber (the registry, published payloads, its own echo), the ids it jumped
// over and re-checks for the lookback, a full batch, a burst of notifications coalesced, the sweep,
// a failed read kept in stats() as a time and never as words, and stop waiting for a read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgOutboxBus } from "juris-kit/server/bus/pg-outbox.js";
import { fakePgPool, settle, gate } from "../support/pg-outbox-fake-pg.mjs";

const T0 = 1_000_000;
const chat = (id) => ({ name: "chat", args: [id] });

// A started bus over a fake pool, with its clock in the test's hands and every delivery recorded.
async function started(t, options = {}, { from } = {}) {
    const pool = options.pool ?? fakePgPool();
    const clock = { now: T0 };
    const delivered = [];
    const errors = [];
    const bus = createPgOutboxBus({
        targets: { chat }, now: () => clock.now, sweepMs: 60_000, onError: (error) => errors.push(error), ...options, pool,
    });
    bus.subscribe((list) => { delivered.push(list); });
    t.after(() => bus.stop());
    await bus.start(from === undefined ? undefined : { from });
    return { pool, bus, clock, delivered, errors };
}

// ---- the cursor ---------------------------------------------------------------------------------

test("a bus started from the end reads the table's highest id and never replays what came before", async (t) => {
    const pool = fakePgPool();
    pool.insert("chat", 1);
    pool.insert("chat", 2);
    const { bus, delivered } = await started(t, { pool });
    assert.deepEqual(pool.queries[0], { sql: "SELECT COALESCE(MAX(id), 0) AS id FROM change_events", params: [] });
    assert.equal(bus.cursor, 2, "pg's bigint, a string, read as a number");
    await bus.read();
    assert.deepEqual(delivered, []);
    pool.insert("chat", 3);
    await bus.read();
    assert.deepEqual(delivered, [[chat("3")]]);
    assert.equal(bus.cursor, 3);
});

test("a bus started from an id reads every row after it, without asking for the highest", async (t) => {
    const pool = fakePgPool();
    for (const id of [1, 2, 3]) pool.insert("chat", id);
    const { bus, delivered } = await started(t, { pool }, { from: 1 });
    assert.equal(pool.queries.some((q) => /MAX\(id\)/.test(q.sql)), false);
    assert.equal(bus.cursor, 1);
    await bus.read();
    assert.deepEqual(delivered, [[chat("2"), chat("3")]]);
    assert.deepEqual(pool.batchReads()[0].params, [1, 500], "the cursor and the batch size");
});

test("a cursor read that answers no row starts the bus at 0", async (t) => {
    const pool = fakePgPool();
    pool.onQuery = (sql) => (/MAX\(id\)/.test(sql) ? { rows: [] } : undefined);
    const { bus } = await started(t, { pool });
    assert.equal(bus.cursor, 0);
});

test("starting a bus that is running does nothing more and answers the bus", async (t) => {
    const { pool, bus } = await started(t);
    assert.equal(await bus.start(), bus);
    assert.equal(pool.connects, 1);
    assert.equal(pool.queries.filter((q) => /MAX\(id\)/.test(q.sql)).length, 1);
});

test("a stopped bus reads nothing when asked", async (t) => {
    const { pool, bus } = await started(t);
    await bus.stop();
    pool.insert("chat", 1);
    const reads = pool.queries.length;
    await bus.read();
    assert.equal(pool.queries.length, reads);
});

// ---- from rows to targets -----------------------------------------------------------------------

test("each row is mapped through the registry, once per entity and id in a batch", async (t) => {
    const targets = {
        chat,
        lot: (id) => [{ name: "lot", args: [id] }, "$pages"],
        ghost: () => null,
    };
    const { pool, bus, delivered } = await started(t, { targets });
    pool.insert("chat", 7);
    pool.insert("chat", 7);
    pool.insert("lot", "A-1");
    pool.insert("ghost", 1);
    pool.insert("nobody", 1);
    pool.insert("chat", 8);
    await bus.read();
    assert.deepEqual(delivered, [[chat("7"), { name: "lot", args: ["A-1"] }, "$pages", chat("8")]]);
    const stats = bus.stats();
    assert.equal(stats.events, 6, "every new row counts");
    assert.equal(stats.delivered, 4, "the targets handed over");
});

test("the registry is given the entity id as text", async (t) => {
    const seen = [];
    const { pool, bus } = await started(t, { targets: { chat: (id) => { seen.push(id); return chat(id); } } });
    pool.onQuery = (sql) => (/WHERE id > \$1/.test(sql)
        ? { rows: [{ id: "1", entity: "chat", entity_id: 42, payload: null, created_at: new Date(T0) }] }
        : undefined);
    await bus.read();
    assert.deepEqual(seen, ["42"]);
});

test("an entity named like an Object.prototype member maps to nothing, unless the registry has it as its own", async (t) => {
    const named = (id) => ({ name: "named", args: [id] });
    const { pool, bus, delivered, errors } = await started(t, { targets: { chat, toString: named } });
    for (const entity of ["constructor", "valueOf", "hasOwnProperty", "__proto__", "toString"]) pool.insert(entity, 1);
    pool.insert("chat", 2);
    await bus.read();
    assert.deepEqual(delivered, [[named("1"), chat("2")]]);
    assert.deepEqual(errors, []);
    assert.equal(bus.stats().errors, 0);
});

test("a bus with no registry delivers nothing for an entity's row, and still reads it", async (t) => {
    const { pool, bus, delivered } = await started(t, { targets: undefined });
    pool.insert("chat", 1);
    await bus.read();
    assert.deepEqual(delivered, []);
    assert.equal(bus.stats().events, 1);
    assert.equal(bus.cursor, 1);
});

test("a published row delivers its targets as written, and the bus skips its own echo", async (t) => {
    const { pool, bus, delivered } = await started(t, { origin: "me" });
    const theirs = [{ name: "chat", args: [1] }, "$pages"];
    pool.insert("$targets", "-", { payload: JSON.stringify({ o: "other-instance", t: theirs }) });
    await bus.publish([{ name: "chat", args: [2] }]);
    await bus.read();
    assert.deepEqual(delivered, [theirs]);
    assert.equal(bus.stats().ownEchoes, 1);
    assert.equal(bus.stats().delivered, 2);
});

test("published rows with the same targets are each delivered, not collapsed into one", async (t) => {
    const { pool, bus, delivered } = await started(t);
    const payload = JSON.stringify({ o: "other", t: ["x"] });
    pool.insert("$targets", "-", { payload });
    pool.insert("$targets", "-", { payload });
    await bus.read();
    assert.deepEqual(delivered, [["x", "x"]]);
});

test("a payload that is a bare list of targets is delivered as that list", async (t) => {
    const { pool, bus, delivered } = await started(t);
    pool.insert("$targets", "-", { payload: JSON.stringify([{ name: "legacy" }]) });
    await bus.read();
    assert.deepEqual(delivered, [[{ name: "legacy" }]]);
});

test("a payload that cannot be read counts as an error, and the rest of the batch is still delivered", async (t) => {
    const { pool, bus, delivered } = await started(t);
    pool.insert("$targets", "-", { payload: "{not json" });
    pool.insert("$targets", "-", { payload: "null" });
    pool.insert("chat", 9);
    await bus.read();
    assert.deepEqual(delivered, [[chat("9")]]);
    assert.equal(bus.stats().errors, 2);
    assert.equal(bus.cursor, 3, "an unreadable row is not read again");
});

test("with no subscriber nothing is delivered, and unsubscribing stops delivery", async (t) => {
    const pool = fakePgPool();
    const bus = createPgOutboxBus({ pool, targets: { chat } });
    t.after(() => bus.stop());
    await bus.start();
    pool.insert("chat", 1);
    await bus.read();
    assert.equal(bus.stats().events, 1);
    assert.equal(bus.stats().delivered, 0);
    const got = [];
    const unsubscribe = bus.subscribe((list) => got.push(list));
    pool.insert("chat", 2);
    await bus.read();
    unsubscribe();
    pool.insert("chat", 3);
    await bus.read();
    assert.deepEqual(got, [[chat("2")]]);
    assert.equal(bus.stats().delivered, 1);
});

test("a later subscriber replaces the earlier one", async (t) => {
    const { pool, bus, delivered } = await started(t);
    const later = [];
    bus.subscribe((list) => later.push(list));
    pool.insert("chat", 1);
    await bus.read();
    assert.deepEqual(delivered, []);
    assert.deepEqual(later, [[chat("1")]]);
});

// ---- ids committed out of order -----------------------------------------------------------------

test("an id jumped over is re-checked until its transaction commits, and then delivered once", async (t) => {
    const { pool, bus, delivered } = await started(t);
    const slow = pool.reserve("chat", "slow");
    pool.insert("chat", "fast");
    await bus.read();
    assert.deepEqual(delivered, [[chat("fast")]]);
    assert.equal(bus.cursor, 2);
    assert.equal(bus.stats().gaps, 1);
    assert.equal(pool.gapReads().length, 0, "the first read had nothing to re-check");
    await bus.read();
    assert.deepEqual(pool.gapReads().at(-1), {
        sql: "SELECT id, entity, entity_id, payload, created_at FROM change_events WHERE id = ANY($1::bigint[])",
        params: [[slow.id]],
    });
    assert.deepEqual(delivered.length, 1, "still not committed");
    pool.commit(slow.id);
    await bus.read();
    assert.deepEqual(delivered, [[chat("fast")], [chat("slow")]]);
    assert.equal(bus.stats().gaps, 0);
    await bus.read();
    assert.equal(delivered.length, 2, "delivered once");
    assert.equal(bus.stats().duplicates, 0);
});

test("every id jumped over in a batch is tracked, and re-checked together", async (t) => {
    const { pool, bus } = await started(t);
    pool.reserve("chat", "a");
    pool.insert("chat", "b");
    pool.reserve("chat", "c");
    pool.reserve("chat", "d");
    pool.insert("chat", "e");
    await bus.read();
    assert.equal(bus.stats().gaps, 3);
    await bus.read();
    assert.deepEqual(pool.gapReads().at(-1).params, [[1, 3, 4]]);
});

test("an id that never commits stops being re-checked once it is older than the lookback", async (t) => {
    const { pool, bus, clock, delivered } = await started(t, { lookbackMs: 5000 });
    const lost = pool.reserve("chat", "rolled-back");
    pool.insert("chat", "next");
    await bus.read();
    clock.now += 5000;
    await bus.read();
    assert.equal(bus.stats().gaps, 1, "still inside the lookback");
    clock.now += 1;
    await bus.read();
    assert.equal(bus.stats().gaps, 0);
    const checks = pool.gapReads().length;
    pool.commit(lost.id);
    await bus.read();
    assert.equal(pool.gapReads().length, checks, "not asked about again");
    assert.deepEqual(delivered, [[chat("next")]]);
});

test("a jump of more than 1000 ids is not taken for transactions in flight", async (t) => {
    const near = await started(t, { pool: fakePgPool({ start: 1000 }) }, { from: 0 });
    near.pool.insert("chat", "x");     // id 1001: 1000 ids jumped over
    await near.bus.read();
    assert.equal(near.bus.stats().gaps, 1000);
    const far = await started(t, { pool: fakePgPool({ start: 1001 }) }, { from: 0 });
    far.pool.insert("chat", "y");      // id 1002: 1001 ids jumped over
    await far.bus.read();
    assert.equal(far.bus.stats().gaps, 0);
    assert.deepEqual(far.delivered, [[chat("y")]]);
});

test("a row read again after the cursor was moved back counts as a duplicate and is not delivered again", async (t) => {
    const { pool, bus, delivered } = await started(t);
    pool.insert("chat", 1);
    pool.insert("chat", 2);
    await bus.read();
    await bus.stop();
    await bus.start({ from: 0 });
    await bus.read();
    assert.deepEqual(delivered, [[chat("1"), chat("2")]]);
    assert.equal(bus.stats().duplicates, 2);
    assert.equal(bus.stats().events, 2);
});

test("a row is remembered for twice the lookback, then forgotten", async (t) => {
    const { pool, bus, clock } = await started(t, { lookbackMs: 1000 });
    pool.insert("chat", 1);
    await bus.read();
    assert.equal(bus.stats().tracked, 1);
    clock.now += 2000;
    await bus.read();
    assert.equal(bus.stats().tracked, 1);
    clock.now += 1;
    await bus.read();
    assert.equal(bus.stats().tracked, 0);
});

// ---- batches --------------------------------------------------------------------------------------

test("a full batch is followed at once by the next, until one comes back short", async (t) => {
    const { pool, bus, delivered } = await started(t, { batchSize: 2 });
    for (const id of [1, 2, 3, 4, 5]) pool.insert("chat", id);
    await bus.read();
    assert.deepEqual(pool.batchReads().map((q) => q.params), [[0, 2], [2, 2], [4, 2]]);
    assert.deepEqual(delivered, [[chat("1"), chat("2")], [chat("3"), chat("4")], [chat("5")]]);
    assert.equal(bus.stats().reads, 3);
});

test("a read asked for while one runs is folded into one more read after it", async (t) => {
    const { pool, bus, delivered } = await started(t);
    const held = gate();
    let hold = true;
    pool.onQuery = async (sql) => { if (hold && /WHERE id > \$1/.test(sql)) { hold = false; await held.promise; } };
    pool.insert("chat", 1);
    const first = bus.read();
    await settle();
    pool.insert("chat", 2);
    await Promise.all([bus.read(), bus.read(), bus.read()]);
    assert.equal(pool.batchReads().length, 1, "the asks returned without reading");
    held.open();
    await first;
    assert.equal(pool.batchReads().length, 2, "one more read for all of them");
    assert.deepEqual(delivered.flat(), [chat("1"), chat("2")]);
});

test("stop waits for a read in flight, and the read does not go round again", async (t) => {
    const { pool, bus } = await started(t, { batchSize: 1 });
    const held = gate();
    pool.onQuery = async (sql) => { if (/WHERE id > \$1/.test(sql)) await held.promise; };
    pool.insert("chat", 1);
    pool.insert("chat", 2);
    const reading = bus.read();
    await settle();
    let done = false;
    const stopping = bus.stop().then(() => { done = true; });
    await settle();
    assert.equal(done, false, "the read still holds it");
    held.open();
    await stopping;
    await reading;
    assert.equal(pool.batchReads().length, 1, "a full batch read no further once stopped");
});

// ---- lag --------------------------------------------------------------------------------------------

test("lagMs is how long ago the oldest new row was written, by the bus's clock", async (t) => {
    const { pool, bus } = await started(t);
    pool.insert("chat", 1, { at: new Date(T0 - 40) });
    pool.insert("chat", 2, { at: new Date(T0 - 250) });
    await bus.read();
    assert.equal(bus.stats().lagMs, 250);
});

test("lagMs ignores a time it cannot read, and is never below zero", async (t) => {
    const { pool, bus } = await started(t);
    pool.insert("chat", 1, { at: "not a time" });
    await bus.read();
    assert.equal(bus.stats().lagMs, 0);
    pool.insert("chat", 2, { at: new Date(T0 + 60_000) });
    await bus.read();
    assert.equal(bus.stats().lagMs, 0);
});

// ---- a failed read ------------------------------------------------------------------------------

test("a failed read counts with its time in stats(), its words go to onError alone, and the next read works", async (t) => {
    const { pool, bus, clock, errors, delivered } = await started(t);
    const failure = new Error('password authentication failed for user "app" on db.internal:5432');
    pool.onQuery = (sql) => { if (/WHERE id > \$1/.test(sql)) throw failure; };
    pool.insert("chat", 1);
    clock.now = T0 + 123;
    await bus.read();
    assert.deepEqual(errors, [failure]);
    const stats = bus.stats();
    assert.equal(stats.errors, 1);
    assert.equal(stats.lastErrorAt, T0 + 123);
    assert.doesNotMatch(JSON.stringify(stats), /password|db\.internal|app/);
    pool.onQuery = null;
    await bus.read();
    assert.deepEqual(delivered, [[chat("1")]]);
});

test("a subscriber that throws counts as a failed read and reaches onError", async (t) => {
    const { pool, bus, errors } = await started(t);
    const failure = new Error("dispatcher closed");
    bus.subscribe(() => { throw failure; });
    pool.insert("chat", 1);
    await bus.read();
    assert.deepEqual(errors, [failure]);
    assert.equal(bus.stats().errors, 1);
    assert.equal(bus.stats().lastErrorAt, T0);
});

test("a failed read with no onError is counted and does not throw", async (t) => {
    const { pool, bus } = await started(t, { onError: null });
    pool.onQuery = () => { throw new Error("gone"); };
    await bus.read();
    assert.equal(bus.stats().errors, 1);
});

test("stats() says what the bus did, with its cursor, the ids it remembers and the gaps it re-checks", async (t) => {
    const { pool, bus } = await started(t);
    pool.reserve("chat", 1);
    pool.insert("chat", 2);
    await bus.read();
    assert.deepEqual(Object.keys(bus.stats()).sort(), ["cursor", "delivered", "duplicates", "errors", "events", "gaps", "lagMs",
        "lastErrorAt", "notifies", "ownEchoes", "reads", "sweeps", "tracked"]);
    const { cursor, tracked, gaps, reads, events, delivered, errors, lastErrorAt } = bus.stats();
    assert.deepEqual({ cursor, tracked, gaps, reads, events, delivered, errors, lastErrorAt },
        { cursor: 2, tracked: 1, gaps: 1, reads: 1, events: 1, delivered: 1, errors: 0, lastErrorAt: null });
});

// ---- the doorbell and the sweep, on the test's timers ----------------------------------------------

test("a notification reads at once, and a burst within coalesceMs is batched into one trailing read", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: T0 });
    const pool = fakePgPool();
    const delivered = [];
    const bus = createPgOutboxBus({ pool, targets: { chat }, coalesceMs: 8, sweepMs: 60_000 });
    bus.subscribe((list) => { delivered.push(list); });
    t.after(() => bus.stop());
    await bus.start();
    pool.insert("chat", 1);
    pool.notify();
    await settle();
    assert.deepEqual(delivered, [[chat("1")]], "the quiet case does not wait");
    t.mock.timers.tick(2);
    pool.insert("chat", 2);
    pool.notify();
    t.mock.timers.tick(1);
    pool.insert("chat", 3);
    pool.notify();
    await settle();
    assert.equal(pool.batchReads().length, 1, "a burst waits");
    t.mock.timers.tick(4);
    await settle();
    assert.equal(pool.batchReads().length, 1, "until coalesceMs after the last read");
    t.mock.timers.tick(1);
    await settle();
    assert.equal(pool.batchReads().length, 2);
    assert.deepEqual(delivered, [[chat("1")], [chat("2"), chat("3")]]);
    assert.equal(bus.stats().notifies, 3);
    t.mock.timers.tick(8);
    pool.insert("chat", 4);
    pool.notify();
    await settle();
    assert.equal(pool.batchReads().length, 3, "quiet again: read at once");
});

test("stop cancels a trailing read that was waiting", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: T0 });
    const pool = fakePgPool();
    const bus = createPgOutboxBus({ pool, targets: { chat }, coalesceMs: 8, sweepMs: 60_000 });
    await bus.start();
    pool.notify();
    pool.notify();
    await settle();
    assert.equal(pool.batchReads().length, 1);
    await bus.stop();
    t.mock.timers.tick(100);
    await settle();
    assert.equal(pool.batchReads().length, 1);
});

test("the sweep reads every sweepMs without a notification, and stops with the bus", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: T0 });
    const pool = fakePgPool();
    const delivered = [];
    const bus = createPgOutboxBus({ pool, targets: { chat }, sweepMs: 2000 });
    bus.subscribe((list) => { delivered.push(list); });
    await bus.start();
    pool.insert("chat", 1);       // a change whose doorbell nobody heard
    t.mock.timers.tick(1999);
    await settle();
    assert.equal(pool.batchReads().length, 0);
    t.mock.timers.tick(1);
    await settle();
    assert.deepEqual(delivered, [[chat("1")]]);
    t.mock.timers.tick(2000);
    await settle();
    assert.equal(pool.batchReads().length, 2);
    await bus.stop();
    t.mock.timers.tick(10_000);
    await settle();
    assert.equal(pool.batchReads().length, 2);
});

test("a sweep counts in stats().sweeps", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: T0 });
    const pool = fakePgPool();
    const bus = createPgOutboxBus({ pool, sweepMs: 2000 });
    t.after(() => bus.stop());
    await bus.start();
    t.mock.timers.tick(2000);
    await settle();
    t.mock.timers.tick(2000);
    await settle();
    assert.equal(pool.batchReads().length, 2);
    assert.equal(bus.stats().sweeps, 2);
});
