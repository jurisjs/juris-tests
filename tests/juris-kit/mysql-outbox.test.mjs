// The MariaDB/MySQL change bus's writing side and its checks: the names it shares with every
// instance, schemaFor and SCHEMA, emit and writeWithChanges inside a mutation's transaction, what
// createOutboxBus refuses, publish, prune (its cutoff on the database's NOW(3)), and the bus over
// both adapters of db.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createOutboxBus, schemaFor, SCHEMA, CHANGE_TABLE, PRUNE_AFTER_MS, emit, writeWithChanges,
} from "juris-kit/server/bus/mysql-outbox.js";
import { fromMysql2, fromMariadb } from "juris-kit/server/db.js";
import { fakeOutboxDb, mysql2Pool, mariadbPool } from "../support/mysql-outbox-fake-db.mjs";

const recordingTx = () => {
    const sent = [];
    return { sent, query: async (sql, params) => { sent.push({ sql, params }); return { affectedRows: 1 }; } };
};

// ---- the shared names -------------------------------------------------------------------------

test("the default table is change_events, and prune keeps an hour", () => {
    assert.equal(CHANGE_TABLE, "change_events");
    assert.equal(PRUNE_AFTER_MS, 60 * 60_000);
});

// ---- schemaFor --------------------------------------------------------------------------------

test("SCHEMA is schemaFor() with the default table", () => {
    assert.equal(SCHEMA, schemaFor());
    assert.equal(SCHEMA, schemaFor({}));
    assert.equal(SCHEMA, schemaFor({ table: "change_events" }));
});

test("the schema creates the InnoDB table with its key, its id scan and its time index", () => {
    const ddl = schemaFor();
    assert.match(ddl, /^CREATE TABLE IF NOT EXISTS change_events \(/);
    for (const column of [/id\s+bigint unsigned NOT NULL AUTO_INCREMENT/, /entity\s+varchar\(64\) NOT NULL/,
        /entity_id\s+varchar\(64\) NOT NULL/, /payload\s+text NULL/, /created_at datetime\(3\) NOT NULL DEFAULT current_timestamp\(3\)/]) {
        assert.match(ddl, column);
    }
    assert.match(ddl, /PRIMARY KEY \(id\)/);
    assert.match(ddl, /KEY change_events_scan \(id\)/);
    assert.match(ddl, /KEY change_events_time \(created_at\)/);
    assert.match(ddl, /\) ENGINE=InnoDB$/);
});

test("a schema for another table names its keys after it, capitals allowed", () => {
    const ddl = schemaFor({ table: "OrderEvents_2" });
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS OrderEvents_2 \(/);
    assert.match(ddl, /KEY OrderEvents_2_scan \(id\)/);
    assert.match(ddl, /KEY OrderEvents_2_time \(created_at\)/);
    assert.doesNotMatch(ddl, /change_events/);
});

test("schemaFor refuses a table that is not a plain SQL identifier", () => {
    for (const table of ["change-events", "change events", "1events", "x; DROP TABLE users", "`quoted`", "", "événements", 5, null, ["t"]]) {
        assert.throws(() => schemaFor({ table }), {
            name: "TypeError",
            message: `schemaFor: table must be a plain SQL identifier (letters, digits, _), not ${JSON.stringify(table)}`,
        }, JSON.stringify(table));
    }
});

// ---- emit and writeWithChanges ----------------------------------------------------------------

test("emit writes one change row inside the transaction it is given, its values as text", async () => {
    const tx = recordingTx();
    await emit(tx, "chat", 42);
    await emit(tx, "lot", "A-7", "OrderEvents");
    assert.deepEqual(tx.sent, [
        { sql: "INSERT INTO change_events (entity, entity_id) VALUES (?, ?)", params: ["chat", "42"] },
        { sql: "INSERT INTO OrderEvents (entity, entity_id) VALUES (?, ?)", params: ["lot", "A-7"] },
    ]);
});

test("writeWithChanges emits each change after the mutation on the same connection, and answers its value", async () => {
    const calls = [];
    const conn = {
        beginTransaction: async () => { calls.push("BEGIN"); },
        query: async (sql, params) => { calls.push([sql, params]); return [{ affectedRows: 1 }, undefined]; },
        commit: async () => { calls.push("COMMIT"); },
        rollback: async () => { calls.push("ROLLBACK"); },
        release: () => calls.push("release"),
        destroy: () => calls.push("destroy"),
    };
    const db = fromMysql2({ getConnection: async () => conn });
    const value = await writeWithChanges(db, async (tx) => {
        await tx.query("INSERT INTO chat_messages (chat_id, body) VALUES (?, ?)", [7, "hi"]);
        return { changes: [["chat", 7], ["inbox", "u1"]], value: { ok: true } };
    });
    assert.deepEqual(value, { ok: true });
    assert.deepEqual(calls, [
        "BEGIN",
        ["INSERT INTO chat_messages (chat_id, body) VALUES (?, ?)", [7, "hi"]],
        ["INSERT INTO change_events (entity, entity_id) VALUES (?, ?)", ["chat", "7"]],
        ["INSERT INTO change_events (entity, entity_id) VALUES (?, ?)", ["inbox", "u1"]],
        "COMMIT",
        "release",
    ]);
});

test("writeWithChanges takes a bare list of changes and then answers nothing, on the table it is given", async () => {
    const tx = recordingTx();
    const db = { transaction: (fn) => fn(tx) };
    assert.equal(await writeWithChanges(db, async () => [["chat", 1]], "OrderEvents"), undefined);
    assert.deepEqual(tx.sent, [{ sql: "INSERT INTO OrderEvents (entity, entity_id) VALUES (?, ?)", params: ["chat", "1"] }]);
});

test("writeWithChanges emits nothing for a mutation that names no changes", async () => {
    const tx = recordingTx();
    const db = { transaction: (fn) => fn(tx) };
    assert.equal(await writeWithChanges(db, async () => undefined), undefined);
    assert.equal(await writeWithChanges(db, async () => ({ value: "v" })), "v");
    assert.deepEqual(tx.sent, []);
});

test("a mutation that throws inside writeWithChanges emits nothing, and its transaction is rolled back", async () => {
    const calls = [];
    const conn = {
        beginTransaction: async () => { calls.push("BEGIN"); },
        query: async (sql) => { calls.push(sql); return [[], []]; },
        commit: async () => { calls.push("COMMIT"); },
        rollback: async () => { calls.push("ROLLBACK"); },
        release: () => calls.push("release"),
        destroy: () => calls.push("destroy"),
    };
    const failure = new Error("Duplicate entry");
    await assert.rejects(writeWithChanges(fromMariadb({ getConnection: async () => conn }), async () => { throw failure; }), (e) => e === failure);
    assert.deepEqual(calls, ["BEGIN", "ROLLBACK", "release"]);
});

// ---- construction -------------------------------------------------------------------------------

test("a bus with no adapter is refused", () => {
    assert.throws(() => createOutboxBus({ targets: {} }), { name: "Error", message: "createOutboxBus: db adapter is required" });
});

// ---- publish ----------------------------------------------------------------------------------

test("publish writes the targets with this bus's origin as one row of the table", async () => {
    const db = fakeOutboxDb();
    const targets = [{ name: "chat", args: [7] }, "$pages"];
    await createOutboxBus({ db, origin: "instance-a" }).publish(targets);
    assert.deepEqual(db.queries, [{
        sql: "INSERT INTO change_events (entity, entity_id, payload) VALUES (?, ?, ?)",
        params: ["$targets", "-", JSON.stringify({ o: "instance-a", t: targets })],
    }]);
});

test("publish with no targets writes nothing", async () => {
    const db = fakeOutboxDb();
    const bus = createOutboxBus({ db });
    await bus.publish([]);
    await bus.publish(undefined);
    assert.equal(db.queries.length, 0);
});

test("each bus marks its rows with an origin of its own unless told one, on its own table", async () => {
    const db = fakeOutboxDb();
    await createOutboxBus({ db }).publish(["x"]);
    await createOutboxBus({ db, table: "OrderEvents" }).publish(["x"]);
    const [a, b] = db.queries.map((q) => JSON.parse(q.params[2]).o);
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(a, b);
    assert.equal(db.queries[1].sql, "INSERT INTO OrderEvents (entity, entity_id, payload) VALUES (?, ?, ?)");
});

// ---- prune ------------------------------------------------------------------------------------

test("prune deletes the rows older than an hour by the database's NOW(3), in microseconds, and answers how many", async () => {
    const db = fakeOutboxDb();
    assert.equal(await createOutboxBus({ db }).prune(), 4);
    assert.deepEqual(db.queries, [{
        sql: "DELETE FROM change_events WHERE created_at < NOW(3) - INTERVAL ? MICROSECOND",
        params: [3_600_000_000],
    }]);
});

test("prune takes its age, down to the lookback, rounded to a whole microsecond, on the bus's table", async () => {
    const db = fakeOutboxDb();
    const bus = createOutboxBus({ db, lookbackMs: 2000, table: "OrderEvents" });
    await bus.prune({ olderThanMs: 2000 });
    await bus.prune({ olderThanMs: 2000.0004 });
    await bus.prune({ olderThanMs: 2000.0006 });
    assert.deepEqual(db.queries.map((q) => q.params), [[2_000_000], [2_000_000], [2_000_001]]);
    assert.match(db.queries[0].sql, /^DELETE FROM OrderEvents WHERE/);
});

test("prune refuses an age under the lookback, or one that is not a finite number, and asks nothing", async () => {
    const db = fakeOutboxDb();
    const bus = createOutboxBus({ db, lookbackMs: 5000 });
    for (const olderThanMs of [4999, 0, -1, NaN, Infinity, "3600000", null]) {
        await assert.rejects(bus.prune({ olderThanMs }), {
            name: "RangeError",
            message: `prune: olderThanMs must be a number of milliseconds, no less than lookbackMs (5000), not ${olderThanMs}`,
        });
    }
    assert.equal(db.queries.length, 0);
});

test("prune answers the count as a number whatever the driver reports it as, and 0 when it reports none", async () => {
    const db = fakeOutboxDb();
    const bus = createOutboxBus({ db });
    db.onQuery = () => ({ affectedRows: 12n, insertId: 0n });
    assert.equal(await bus.prune(), 12);
    db.onQuery = () => ({});
    assert.equal(await bus.prune(), 0);
    db.onQuery = () => null;
    assert.equal(await bus.prune(), 0);
});

// ---- over the adapters --------------------------------------------------------------------------

for (const [label, adapt, driver] of [["mysql2", fromMysql2, mysql2Pool], ["mariadb", fromMariadb, mariadbPool]]) {
    test(`over ${label}: another instance's publish reaches this bus's subscriber, and prune answers the driver's count`, async (t) => {
        const table = fakeOutboxDb();
        const here = createOutboxBus({ db: adapt(driver(table)), targets: {}, intervalMs: 600_000, origin: "here" });
        const there = createOutboxBus({ db: adapt(driver(table)), targets: {}, intervalMs: 600_000, origin: "there" });
        t.after(() => Promise.all([here.stop(), there.stop()]));
        const delivered = [];
        here.subscribe((list) => { delivered.push(list); });
        await here.start();
        await there.publish([{ name: "chat", args: [1] }]);
        await here.publish([{ name: "chat", args: [2] }]);
        await here.poll();
        assert.deepEqual(delivered, [[{ name: "chat", args: [1] }]], "its own row is skipped");
        assert.equal(here.cursor, 2);
        assert.equal(await here.prune(), 4);
    });
}
