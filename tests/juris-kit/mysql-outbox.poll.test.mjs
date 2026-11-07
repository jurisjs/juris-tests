// The MariaDB/MySQL change bus's polling side: where start puts the cursor, the poll every
// intervalMs, how rows become the targets delivered (the registry, published payloads, its own
// echo), the AUTO_INCREMENT gaps re-checked for the lookback, a full batch followed by the next poll
// only once it is delivered (never two polls at once), a failed poll kept in stats() as a time and
// never as words, and stop waiting for a poll in flight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOutboxBus } from "juris-kit/server/bus/mysql-outbox.js";
import { fakeOutboxDb, settle, gate } from "../support/mysql-outbox-fake-db.mjs";

const T0 = 1_000_000;
const chat = (id) => ({ name: "chat", args: [id] });

// A started bus over a fake table, its clock in the test's hands, every delivery recorded. Its
// interval is far off, so only the test's own poll() calls read, unless a test puts the timers in
// its hands (mock.timers) and ticks them.
async function started(t, options = {}, { from } = {}) {
    const db = options.db ?? fakeOutboxDb();
    const clock = { now: T0 };
    const delivered = [];
    const errors = [];
    const bus = createOutboxBus({ targets: { chat }, now: () => clock.now, intervalMs: 600_000, onError: (error) => errors.push(error), ...options, db });
    bus.subscribe((list) => { delivered.push(list); });
    t.after(() => bus.stop());
    await bus.start(from === undefined ? undefined : { from });
    return { db, bus, clock, delivered, errors };
}

// ---- the cursor and the interval --------------------------------------------------------------------

test("a bus started from the end reads the table's highest id and never replays what came before", async (t) => {
    const db = fakeOutboxDb();
    db.insert("chat", 1);
    db.insert("chat", 2);
    const { bus, delivered } = await started(t, { db });
    assert.equal(db.queries[0].sql, "SELECT COALESCE(MAX(id), 0) AS id FROM change_events");
    assert.equal(bus.cursor, 2);
    await bus.poll();
    assert.deepEqual(delivered, []);
    db.insert("chat", 3);
    await bus.poll();
    assert.deepEqual(delivered, [[chat("3")]]);
    assert.deepEqual(db.batchReads().map((q) => [q.sql, q.params]), [
        ["SELECT id, entity, entity_id, payload, created_at FROM change_events WHERE id > ? ORDER BY id LIMIT ?", [2, 500]],
        ["SELECT id, entity, entity_id, payload, created_at FROM change_events WHERE id > ? ORDER BY id LIMIT ?", [2, 500]],
    ]);
});

test("a cursor the driver answers as a BigInt is read as a number", async (t) => {
    const db = fakeOutboxDb({ bigint: true });
    db.insert("chat", 1);
    const { bus, delivered } = await started(t, { db });
    assert.equal(bus.cursor, 1);
    db.insert("chat", 2);
    await bus.poll();
    assert.deepEqual(delivered, [[chat("2")]]);
    assert.equal(bus.cursor, 2);
});

test("a bus started from an id reads every row after it, without asking for the highest", async (t) => {
    const db = fakeOutboxDb();
    for (const id of [1, 2, 3]) db.insert("chat", id);
    const { bus, delivered } = await started(t, { db, table: "change_events" }, { from: 1 });
    assert.equal(db.queries.some((q) => /MAX\(id\)/.test(q.sql)), false);
    await bus.poll();
    assert.deepEqual(delivered, [[chat("2"), chat("3")]]);
});

test("a cursor read that answers no row starts the bus at 0", async (t) => {
    const db = fakeOutboxDb();
    db.onQuery = (sql) => (/MAX\(id\)/.test(sql) ? [] : undefined);
    const { bus } = await started(t, { db });
    assert.equal(bus.cursor, 0);
});

test("starting a bus that is running does nothing more and answers the bus", async (t) => {
    const { db, bus } = await started(t);
    assert.equal(await bus.start(), bus);
    assert.equal(db.queries.filter((q) => /MAX\(id\)/.test(q.sql)).length, 1);
});

test("a started bus polls every intervalMs, on its own table, until it is stopped", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const db = fakeOutboxDb();
    const delivered = [];
    const bus = createOutboxBus({ db, targets: { chat }, table: "OrderEvents" });
    bus.subscribe((list) => { delivered.push(list); });
    await bus.start();
    db.insert("chat", 1);
    t.mock.timers.tick(24);
    await settle();
    assert.equal(db.batchReads().length, 0);
    t.mock.timers.tick(1);
    await settle();
    assert.deepEqual(delivered, [[chat("1")]], "every 25 ms by default");
    assert.match(db.batchReads()[0].sql, /FROM OrderEvents WHERE id > \?/);
    for (let i = 0; i < 4; i++) {
        t.mock.timers.tick(25);
        await settle();
    }
    assert.equal(db.batchReads().length, 5);
    assert.equal(bus.stats().polls, 5);
    await bus.stop();
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(db.batchReads().length, 5);
});

test("a stopped bus polls nothing when asked", async (t) => {
    const { db, bus } = await started(t);
    await bus.stop();
    const before = db.queries.length;
    await bus.poll();
    assert.equal(db.queries.length, before);
});

test("a start whose cursor read fails rejects with it, and a later start polls",
    async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
        const db = fakeOutboxDb();
        const bus = createOutboxBus({ db, targets: { chat } });
        t.after(() => bus.stop());
        const failure = new Error("Table 'app.change_events' doesn't exist");
        db.onQuery = () => { throw failure; };
        await assert.rejects(bus.start(), (error) => error === failure);
        db.onQuery = null;
        await bus.poll();
        assert.equal(db.batchReads().length, 0, "left stopped: it does not poll");
        await bus.start();
        t.mock.timers.tick(25);
        await settle();
        assert.equal(db.batchReads().length, 1, "the second start polls");
    });

test("a stop that comes while start reads the cursor leaves no interval behind, and a later start sets only its own", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const db = fakeOutboxDb();
    const bus = createOutboxBus({ db, targets: { chat } });
    t.after(() => bus.stop());
    const held = gate();
    db.onQuery = (sql) => (/MAX\(id\)/.test(sql) ? held.promise.then(() => undefined) : undefined);
    const starting = bus.start();
    await settle();
    await bus.stop();
    held.open();
    assert.equal(await starting, bus);
    db.onQuery = null;
    t.mock.timers.tick(10);
    await settle();
    await bus.start();
    t.mock.timers.tick(15);
    await settle();
    assert.equal(db.batchReads().length, 0, "the stopped start set no interval");
    t.mock.timers.tick(10);
    await settle();
    assert.equal(db.batchReads().length, 1, "the later start's interval");
});

test("a start that resolves after a stop and a newer start sets nothing: one interval, the newer start's cursor, and stop clears it", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const db = fakeOutboxDb();
    db.insert("chat", 1);
    db.insert("chat", 2);
    const delivered = [];
    const bus = createOutboxBus({ db, targets: { chat } });
    bus.subscribe((list) => { delivered.push(list); });
    t.after(() => bus.stop());
    const held = gate();
    db.onQuery = (sql) => (/MAX\(id\)/.test(sql) ? held.promise.then(() => [{ id: 0 }]) : undefined);
    const first = bus.start();
    await settle();
    await bus.stop();
    db.onQuery = null;
    await bus.start();                       // the newer start, at 0 ms
    t.mock.timers.tick(10);
    held.open();                             // the first start's read answers now, late, and lower
    assert.equal(await first, bus);
    assert.equal(bus.cursor, 2, "the first start's answer is not the cursor");
    t.mock.timers.tick(15);
    await settle();
    assert.equal(db.batchReads().length, 1, "the newer start's interval, at 25 ms");
    t.mock.timers.tick(10);
    await settle();
    assert.equal(db.batchReads().length, 1, "and no other, at 35 ms");
    assert.deepEqual(delivered, [], "nothing replayed");
    await bus.stop();
    t.mock.timers.tick(5);
    await bus.start();                       // at 40 ms: its interval alone fires at 65 ms
    t.mock.timers.tick(10);
    await settle();
    assert.equal(db.batchReads().length, 1, "nothing is left from before stop, at 50 ms");
    t.mock.timers.tick(15);
    await settle();
    assert.equal(db.batchReads().length, 2, "the last start's interval, at 65 ms");
});

test("a start overtaken by a stop and a newer start that then fails rejects, and leaves the newer start running", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const db = fakeOutboxDb();
    const bus = createOutboxBus({ db, targets: { chat } });
    t.after(() => bus.stop());
    const held = gate();
    const failure = new Error("Lost connection to MySQL server during query");
    db.onQuery = (sql) => (/MAX\(id\)/.test(sql) ? held.promise.then(() => { throw failure; }) : undefined);
    const first = bus.start();
    await settle();
    await bus.stop();
    db.onQuery = null;
    await bus.start();
    held.open();
    await assert.rejects(first, (error) => error === failure);
    t.mock.timers.tick(25);
    await settle();
    assert.equal(db.batchReads().length, 1, "the newer start still polls");
});

// ---- from rows to targets -----------------------------------------------------------------------

test("each row is mapped through the registry, once per entity and id in a poll", async (t) => {
    const targets = { chat, lot: (id) => [{ name: "lot", args: [id] }, "$pages"], ghost: () => undefined };
    const { db, bus, delivered } = await started(t, { targets });
    db.insert("chat", 7);
    db.insert("chat", 7);
    db.insert("lot", "A-1");
    db.insert("ghost", 1);
    db.insert("nobody", 1);
    await bus.poll();
    assert.deepEqual(delivered, [[chat("7"), { name: "lot", args: ["A-1"] }, "$pages"]]);
    assert.equal(bus.stats().events, 5);
    assert.equal(bus.stats().delivered, 3);
});

test("the registry is given the entity id as text", async (t) => {
    const seen = [];
    const { db, bus } = await started(t, { targets: { chat: (id) => { seen.push(id); return chat(id); } } });
    db.onQuery = (sql) => (/WHERE id > \?/.test(sql) ? [{ id: 1, entity: "chat", entity_id: 42, payload: null, created_at: new Date(T0) }] : undefined);
    await bus.poll();
    assert.deepEqual(seen, ["42"]);
});

test("an entity named like an Object.prototype member maps to nothing, unless the registry has it as its own", async (t) => {
    const named = (id) => ({ name: "named", args: [id] });
    const { db, bus, delivered, errors } = await started(t, { targets: { chat, toString: named } });
    for (const entity of ["constructor", "valueOf", "hasOwnProperty", "__proto__", "toString"]) db.insert(entity, 1);
    db.insert("chat", 2);
    await bus.poll();
    assert.deepEqual(delivered, [[named("1"), chat("2")]]);
    assert.deepEqual(errors, []);
    assert.equal(bus.stats().errors, 0);
});

test("a bus with no registry delivers nothing for an entity's row, and still reads it", async (t) => {
    const { db, bus, delivered } = await started(t, { targets: undefined });
    db.insert("chat", 1);
    await bus.poll();
    assert.deepEqual(delivered, []);
    assert.equal(bus.cursor, 1);
});

test("a published row delivers its targets as written, the bus skips its own echo, and a bare list is a list", async (t) => {
    const { db, bus, delivered } = await started(t, { origin: "me" });
    db.insert("$targets", "-", { payload: JSON.stringify({ o: "other", t: [chat(1), "$pages"] }) });
    await bus.publish([chat(2)]);
    db.insert("$targets", "-", { payload: JSON.stringify([{ name: "legacy" }]) });
    db.insert("$targets", "-", { payload: JSON.stringify({ o: "other", t: [chat(1), "$pages"] }) });
    await bus.poll();
    assert.deepEqual(delivered, [[chat(1), "$pages", { name: "legacy" }, chat(1), "$pages"]], "published rows are not collapsed");
    assert.equal(bus.stats().ownEchoes, 1);
});

test("a payload that cannot be read counts as an error, and the rest of the poll is still delivered", async (t) => {
    const { db, bus, delivered } = await started(t);
    db.insert("$targets", "-", { payload: "{not json" });
    db.insert("$targets", "-", { payload: "null" });
    db.insert("chat", 9);
    await bus.poll();
    assert.deepEqual(delivered, [[chat("9")]]);
    assert.equal(bus.stats().errors, 2);
    assert.equal(bus.cursor, 3);
});

test("with no subscriber nothing is delivered, and unsubscribing stops delivery", async (t) => {
    const db = fakeOutboxDb();
    const bus = createOutboxBus({ db, targets: { chat }, intervalMs: 600_000 });
    t.after(() => bus.stop());
    await bus.start();
    db.insert("chat", 1);
    await bus.poll();
    assert.equal(bus.stats().delivered, 0);
    assert.equal(bus.stats().events, 1);
    const got = [];
    const unsubscribe = bus.subscribe((list) => got.push(list));
    db.insert("chat", 2);
    await bus.poll();
    unsubscribe();
    db.insert("chat", 3);
    await bus.poll();
    assert.deepEqual(got, [[chat("2")]]);
});

// ---- ids committed out of order -----------------------------------------------------------------

test("an id jumped over is re-checked by id until its transaction commits, and then delivered once", async (t) => {
    const { db, bus, delivered } = await started(t);
    const slow = db.reserve("chat", "slow");
    db.insert("chat", "fast");
    const later = db.reserve("chat", "later");
    db.insert("chat", "last");
    await bus.poll();
    assert.deepEqual(delivered, [[chat("fast"), chat("last")]]);
    assert.equal(bus.stats().gaps, 2);
    assert.equal(db.gapReads().length, 0);
    await bus.poll();
    assert.deepEqual(db.gapReads().at(-1), {
        sql: "SELECT id, entity, entity_id, payload, created_at FROM change_events WHERE id IN (?,?)",
        params: [slow.id, later.id],
    });
    db.commit(later.id);
    await bus.poll();
    assert.deepEqual(delivered.at(-1), [chat("later")]);
    assert.equal(bus.stats().gaps, 1);
    await bus.poll();
    assert.deepEqual(db.gapReads().at(-1).params, [slow.id], "only the id still missing is asked about");
    db.commit(slow.id);
    await bus.poll();
    assert.deepEqual(delivered.at(-1), [chat("slow")]);
    assert.equal(bus.stats().gaps, 0);
    await bus.poll();
    assert.equal(delivered.length, 3, "each delivered once");
});

test("an id that never commits stops being re-checked once it is older than the lookback", async (t) => {
    const { db, bus, clock } = await started(t, { lookbackMs: 5000 });
    const lost = db.reserve("chat", "rolled-back");
    db.insert("chat", "next");
    await bus.poll();
    clock.now += 5000;
    await bus.poll();
    assert.equal(bus.stats().gaps, 1);
    clock.now += 1;
    await bus.poll();
    assert.equal(bus.stats().gaps, 0);
    const checks = db.gapReads().length;
    db.commit(lost.id);
    await bus.poll();
    assert.equal(db.gapReads().length, checks);
});

test("a jump of more than 1000 ids is not taken for transactions in flight", async (t) => {
    const near = await started(t, { db: fakeOutboxDb({ start: 1000 }) }, { from: 0 });
    near.db.insert("chat", "x");
    await near.bus.poll();
    assert.equal(near.bus.stats().gaps, 1000);
    const far = await started(t, { db: fakeOutboxDb({ start: 1001 }) }, { from: 0 });
    far.db.insert("chat", "y");
    await far.bus.poll();
    assert.equal(far.bus.stats().gaps, 0);
});

test("a row read again after the cursor was moved back counts as a duplicate and is not delivered again", async (t) => {
    const { db, bus, delivered } = await started(t);
    db.insert("chat", 1);
    db.insert("chat", 2);
    await bus.poll();
    await bus.stop();
    await bus.start({ from: 0 });
    await bus.poll();
    assert.deepEqual(delivered, [[chat("1"), chat("2")]]);
    assert.equal(bus.stats().duplicates, 2);
});

test("a row is remembered for twice the lookback, then forgotten", async (t) => {
    const { db, bus, clock } = await started(t, { lookbackMs: 1000 });
    db.insert("chat", 1);
    await bus.poll();
    clock.now += 2000;
    await bus.poll();
    assert.equal(bus.stats().tracked, 1);
    clock.now += 1;
    await bus.poll();
    assert.equal(bus.stats().tracked, 0);
});

// ---- a full batch -----------------------------------------------------------------------------------

test("a full batch is followed by the next poll, until one comes back short", async (t) => {
    const { db, bus, delivered } = await started(t, { batchSize: 2 });
    for (const id of [1, 2, 3, 4, 5]) db.insert("chat", id);
    await bus.poll();
    await settle();
    assert.deepEqual(db.batchReads().map((q) => q.params), [[0, 2], [2, 2], [4, 2]]);
    assert.deepEqual(delivered, [[chat("1"), chat("2")], [chat("3"), chat("4")], [chat("5")]]);
});

test("the poll after a full batch waits for its delivery, so two never run at once", async (t) => {
    const { db, bus } = await started(t, { batchSize: 1 });
    for (const id of [1, 2, 3]) db.insert("chat", id);
    let running = 0;
    let most = 0;
    const held = gate();
    let first = true;
    bus.subscribe(async () => {
        running++;
        most = Math.max(most, running);
        if (first) { first = false; await held.promise; }
        running--;
    });
    const polling = bus.poll();
    await settle();
    assert.equal(db.batchReads().length, 1, "no next poll while the first still delivers");
    await bus.poll();
    assert.equal(db.batchReads().length, 1, "nor one asked for by hand");
    held.open();
    await polling;
    await settle();
    assert.equal(db.batchReads().length, 4, "then on through the table");
    assert.equal(most, 1);
});

test("a full batch is not followed by another poll once the bus is stopped", async (t) => {
    const { db, bus } = await started(t, { batchSize: 1 });
    db.insert("chat", 1);
    db.insert("chat", 2);
    const held = gate();
    bus.subscribe(() => held.promise);
    const polling = bus.poll();
    await settle();
    let done = false;
    const stopping = bus.stop().then(() => { done = true; });
    await settle();
    assert.equal(done, false, "stop waits for the poll in flight");
    held.open();
    await stopping;
    await polling;
    await settle();
    assert.equal(db.batchReads().length, 1);
});

// ---- lag --------------------------------------------------------------------------------------------

test("lagMs is how long ago the oldest new row was written, ignores a time it cannot read, and is never below zero", async (t) => {
    const { db, bus } = await started(t);
    db.insert("chat", 1, { at: new Date(T0 - 40) });
    db.insert("chat", 2, { at: new Date(T0 - 250) });
    await bus.poll();
    assert.equal(bus.stats().lagMs, 250);
    db.insert("chat", 3, { at: "not a time" });
    await bus.poll();
    assert.equal(bus.stats().lagMs, 0);
    db.insert("chat", 4, { at: new Date(T0 + 60_000) });
    await bus.poll();
    assert.equal(bus.stats().lagMs, 0);
});

// ---- a failed poll ------------------------------------------------------------------------------

test("a failed poll counts with its time in stats(), its words go to onError alone, and the next poll works", async (t) => {
    const { db, bus, clock, errors, delivered } = await started(t);
    const failure = new Error("Access denied for user 'app'@'10.0.0.7' (using password: YES)");
    db.onQuery = (sql) => { if (/WHERE id > \?/.test(sql)) throw failure; };
    db.insert("chat", 1);
    clock.now = T0 + 77;
    await bus.poll();
    assert.deepEqual(errors, [failure]);
    const stats = bus.stats();
    assert.equal(stats.errors, 1);
    assert.equal(stats.lastErrorAt, T0 + 77);
    assert.doesNotMatch(JSON.stringify(stats), /Access denied|10\.0\.0\.7|password/);
    db.onQuery = null;
    await bus.poll();
    assert.deepEqual(delivered, [[chat("1")]]);
});

test("a subscriber that throws counts as a failed poll and reaches onError", async (t) => {
    const { db, bus, errors } = await started(t);
    const failure = new Error("dispatcher closed");
    bus.subscribe(() => { throw failure; });
    db.insert("chat", 1);
    await bus.poll();
    assert.deepEqual(errors, [failure]);
    assert.equal(bus.stats().lastErrorAt, T0);
});

test("a failed poll with no onError is counted and does not throw", async (t) => {
    const { db, bus } = await started(t, { onError: null });
    db.onQuery = () => { throw new Error("gone"); };
    await bus.poll();
    assert.equal(bus.stats().errors, 1);
});

test("stats() says what the bus did, with its cursor, the ids it remembers and the gaps it re-checks", async (t) => {
    const { db, bus } = await started(t);
    db.reserve("chat", 1);
    db.insert("chat", 2);
    await bus.poll();
    assert.deepEqual(bus.stats(), {
        polls: 1, events: 1, duplicates: 0, ownEchoes: 0, delivered: 1, errors: 0, lastErrorAt: null, lagMs: 0,
        cursor: 2, tracked: 1, gaps: 1,
    });
});
