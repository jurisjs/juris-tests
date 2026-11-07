// The Postgres change bus's writing side and its checks: the names it shares with every instance,
// schemaFor and SCHEMA, emit and writeWithChanges inside a mutation's transaction, what
// createPgOutboxBus refuses at construction, publish, and prune.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createPgOutboxBus, schemaFor, SCHEMA, CHANGE_TABLE, CHANNEL, PRUNE_AFTER_MS, emit, writeWithChanges,
} from "juris-kit/server/bus/pg-outbox.js";
import { fromPg } from "juris-kit/server/db.js";
import { fakePgPool } from "../support/pg-outbox-fake-pg.mjs";

// A transaction-shaped recorder: every tx.query with its parameters.
const recordingTx = () => {
    const sent = [];
    return { sent, query: async (sql, params) => { sent.push({ sql, params }); return []; } };
};

// ---- the shared names -------------------------------------------------------------------------

test("the default table and channel are change_events, and prune keeps an hour", () => {
    assert.equal(CHANGE_TABLE, "change_events");
    assert.equal(CHANNEL, "change_events");
    assert.equal(PRUNE_AFTER_MS, 60 * 60_000);
});

// ---- schemaFor --------------------------------------------------------------------------------

test("SCHEMA is schemaFor() with the default names", () => {
    assert.equal(SCHEMA, schemaFor());
    assert.equal(SCHEMA, schemaFor({}));
    assert.equal(SCHEMA, schemaFor({ table: "change_events", channel: "change_events" }));
});

test("the schema creates the table, its time index, the notify function and the AFTER INSERT trigger", () => {
    const ddl = schemaFor();
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS change_events \(/);
    for (const column of [/id\s+bigserial PRIMARY KEY/, /entity\s+varchar\(64\) NOT NULL/, /entity_id\s+varchar\(64\) NOT NULL/,
        /payload\s+text/, /created_at timestamptz NOT NULL DEFAULT now\(\)/]) {
        assert.match(ddl, column);
    }
    assert.match(ddl, /CREATE INDEX IF NOT EXISTS change_events_time ON change_events \(created_at\);/);
    assert.match(ddl, /CREATE OR REPLACE FUNCTION change_events_notify\(\) RETURNS trigger/);
    assert.match(ddl, /PERFORM pg_notify\('change_events', NEW\.id::text\);/);
    assert.match(ddl, /DROP TRIGGER IF EXISTS change_events_notify_trigger ON change_events;/);
    assert.match(ddl, /CREATE TRIGGER change_events_notify_trigger\s+AFTER INSERT ON change_events\s+FOR EACH ROW EXECUTE FUNCTION change_events_notify\(\);/);
});

test("a schema given only a table names everything after it and notifies on the table's own name", () => {
    const ddl = schemaFor({ table: "orders_outbox" });
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS orders_outbox \(/);
    assert.match(ddl, /orders_outbox_time ON orders_outbox/);
    assert.match(ddl, /FUNCTION orders_outbox_notify\(\)/);
    assert.match(ddl, /pg_notify\('orders_outbox', NEW\.id::text\)/);
    assert.match(ddl, /CREATE TRIGGER orders_outbox_notify_trigger/);
    assert.doesNotMatch(ddl, /change_events/, "two outboxes in one database share nothing");
});

test("a schema given a channel rings that channel and still names its objects after the table", () => {
    const ddl = schemaFor({ table: "orders_outbox", channel: "orders_bell" });
    assert.match(ddl, /pg_notify\('orders_bell', NEW\.id::text\)/);
    assert.match(ddl, /FUNCTION orders_outbox_notify\(\)/);
    assert.doesNotMatch(ddl, /orders_bell_/);
});

test("schemaFor refuses a table or channel that is not a lowercase SQL identifier", () => {
    const bad = ["Change_Events", "changeEvents", "1events", "change-events", "change events", "x; DROP TABLE users", "", "évènements", 42, null, ["change_events"]];
    for (const table of bad) {
        assert.throws(() => schemaFor({ table }), (error) => error instanceof TypeError
            && error.message.startsWith("schemaFor: table must be a lowercase SQL identifier")
            && error.message.endsWith(`not ${JSON.stringify(table)}`), `table ${JSON.stringify(table)}`);
    }
    for (const channel of bad) {
        assert.throws(() => schemaFor({ channel }), (error) => error instanceof TypeError
            && error.message.startsWith("schemaFor: channel must be a lowercase SQL identifier"), `channel ${JSON.stringify(channel)}`);
    }
});

test("schemaFor accepts any lowercase identifier, underscores and digits included", () => {
    for (const table of ["_outbox", "outbox_2", "a", "z9_"]) assert.match(schemaFor({ table }), new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
});

// ---- emit and writeWithChanges ----------------------------------------------------------------

test("emit writes one change row inside the transaction it is given, its values as text", async () => {
    const tx = recordingTx();
    await emit(tx, "chat", 42);
    await emit(tx, "lot", "A-7", "orders_outbox");
    assert.deepEqual(tx.sent, [
        { sql: "INSERT INTO change_events (entity, entity_id) VALUES ($1, $2)", params: ["chat", "42"] },
        { sql: "INSERT INTO orders_outbox (entity, entity_id) VALUES ($1, $2)", params: ["lot", "A-7"] },
    ]);
});

test("writeWithChanges emits each change after the mutation, in one transaction, and answers its value", async () => {
    const pool = fakePgPool();
    const db = fromPg(pool);
    const value = await writeWithChanges(db, async (tx) => {
        await tx.query("INSERT INTO chat_messages (chat_id, body) VALUES ($1, $2)", [7, "hi"]);
        return { changes: [["chat", 7], ["inbox", "u1"]], value: { ok: true } };
    });
    assert.deepEqual(value, { ok: true });
    assert.equal(pool.clients.length, 1, "one connection for the whole of it");
    assert.deepEqual(pool.clients[0].queries, [
        "BEGIN",
        "INSERT INTO chat_messages (chat_id, body) VALUES ($1, $2)",
        "INSERT INTO change_events (entity, entity_id) VALUES ($1, $2)",
        "INSERT INTO change_events (entity, entity_id) VALUES ($1, $2)",
        "COMMIT",
    ]);
    assert.deepEqual(pool.clients[0].released, [undefined], "the connection went back to the pool");
    assert.equal(pool.queries.length, 0, "nothing went outside the transaction");
});

test("writeWithChanges takes a bare list of changes, and then answers nothing", async () => {
    const tx = recordingTx();
    const db = { transaction: (fn) => fn(tx) };
    assert.equal(await writeWithChanges(db, async () => [["chat", 1], ["chat", 2]], "orders_outbox"), undefined);
    assert.deepEqual(tx.sent.map((q) => [q.sql, q.params]), [
        ["INSERT INTO orders_outbox (entity, entity_id) VALUES ($1, $2)", ["chat", "1"]],
        ["INSERT INTO orders_outbox (entity, entity_id) VALUES ($1, $2)", ["chat", "2"]],
    ]);
});

test("writeWithChanges emits nothing for a mutation that names no changes", async () => {
    const tx = recordingTx();
    const db = { transaction: (fn) => fn(tx) };
    assert.equal(await writeWithChanges(db, async () => undefined), undefined);
    assert.equal(await writeWithChanges(db, async () => null), undefined);
    assert.equal(await writeWithChanges(db, async () => ({ value: 5 })), 5);
    assert.deepEqual(tx.sent, []);
});

test("a mutation that throws inside writeWithChanges emits nothing and is rolled back with its error", async () => {
    const pool = fakePgPool();
    const failure = new Error("duplicate key");
    await assert.rejects(writeWithChanges(fromPg(pool), async () => { throw failure; }), (error) => error === failure);
    assert.deepEqual(pool.clients[0].queries, ["BEGIN", "ROLLBACK"]);
});

// ---- construction -------------------------------------------------------------------------------

test("a bus with no pool is refused", () => {
    assert.throws(() => createPgOutboxBus({ targets: {} }), { name: "Error", message: "createPgOutboxBus: pool is required" });
});

test("reconnectMs and reconnectMaxMs must be whole numbers of milliseconds from 1", () => {
    const pool = fakePgPool();
    for (const name of ["reconnectMs", "reconnectMaxMs"]) {
        for (const value of [0, -1, 1.5, NaN, Infinity, "500", null]) {
            assert.throws(() => createPgOutboxBus({ pool, [name]: value }),
                { name: "TypeError", message: `createPgOutboxBus: ${name} is a whole number of milliseconds from 1, not ${String(value)}` });
        }
        createPgOutboxBus({ pool, [name]: 1 });
    }
});

test("the bus refuses a table or channel that is not a lowercase SQL identifier, as schemaFor does", () => {
    const pool = fakePgPool();
    for (const name of ["Change_Events", "change-events", "", "x;y", 3]) {
        assert.throws(() => createPgOutboxBus({ pool, table: name }),
            (error) => error instanceof TypeError && error.message.startsWith("createPgOutboxBus: table must be a lowercase SQL identifier"));
        assert.throws(() => createPgOutboxBus({ pool, channel: name }),
            (error) => error instanceof TypeError && error.message.startsWith("createPgOutboxBus: channel must be a lowercase SQL identifier"));
    }
});

test("a bus given only a table listens on the table's own name, so it meets schemaFor({ table })", async (t) => {
    const pool = fakePgPool({ table: "orders_outbox" });
    const bus = createPgOutboxBus({ pool, table: "orders_outbox" });
    t.after(() => bus.stop());
    await bus.start();
    assert.deepEqual(pool.clients[0].queries, ["LISTEN orders_outbox"]);
    assert.match(schemaFor({ table: "orders_outbox" }), /pg_notify\('orders_outbox'/);
    assert.equal(pool.queries[0].sql, "SELECT COALESCE(MAX(id), 0) AS id FROM orders_outbox");
});

// ---- publish ----------------------------------------------------------------------------------

test("publish writes the targets with this bus's origin as one row of the table", async () => {
    const pool = fakePgPool();
    const bus = createPgOutboxBus({ pool, origin: "instance-a" });
    const targets = [{ name: "chat", args: [7] }, "$pages"];
    await bus.publish(targets);
    assert.equal(pool.queries.length, 1);
    const [{ sql, params }] = pool.queries;
    assert.equal(sql, "INSERT INTO change_events (entity, entity_id, payload) VALUES ($1, $2, $3)");
    assert.deepEqual(params, ["$targets", "-", JSON.stringify({ o: "instance-a", t: targets })]);
});

test("publish with no targets writes nothing", async () => {
    const pool = fakePgPool();
    const bus = createPgOutboxBus({ pool });
    await bus.publish([]);
    await bus.publish(undefined);
    await bus.publish(null);
    assert.equal(pool.queries.length, 0);
});

test("each bus marks its rows with an origin of its own unless told one", async () => {
    const pool = fakePgPool();
    await createPgOutboxBus({ pool }).publish(["x"]);
    await createPgOutboxBus({ pool }).publish(["x"]);
    const [a, b] = pool.queries.map((q) => JSON.parse(q.params[2]).o);
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(a, b);
});

test("publish writes to the bus's own table", async () => {
    const pool = fakePgPool();
    await createPgOutboxBus({ pool, table: "orders_outbox", origin: "o" }).publish(["t"]);
    assert.equal(pool.queries[0].sql, "INSERT INTO orders_outbox (entity, entity_id, payload) VALUES ($1, $2, $3)");
});

// ---- prune ------------------------------------------------------------------------------------

test("prune deletes the rows older than an hour by the database's clock, and answers how many", async () => {
    const pool = fakePgPool();
    const bus = createPgOutboxBus({ pool });
    assert.equal(await bus.prune(), 3);
    assert.deepEqual(pool.queries, [{
        sql: "DELETE FROM change_events WHERE created_at < now() - $1::double precision * interval '1 millisecond'",
        params: [PRUNE_AFTER_MS],
    }]);
});

test("prune takes its age, down to the bus's lookback, on the bus's table", async () => {
    const pool = fakePgPool();
    const bus = createPgOutboxBus({ pool, lookbackMs: 2000, table: "orders_outbox" });
    await bus.prune({ olderThanMs: 2000 });
    await bus.prune({ olderThanMs: 90_000.5 });
    assert.deepEqual(pool.queries.map((q) => q.params), [[2000], [90_000.5]]);
    assert.match(pool.queries[0].sql, /^DELETE FROM orders_outbox WHERE/);
});

test("prune refuses an age under the lookback, or one that is not a finite number, and asks nothing", async () => {
    const pool = fakePgPool();
    const bus = createPgOutboxBus({ pool, lookbackMs: 5000 });
    for (const olderThanMs of [4999, 0, -1, NaN, Infinity, "3600000", null]) {
        await assert.rejects(bus.prune({ olderThanMs }), {
            name: "RangeError",
            message: `prune: olderThanMs must be a number of milliseconds, no less than lookbackMs (5000), not ${olderThanMs}`,
        });
    }
    assert.equal(pool.queries.length, 0);
});

test("prune answers the driver's rowCount, whatever the bus has read", async () => {
    const pool = fakePgPool();
    pool.onQuery = (sql) => (/^DELETE/.test(sql) ? { rows: [], rowCount: 0 } : undefined);
    assert.equal(await createPgOutboxBus({ pool }).prune(), 0);
});
