// The Postgres change bus's own LISTEN connection: opened on start and let go on stop, a start that
// fails left startable again, a client whose LISTEN fails released with the error (which destroys
// it), a lost connection opened again with a doubling wait up to reconnectMaxMs and read from at
// once, and stop ending all of it at whatever point it comes. Timers are the test's (mock.timers).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgOutboxBus } from "juris-kit/server/bus/pg-outbox.js";
import { fakePgPool, settle, gate } from "../support/pg-outbox-fake-pg.mjs";

const T0 = 1_000_000;
const chat = (id) => ({ name: "chat", args: [id] });

// A bus on the test's timers (setTimeout, setInterval and Date), with its deliveries and the errors
// handed to onError recorded.
function onMockTimers(t, options = {}) {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: T0 });
    const pool = options.pool ?? fakePgPool();
    const delivered = [];
    const errors = [];
    const bus = createPgOutboxBus({ targets: { chat }, sweepMs: 600_000, onError: (error) => errors.push(error), ...options, pool });
    bus.subscribe((list) => { delivered.push(list); });
    t.after(() => bus.stop());
    return { pool, bus, delivered, errors };
}

// Ticks `ms - 1` and checks no connection was opened, then 1 more and checks one was.
async function connectsAfter(t, pool, ms) {
    const before = pool.connects;
    t.mock.timers.tick(ms - 1);
    await settle();
    assert.equal(pool.connects, before, `not before ${ms}ms`);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(pool.connects, before + 1, `at ${ms}ms`);
}

// ---- opened and let go ------------------------------------------------------------------------------

test("start checks out one connection of its own and LISTENs on the channel", async (t) => {
    const { pool, bus } = onMockTimers(t, { channel: "orders_bell" });
    await bus.start();
    assert.equal(pool.connects, 1);
    assert.deepEqual(pool.clients[0].queries, ["LISTEN orders_bell"]);
    assert.deepEqual(pool.clients[0].released, [], "kept checked out while the bus runs");
    assert.equal(pool.queries.some((q) => /LISTEN/.test(q.sql)), false, "never on a pooled query");
});

test("a notification on the bus's channel reads; one on any other channel is ignored", async (t) => {
    const { pool, bus, delivered } = onMockTimers(t, { channel: "orders_bell" });
    await bus.start();
    pool.insert("chat", 1);
    pool.clients[0].emit("notification", { channel: "someone_else", payload: "1" });
    await settle();
    assert.equal(pool.batchReads().length, 0);
    assert.equal(bus.stats().notifies, 0);
    pool.notify("orders_bell", "1");
    await settle();
    assert.deepEqual(delivered, [[chat("1")]]);
    assert.equal(bus.stats().notifies, 1);
});

test("a commit's notification, as the trigger sends it, reaches the subscriber", async (t) => {
    const { pool, bus, delivered } = onMockTimers(t, { pool: fakePgPool({ trigger: true }) });
    await bus.start();
    pool.insert("chat", "a");
    await settle();
    assert.deepEqual(delivered, [[chat("a")]]);
});

test("stop UNLISTENs and hands the connection back to the pool, and the sweep ends", async (t) => {
    const { pool, bus } = onMockTimers(t, { sweepMs: 1000 });
    await bus.start();
    await bus.stop();
    assert.deepEqual(pool.clients[0].queries, ["LISTEN change_events", "UNLISTEN change_events"]);
    assert.deepEqual(pool.clients[0].released, [undefined], "released without an error: pooled again");
    t.mock.timers.tick(5000);
    await settle();
    assert.equal(pool.batchReads().length, 0);
    await bus.stop();
    assert.equal(pool.clients[0].released.length, 1, "a second stop lets go of nothing more");
});

test("stop resolves when UNLISTEN or release throws, and the bus can start again on a new connection", async (t) => {
    const { pool, bus } = onMockTimers(t);
    await bus.start();
    const [client] = pool.clients;
    client.query = async () => { throw new Error("Connection terminated"); };
    client.release = () => { throw new Error("Release called on client which has already been released"); };
    await bus.stop();
    await bus.start();
    assert.equal(pool.connects, 2, "a new connection for the new start");
    assert.deepEqual(pool.clients[1].queries, ["LISTEN change_events"]);
});

// ---- a start that fails ---------------------------------------------------------------------------

test("a start whose cursor read fails rejects with it, opens no connection, and can be tried again", async (t) => {
    const { pool, bus } = onMockTimers(t);
    const failure = new Error("relation \"change_events\" does not exist");
    pool.onQuery = () => { throw failure; };
    await assert.rejects(bus.start(), (error) => error === failure);
    assert.equal(pool.connects, 0);
    pool.onQuery = null;
    pool.insert("chat", 1);
    await bus.read();
    assert.equal(pool.batchReads().length, 0, "left stopped: it does not read");
    assert.equal(await bus.start(), bus);
    assert.equal(pool.connects, 1);
    assert.equal(bus.cursor, 1);
});

test("a start whose connection cannot be opened rejects, and a later start opens one", async (t) => {
    const { pool, bus } = onMockTimers(t);
    pool.failConnect = 1;
    await assert.rejects(bus.start(), { message: "connect ECONNREFUSED 10.0.0.5:5432" });
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(pool.connects, 1, "no reconnecting behind a failed start");
    await bus.start();
    assert.equal(pool.connects, 2);
    assert.deepEqual(pool.clients[0].queries, ["LISTEN change_events"]);
});

test("a client whose LISTEN fails is released with the error, so the pool destroys it, and start rejects", async (t) => {
    const { pool, bus } = onMockTimers(t);
    pool.failListen = 1;
    await assert.rejects(bus.start(), { message: "permission denied for LISTEN" });
    const [client] = pool.clients;
    assert.equal(client.released.length, 1);
    assert.ok(client.released[0] instanceof Error && client.released[0].message === "permission denied for LISTEN");
    await bus.start();
    assert.deepEqual(pool.clients[1].queries, ["LISTEN change_events"]);
    assert.deepEqual(pool.clients[1].released, []);
});

test("a LISTEN failure is still the start's error when releasing the client throws too", async (t) => {
    const { pool, bus } = onMockTimers(t);
    pool.failListen = 1;
    const connect = pool.connect;
    pool.connect = async () => {
        const client = await connect();
        client.release = () => { throw new Error("already released"); };
        return client;
    };
    await assert.rejects(bus.start(), { message: "permission denied for LISTEN" });
});

test("a connection lost while its LISTEN is in flight fails the start, and is not reopened behind it", async (t) => {
    const { pool, bus, errors } = onMockTimers(t, { reconnectMs: 100 });
    const held = gate();
    pool.listenGate = held.promise;
    const starting = bus.start();
    await settle();
    const [client] = pool.clients;
    client.emit("error", new Error("server closed the connection unexpectedly"));
    assert.deepEqual(client.released, [true], "released as broken");
    held.open();
    await assert.rejects(starting, { message: "the LISTEN connection was lost while it was being opened" });
    assert.equal(client.released.length, 1, "released once");
    assert.equal(bus.stats().errors, 1);
    t.mock.timers.tick(10_000);
    await settle();
    assert.equal(pool.connects, 1, "its caller heard: nothing reopens it");
    assert.deepEqual(errors, [], "the start's rejection carries it, not onError");
    await bus.start();
    assert.equal(pool.connects, 2);
});

test("a connection lost while a LISTEN that then fails was in flight rejects with the LISTEN's error, released once", async (t) => {
    const { pool, bus } = onMockTimers(t);
    const held = gate();
    pool.listenGate = held.promise;
    pool.failListen = 1;
    const starting = bus.start();
    await settle();
    const [client] = pool.clients;
    client.emit("error", new Error("terminated"));
    held.open();
    await assert.rejects(starting, { message: "permission denied for LISTEN" });
    assert.deepEqual(client.released, [true]);
});

test("a stop that comes while start is opening the connection lets that connection go and starts nothing", async (t) => {
    const { pool, bus } = onMockTimers(t, { sweepMs: 1000 });
    const held = gate();
    pool.connectGate = held.promise;
    const starting = bus.start();
    await settle();
    await bus.stop();
    held.open();
    assert.equal(await starting, bus);
    assert.deepEqual(pool.clients[0].queries, ["LISTEN change_events", "UNLISTEN change_events"]);
    assert.deepEqual(pool.clients[0].released, [undefined]);
    pool.insert("chat", 1);
    t.mock.timers.tick(5000);
    await settle();
    assert.equal(pool.batchReads().length, 0, "no sweep");
    await bus.start();
    assert.equal(pool.connects, 2, "and it can be started");
});

test("a start that resolves after a stop and a newer start lets its connection go and sets nothing: one listener, one sweep, and stop clears both", async (t) => {
    const { pool, bus } = onMockTimers(t, { sweepMs: 1000 });
    const held = gate();
    pool.listenGate = held.promise;
    const first = bus.start();
    await settle();
    await bus.stop();
    await bus.start();                       // the newer start, at 0 ms, on a second connection
    t.mock.timers.tick(300);
    held.open();                             // the first start's LISTEN answers now, late
    assert.equal(await first, bus);
    const [older, newer] = pool.clients;
    assert.deepEqual(older.queries, ["LISTEN change_events", "UNLISTEN change_events"]);
    assert.deepEqual(older.released, [undefined]);
    assert.deepEqual(pool.listeners(), [newer]);
    t.mock.timers.tick(700);
    await settle();
    assert.equal(pool.batchReads().length, 1, "the newer start's sweep, at 1000 ms");
    t.mock.timers.tick(300);
    await settle();
    assert.equal(pool.batchReads().length, 1, "and no other, at 1300 ms");
    pool.notify();
    await settle();
    assert.equal(pool.batchReads().length, 2, "the newer connection is the one listening");
    await bus.stop();
    assert.deepEqual(pool.listeners(), []);
    assert.deepEqual(newer.released, [undefined]);
    t.mock.timers.tick(100);
    await bus.start();                       // at 1400 ms: its sweep alone, at 2400 ms
    t.mock.timers.tick(600);
    await settle();
    assert.equal(pool.batchReads().length, 2, "nothing is left from before stop, at 2000 ms");
    t.mock.timers.tick(400);
    await settle();
    assert.equal(pool.batchReads().length, 3, "the last start's sweep, at 2400 ms");
});

test("a start overtaken by a stop and a newer start that then fails rejects, and leaves the newer start running", async (t) => {
    const { pool, bus } = onMockTimers(t, { sweepMs: 1000 });
    const held = gate();
    const failure = new Error("Connection terminated unexpectedly");
    pool.onQuery = (sql) => (/MAX\(id\)/.test(sql) ? held.promise.then(() => { throw failure; }) : undefined);
    const first = bus.start();
    await settle();
    await bus.stop();
    pool.onQuery = null;
    await bus.start();
    held.open();
    await assert.rejects(first, (error) => error === failure);
    assert.equal(pool.listeners().length, 1, "the newer start's connection is kept");
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(pool.batchReads().length, 1, "and its sweep reads");
});

// ---- a lost connection --------------------------------------------------------------------------

test("a lost LISTEN connection is released as broken, opened again after reconnectMs, and read from at once", async (t) => {
    const { pool, bus, delivered } = onMockTimers(t);
    await bus.start();
    const [first] = pool.clients;
    first.emit("error", new Error("Connection terminated unexpectedly"));
    assert.deepEqual(first.released, [true]);
    assert.equal(bus.stats().errors, 1);
    pool.insert("chat", "while-down");
    await connectsAfter(t, pool, 500);
    assert.deepEqual(pool.clients[1].queries, ["LISTEN change_events"]);
    assert.deepEqual(delivered, [[chat("while-down")]], "what was published while it was down is read");
    pool.insert("chat", "after");
    pool.notify();
    await settle();
    assert.deepEqual(delivered.at(-1), [chat("after")], "the new connection is the doorbell now");
});

test("a lost connection that reports more than one error is reopened once", async (t) => {
    const { pool, bus } = onMockTimers(t, { reconnectMs: 50 });
    await bus.start();
    const [first] = pool.clients;
    first.emit("error", new Error("a"));
    first.emit("error", new Error("b"));
    assert.deepEqual(first.released, [true]);
    assert.equal(bus.stats().errors, 1);
    t.mock.timers.tick(10_000);
    await settle();
    assert.equal(pool.connects, 2);
});

test("a lost connection whose release throws is still reopened", async (t) => {
    const { pool, bus } = onMockTimers(t, { reconnectMs: 50 });
    await bus.start();
    pool.clients[0].release = () => { throw new Error("already released"); };
    pool.clients[0].emit("error", new Error("terminated"));
    await connectsAfter(t, pool, 50);
    assert.deepEqual(pool.clients[1].queries, ["LISTEN change_events"]);
});

test("reopening is tried until it works, the wait doubling up to reconnectMaxMs, each failure to onError", async (t) => {
    const { pool, bus, errors } = onMockTimers(t, { reconnectMs: 100, reconnectMaxMs: 350 });
    await bus.start();
    pool.failConnect = 3;
    pool.failListen = 1;
    pool.clients[0].emit("error", new Error("terminated"));
    await connectsAfter(t, pool, 100);
    assert.equal(bus.stats().lastErrorAt, T0 + 100);
    await connectsAfter(t, pool, 200);
    await connectsAfter(t, pool, 350);
    await connectsAfter(t, pool, 350);     // this one connects, and its LISTEN fails
    assert.equal(pool.clients.length, 2);
    assert.ok(pool.clients[1].released[0] instanceof Error, "the client whose LISTEN failed is destroyed");
    await connectsAfter(t, pool, 350);
    assert.deepEqual(pool.clients[2].queries, ["LISTEN change_events"]);
    assert.deepEqual(pool.clients[2].released, []);
    assert.deepEqual(errors.map((e) => e.message), [
        "connect ECONNREFUSED 10.0.0.5:5432", "connect ECONNREFUSED 10.0.0.5:5432", "connect ECONNREFUSED 10.0.0.5:5432",
        "permission denied for LISTEN",
    ]);
    const stats = bus.stats();
    assert.equal(stats.errors, 1 + 4, "the loss and each failed attempt");
    assert.equal(stats.lastErrorAt, T0 + 100 + 200 + 350 + 350);
    assert.doesNotMatch(JSON.stringify(stats), /ECONNREFUSED|permission/);
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(pool.connects, 6, "back: no more attempts");
});

test("reopening keeps trying when there is no onError to tell", async (t) => {
    const { pool, bus } = onMockTimers(t, { reconnectMs: 10, onError: null });
    await bus.start();
    pool.failConnect = 1;
    pool.clients[0].emit("error", new Error("terminated"));
    await connectsAfter(t, pool, 10);
    await connectsAfter(t, pool, 20);
    assert.deepEqual(pool.clients[1].queries, ["LISTEN change_events"]);
});

test("stop ends the attempts to reopen a lost connection", async (t) => {
    const { pool, bus } = onMockTimers(t, { reconnectMs: 100 });
    await bus.start();
    pool.failConnect = Infinity;
    pool.clients[0].emit("error", new Error("terminated"));
    await connectsAfter(t, pool, 100);
    await bus.stop();
    t.mock.timers.tick(600_000);
    await settle();
    assert.equal(pool.connects, 2);
});

test("a connection reopened after stop came is let go, not listened on, and nothing is read", async (t) => {
    const { pool, bus } = onMockTimers(t, { reconnectMs: 100 });
    await bus.start();
    pool.clients[0].emit("error", new Error("terminated"));
    const held = gate();
    pool.connectGate = held.promise;
    t.mock.timers.tick(100);
    await settle();
    assert.equal(pool.connects, 2, "the attempt is under way");
    await bus.stop();
    held.open();
    await settle();
    assert.deepEqual(pool.clients[1].queries, ["LISTEN change_events", "UNLISTEN change_events"]);
    assert.deepEqual(pool.clients[1].released, [undefined]);
    assert.equal(pool.batchReads().length, 0);
    t.mock.timers.tick(600_000);
    await settle();
    assert.equal(pool.connects, 2);
});

test("an attempt to reopen that fails after stop came schedules no other", async (t) => {
    const { pool, bus, errors } = onMockTimers(t, { reconnectMs: 100 });
    await bus.start();
    pool.clients[0].emit("error", new Error("terminated"));
    const held = gate();
    pool.connectGate = held.promise;
    pool.failConnect = 1;
    t.mock.timers.tick(100);
    await settle();
    await bus.stop();
    held.open();
    await settle();
    assert.equal(errors.length, 1, "the failed attempt is still told");
    t.mock.timers.tick(600_000);
    await settle();
    assert.equal(pool.connects, 2);
});

test("a connection reopened after a stop and a newer start is let go, never put over the newer start's: one listener, one sweep, and stop clears both", async (t) => {
    const { pool, bus } = onMockTimers(t, { reconnectMs: 100, sweepMs: 1000 });
    await bus.start();
    pool.clients[0].emit("error", new Error("terminated"));
    const held = gate();
    pool.connectGate = held.promise;
    t.mock.timers.tick(100);
    await settle();
    assert.equal(pool.connects, 2, "the attempt is under way, at 100 ms");
    await bus.stop();
    await bus.start();                       // the newer start, its sweep from 100 ms
    held.open();                             // the attempt's connection opens now
    await settle();
    const [, newer, reopened] = pool.clients;
    assert.deepEqual(reopened.queries, ["LISTEN change_events", "UNLISTEN change_events"]);
    assert.deepEqual(reopened.released, [undefined]);
    assert.deepEqual(pool.listeners(), [newer]);
    assert.equal(pool.batchReads().length, 0, "nothing is read for the attempt let go");
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(pool.batchReads().length, 1, "the newer start's sweep, at 1100 ms");
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(pool.batchReads().length, 2, "and only it, at 2100 ms");
    await bus.stop();
    assert.deepEqual(pool.listeners(), []);
    assert.deepEqual(newer.released, [undefined]);
    assert.deepEqual(reopened.released, [undefined], "let go once");
    t.mock.timers.tick(600_000);
    await settle();
    assert.equal(pool.connects, 3, "nothing reopens");
    assert.equal(pool.batchReads().length, 2, "nothing reads");
});

test("an attempt to reopen that fails after a stop and a newer start schedules no other over the newer start's connection", async (t) => {
    const { pool, bus, errors } = onMockTimers(t, { reconnectMs: 100 });
    await bus.start();
    pool.clients[0].emit("error", new Error("terminated"));
    const held = gate();
    pool.connectGate = held.promise;
    t.mock.timers.tick(100);
    await settle();
    await bus.stop();
    await bus.start();
    pool.failConnect = 1;                    // for the attempt, which connects once the gate opens
    held.open();
    await settle();
    assert.equal(errors.length, 1, "the failed attempt is still told");
    t.mock.timers.tick(600_000);
    await settle();
    assert.equal(pool.connects, 3, "no other attempt");
    assert.deepEqual(pool.listeners(), [pool.clients[1]]);
});

test("an error on a connection the bus let go is not counted, releases it no second time, and reopens nothing", async (t) => {
    const { pool, bus, errors } = onMockTimers(t, { reconnectMs: 10 });
    const held = gate();
    pool.listenGate = held.promise;
    const first = bus.start();
    await settle();
    await bus.stop();
    await bus.start();
    held.open();
    assert.equal(await first, bus, "the overtaken start let its connection go");
    await bus.stop();                        // and stop let the newer start's go
    const before = bus.stats().errors;
    for (const client of pool.clients) client.emit("error", new Error("terminated"));
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(bus.stats().errors, before);
    for (const client of pool.clients) assert.deepEqual(client.released, [undefined], "released once, when it was let go");
    assert.equal(pool.connects, 2, "nothing reconnects");
    assert.deepEqual(errors, []);
});

test("an error on the connection after stop let it go reopens nothing", async (t) => {
    const { pool, bus } = onMockTimers(t, { reconnectMs: 10 });
    await bus.start();
    await bus.stop();
    pool.clients[0].emit("error", new Error("terminated"));
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(pool.connects, 1);
});
