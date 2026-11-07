// The database adapters of db.js over fake pg, mysql2 and mariadb pools: what query sends and
// answers (rows, their column names as a non-enumerable rows.fields, a write's report, mariadb's
// plain copies), and transaction: one connection between BEGIN and COMMIT, the function's answer,
// a rollback and the original error when the function or the COMMIT fails, and the connection
// pooled again, or destroyed when the ROLLBACK itself failed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromPg, fromMysql2, fromMariadb } from "juris-kit/server/db.js";

const FIELDS = [{ name: "lot_no", dataTypeID: 25 }, { name: "qty", dataTypeID: 23 }];

// ---- pg -----------------------------------------------------------------------------------------

// A node-postgres pool: query answers { rows, fields } (a fresh array each time, as pg does);
// connect hands out a client that records its statements, may fail one of them
// (`fail: { BEGIN: error, ... }`), and records how it was released.
function pgPool({ rows = [], fail = {}, ...rest } = {}) {
    const fields = "fields" in rest ? rest.fields : FIELDS;
    const pool = {
        sent: [],
        clients: [],
        async query(sql, params) {
            pool.sent.push({ sql, params });
            return { rows: rows.map((row) => ({ ...row })), fields, rowCount: rows.length };
        },
        async connect() {
            if (fail.connect) throw fail.connect;
            const client = {
                sent: [],
                released: [],
                async query(sql, params) {
                    client.sent.push(params === undefined ? sql : [sql, params]);
                    if (sql in fail) throw fail[sql];
                    return { rows: rows.map((row) => ({ ...row })), fields };
                },
                release(...args) { client.released.push(args); },
            };
            pool.clients.push(client);
            return client;
        },
    };
    return pool;
}

test("pg: query sends the statement and its parameters to the pool, which default to none", async () => {
    const pool = pgPool({ rows: [{ lot_no: "L1", qty: 3 }] });
    const db = fromPg(pool);
    assert.deepEqual(await db.query("SELECT lot_no, qty FROM lot WHERE lot_no = $1", ["L1"]), [{ lot_no: "L1", qty: 3 }]);
    await db.query("SELECT 1");
    assert.deepEqual(pool.sent, [
        { sql: "SELECT lot_no, qty FROM lot WHERE lot_no = $1", params: ["L1"] },
        { sql: "SELECT 1", params: [] },
    ]);
});

test("pg: rows say their column names, in order, as a non-enumerable fields, and serialize as before", async () => {
    const rows = await fromPg(pgPool({ rows: [{ lot_no: "L1", qty: 3 }] })).query("SELECT lot_no, qty FROM lot");
    assert.deepEqual(rows.fields, ["lot_no", "qty"]);
    assert.equal(Object.getOwnPropertyDescriptor(rows, "fields").enumerable, false);
    assert.deepEqual(Object.keys(rows), ["0"]);
    assert.equal(JSON.stringify(rows), '[{"lot_no":"L1","qty":3}]');
    assert.deepEqual([...rows], [{ lot_no: "L1", qty: 3 }]);
});

test("pg: an empty result still says its columns", async () => {
    const rows = await fromPg(pgPool()).query("SELECT lot_no, qty FROM lot WHERE false");
    assert.deepEqual(rows, []);
    assert.deepEqual(rows.fields, ["lot_no", "qty"]);
});

test("pg: a statement that returns no rows answers []", async () => {
    const rows = await fromPg(pgPool({ fields: [] })).query("UPDATE lot SET qty = 0");
    assert.deepEqual(rows, []);
    assert.deepEqual(rows.fields, []);
});

test("pg: a result that carries no fields is answered as its rows, with nothing added", async () => {
    const rows = await fromPg(pgPool({ rows: [{ n: 1 }], fields: undefined })).query("SELECT 1 AS n");
    assert.deepEqual(rows, [{ n: 1 }]);
    assert.equal("fields" in rows, false);
});

test("pg: a transaction runs on one client between BEGIN and COMMIT, answers the function's value, and releases the client", async () => {
    const pool = pgPool({ rows: [{ lot_no: "L1", qty: 3 }] });
    const db = fromPg(pool);
    const out = await db.transaction(async (tx) => {
        const rows = await tx.query("SELECT lot_no, qty FROM lot WHERE lot_no = $1 FOR UPDATE", ["L1"]);
        assert.deepEqual(rows.fields, ["lot_no", "qty"], "a transaction's rows say their columns too");
        await tx.query("UPDATE lot SET qty = qty - 1");
        return { left: rows[0].qty - 1 };
    });
    assert.deepEqual(out, { left: 2 });
    assert.equal(pool.clients.length, 1);
    assert.deepEqual(pool.clients[0].sent, [
        "BEGIN",
        ["SELECT lot_no, qty FROM lot WHERE lot_no = $1 FOR UPDATE", ["L1"]],
        ["UPDATE lot SET qty = qty - 1", []],
        "COMMIT",
    ]);
    assert.deepEqual(pool.clients[0].released, [[undefined]], "released with no error: pooled again");
    assert.deepEqual(pool.sent, [], "nothing ran on the pool itself");
});

test("pg: a function that throws is rolled back, its error rethrown, and the client pooled again", async () => {
    const pool = pgPool();
    const failure = new Error("insufficient stock");
    await assert.rejects(fromPg(pool).transaction(async (tx) => { await tx.query("UPDATE lot SET qty = 0"); throw failure; }),
        (error) => error === failure);
    assert.deepEqual(pool.clients[0].sent, ["BEGIN", ["UPDATE lot SET qty = 0", []], "ROLLBACK"]);
    assert.deepEqual(pool.clients[0].released, [[undefined]]);
});

test("pg: a COMMIT that fails is rolled back and its error rethrown", async () => {
    const failure = new Error("could not serialize access due to concurrent update");
    const pool = pgPool({ fail: { COMMIT: failure } });
    await assert.rejects(fromPg(pool).transaction(async () => "never answered"), (error) => error === failure);
    assert.deepEqual(pool.clients[0].sent, ["BEGIN", "COMMIT", "ROLLBACK"]);
    assert.deepEqual(pool.clients[0].released, [[undefined]]);
});

test("pg: a BEGIN that fails rethrows its error and still gives the client back", async () => {
    const failure = new Error("connection reset");
    const pool = pgPool({ fail: { BEGIN: failure } });
    let ran = false;
    await assert.rejects(fromPg(pool).transaction(async () => { ran = true; }), (error) => error === failure);
    assert.equal(ran, false);
    assert.equal(pool.clients[0].released.length, 1);
});

test("pg: a ROLLBACK that fails does not replace the error, and the client is released with its error, which destroys it", async () => {
    const lost = new Error("Connection terminated");
    const pool = pgPool({ fail: { ROLLBACK: lost } });
    const failure = new Error("the transaction's own");
    await assert.rejects(fromPg(pool).transaction(async () => { throw failure; }), (error) => error === failure);
    assert.deepEqual(pool.clients[0].released, [[lost]]);
});

test("pg: a ROLLBACK that fails with something not an Error still destroys the client", async () => {
    const pool = pgPool({ fail: { ROLLBACK: "socket hang up" } });
    const failure = new Error("the transaction's own");
    await assert.rejects(fromPg(pool).transaction(async () => { throw failure; }), (error) => error === failure);
    const [[released]] = pool.clients[0].released;
    assert.ok(released instanceof Error, "release(error) is what destroys a pg client");
    assert.equal(released.message, "ROLLBACK failed");
});

test("pg: a client that cannot be checked out rejects the transaction and runs nothing", async () => {
    const failure = new Error("timeout exceeded when trying to connect");
    let ran = false;
    await assert.rejects(fromPg(pgPool({ fail: { connect: failure } })).transaction(async () => { ran = true; }), (error) => error === failure);
    assert.equal(ran, false);
});

test("pg: each transaction has a client of its own", async () => {
    const pool = pgPool();
    const db = fromPg(pool);
    await Promise.all([db.transaction(async (tx) => tx.query("SELECT 1")), db.transaction(async (tx) => tx.query("SELECT 2"))]);
    assert.equal(pool.clients.length, 2);
    assert.deepEqual(pool.clients.map((c) => c.sent[1]), [["SELECT 1", []], ["SELECT 2", []]]);
});

// ---- mysql2 and mariadb ---------------------------------------------------------------------------

// A connection from pool.getConnection(), recording every call; `fail` names the step that throws.
// `answer` is what its query answers: a function makes a fresh one for each query, as a driver does.
function connection({ answer, fail = {} }) {
    const conn = {
        calls: [],
        async beginTransaction() { conn.calls.push("begin"); if (fail.begin) throw fail.begin; },
        async query(sql, params) { conn.calls.push(["query", sql, params]); return typeof answer === "function" ? answer() : answer; },
        async commit() { conn.calls.push("commit"); if (fail.commit) throw fail.commit; },
        async rollback() { conn.calls.push("rollback"); if (fail.rollback) throw fail.rollback; },
        release() { conn.calls.push("release"); },
        destroy() { conn.calls.push("destroy"); },
    };
    return conn;
}
const pooled = (conn) => ({ getConnection: async () => conn });

test("mysql2: query sends the statement and its parameters, which default to none, and answers the rows", async () => {
    const sent = [];
    const pool = { query: async (sql, params) => { sent.push([sql, params]); return [[{ lot_no: "L1", qty: 3 }], FIELDS]; } };
    const db = fromMysql2(pool);
    assert.deepEqual(await db.query("SELECT lot_no, qty FROM lot WHERE lot_no = ?", ["L1"]), [{ lot_no: "L1", qty: 3 }]);
    await db.query("SELECT 1");
    assert.deepEqual(sent, [["SELECT lot_no, qty FROM lot WHERE lot_no = ?", ["L1"]], ["SELECT 1", []]]);
});

test("mysql2: rows say their column names as a non-enumerable fields, even when there are none", async () => {
    const db = fromMysql2({ query: async () => [[], FIELDS] });
    const rows = await db.query("SELECT lot_no, qty FROM lot WHERE false");
    assert.deepEqual(rows, []);
    assert.deepEqual(rows.fields, ["lot_no", "qty"]);
    assert.equal(Object.getOwnPropertyDescriptor(rows, "fields").enumerable, false);
    assert.equal(JSON.stringify(rows), "[]");
});

test("mysql2: a write answers the driver's report, with its affectedRows and insertId", async () => {
    const header = { affectedRows: 1, insertId: 41, warningStatus: 0 };
    const answer = await fromMysql2({ query: async () => [header, undefined] }).query("INSERT INTO lot (lot_no) VALUES (?)", ["L2"]);
    assert.equal(answer, header);
    assert.equal(answer.affectedRows, 1);
    assert.equal(answer.insertId, 41);
});

test("mariadb: query answers plain copies of the driver's rows, without the driver's array", async () => {
    const driverRows = [{ lot_no: "L1", qty: 3 }, { lot_no: "L2", qty: 0 }];
    Object.defineProperty(driverRows, "meta", { value: FIELDS, enumerable: false });
    const sent = [];
    const db = fromMariadb({ query: async (sql, params) => { sent.push([sql, params]); return driverRows; } });
    const rows = await db.query("SELECT lot_no, qty FROM lot");
    assert.deepEqual(rows, driverRows);
    assert.notEqual(rows, driverRows);
    assert.notEqual(rows[0], driverRows[0], "copies, not the driver's objects");
    assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype);
    assert.equal(rows.meta, undefined);
    rows[0].qty = 99;
    assert.equal(driverRows[0].qty, 3);
    assert.deepEqual(sent, [["SELECT lot_no, qty FROM lot", []]], "parameters default to none");
});

test("mariadb: a write answers the driver's report as it is", async () => {
    const ok = { affectedRows: 2, insertId: 0n, warningStatus: 0 };
    assert.equal(await fromMariadb({ query: async () => ok }).query("DELETE FROM lot WHERE qty = 0"), ok);
});

for (const [label, from, answer] of [
    ["mysql2", fromMysql2, () => [[{ lot_no: "L1", qty: 3 }], FIELDS]],
    ["mariadb", fromMariadb, () => [{ lot_no: "L1", qty: 3 }]],
]) {
    test(`${label}: a transaction runs on one connection between begin and commit, answers the function's value, and releases it`, async () => {
        const conn = connection({ answer });
        const out = await from(pooled(conn)).transaction(async (tx) => {
            await tx.query("SELECT qty FROM lot WHERE lot_no = ? FOR UPDATE", ["L1"]);
            await tx.query("UPDATE lot SET qty = 0");
            return "done";
        });
        assert.equal(out, "done");
        assert.deepEqual(conn.calls, [
            "begin",
            ["query", "SELECT qty FROM lot WHERE lot_no = ? FOR UPDATE", ["L1"]],
            ["query", "UPDATE lot SET qty = 0", []],
            "commit",
            "release",
        ]);
    });

    test(`${label}: a function that throws is rolled back, its error rethrown, and the connection released`, async () => {
        const conn = connection({ answer });
        const failure = new Error("insufficient stock");
        await assert.rejects(from(pooled(conn)).transaction(async () => { throw failure; }), (error) => error === failure);
        assert.deepEqual(conn.calls, ["begin", "rollback", "release"]);
    });

    test(`${label}: a commit that fails is rolled back and its error rethrown`, async () => {
        const failure = new Error("Deadlock found when trying to get lock");
        const conn = connection({ answer, fail: { commit: failure } });
        await assert.rejects(from(pooled(conn)).transaction(async () => 1), (error) => error === failure);
        assert.deepEqual(conn.calls, ["begin", "commit", "rollback", "release"]);
    });

    test(`${label}: a begin that fails rethrows its error and still gives the connection back`, async () => {
        const failure = new Error("Lost connection to server");
        const conn = connection({ answer, fail: { begin: failure } });
        await assert.rejects(from(pooled(conn)).transaction(async () => 1), (error) => error === failure);
        assert.equal(conn.calls.at(-1), "release");
        assert.equal(conn.calls.includes("commit"), false);
    });

    test(`${label}: a rollback that fails does not replace the error, and the connection is destroyed, never pooled`, async () => {
        const conn = connection({ answer, fail: { rollback: new Error("Connection lost: The server closed the connection") } });
        const failure = new Error("the transaction's own");
        await assert.rejects(from(pooled(conn)).transaction(async () => { throw failure; }), (error) => error === failure);
        assert.deepEqual(conn.calls, ["begin", "rollback", "destroy"]);
    });

    test(`${label}: a connection that cannot be had rejects the transaction and runs nothing`, async () => {
        const failure = new Error("Pool is closed");
        let ran = false;
        await assert.rejects(from({ getConnection: async () => { throw failure; } }).transaction(async () => { ran = true; }), (e) => e === failure);
        assert.equal(ran, false);
    });
}

test("mysql2: a transaction's rows say their column names too", async () => {
    const conn = connection({ answer: () => [[{ lot_no: "L1", qty: 3 }], FIELDS] });
    const rows = await fromMysql2(pooled(conn)).transaction((tx) => tx.query("SELECT lot_no, qty FROM lot"));
    assert.deepEqual(rows, [{ lot_no: "L1", qty: 3 }]);
    assert.deepEqual(rows.fields, ["lot_no", "qty"]);
});

test("mariadb: a transaction's query answers the driver's own rows", async () => {
    const driverRows = [{ lot_no: "L1", qty: 3 }];
    const conn = connection({ answer: driverRows });
    assert.equal(await fromMariadb(pooled(conn)).transaction((tx) => tx.query("SELECT lot_no, qty FROM lot")), driverRows);
});
