// A stand-in for a node-postgres pool holding one outbox table, for the Postgres change bus's tests.
//
// It answers the statements the bus sends (the cursor's MAX(id), a batch after the cursor, the ids it
// jumped over, a publish's INSERT, a prune's DELETE) from an in-memory table, and records every one
// with its parameters. Ids come back as strings, as pg returns a bigint. A row can be inserted
// uncommitted (`reserve`) and committed later (`commit`), which is the gap the bus has to re-check.
//
// `pool.connect()` hands out clients that are EventEmitters, as pg's are: `LISTEN <channel>` on one
// subscribes it, and `notify(channel, payload)` delivers a "notification" to every client listening
// on that channel and not yet released, as the trigger's pg_notify does at COMMIT. With
// `trigger: true` a commit (and a publish's INSERT) rings that doorbell itself.
//
// Failures and pauses are scripted: `failConnect`, `failListen` (how many of the next attempts
// throw), `connectGate` / `listenGate` (a promise the next one waits on), and `onQuery(sql, params)`,
// which runs before any pool query and may throw or answer a result of its own.
import { EventEmitter } from "node:events";

export function fakePgPool({ table = "change_events", channel = table, trigger = false, start = 0 } = {}) {
    const rows = [];          // { id, entity, entity_id, payload, created_at, visible }
    let nextId = start + 1;

    const pool = {
        queries: [],          // { sql, params } of pool.query
        clients: [],
        connects: 0,
        failConnect: 0,
        failListen: 0,
        connectGate: null,
        listenGate: null,
        onQuery: null,
        rows,

        // A committed row, as a mutation's emit leaves it.
        insert(entity, entityId, { payload = null, at = new Date() } = {}) {
            const row = pool.reserve(entity, entityId, { payload, at });
            pool.commit(row.id);
            return row;
        },
        // A row whose id is taken but whose transaction has not committed: invisible to every read.
        reserve(entity, entityId, { payload = null, at = new Date() } = {}) {
            const row = { id: nextId++, entity, entity_id: String(entityId), payload, created_at: at, visible: false };
            rows.push(row);
            return row;
        },
        commit(id) {
            const row = rows.find((r) => r.id === id);
            row.visible = true;
            if (trigger) pool.notify(channel, String(id));
        },
        // The doorbell: every listening client on `channel` hears it.
        notify(on = channel, payload = "") {
            for (const client of pool.clients) {
                if (client.listening.has(on) && !client.released.length) client.emit("notification", { channel: on, payload });
            }
        },
        // The clients currently checked out and listening.
        listeners: () => pool.clients.filter((c) => c.listening.size && !c.released.length),
        // The batch reads the bus sent (the one after the cursor), with their parameters.
        batchReads: () => pool.queries.filter((q) => /WHERE id > \$1/.test(q.sql)),
        gapReads: () => pool.queries.filter((q) => /WHERE id = ANY/.test(q.sql)),

        async query(sql, params) {
            pool.queries.push({ sql, params });
            if (pool.onQuery) {
                const scripted = await pool.onQuery(sql, params);
                if (scripted !== undefined) return scripted;
            }
            return answer(sql, params);
        },

        async connect() {
            pool.connects++;
            if (pool.connectGate) { const gate = pool.connectGate; pool.connectGate = null; await gate; }
            if (pool.failConnect > 0) { pool.failConnect--; throw new Error("connect ECONNREFUSED 10.0.0.5:5432"); }
            const client = new EventEmitter();
            client.queries = [];
            client.released = [];
            client.listening = new Set();
            client.query = async (sql) => {
                client.queries.push(sql);
                const listen = /^LISTEN (\w+)$/.exec(sql);
                if (listen) {
                    if (pool.listenGate) { const gate = pool.listenGate; pool.listenGate = null; await gate; }
                    if (pool.failListen > 0) { pool.failListen--; throw new Error("permission denied for LISTEN"); }
                    client.listening.add(listen[1]);
                }
                const unlisten = /^UNLISTEN (\w+)$/.exec(sql);
                if (unlisten) client.listening.delete(unlisten[1]);
                return { rows: [], fields: [] };
            };
            client.release = (arg) => { client.released.push(arg); };
            pool.clients.push(client);
            return client;
        },
    };

    const visible = () => rows.filter((r) => r.visible);
    const out = (r) => ({ id: String(r.id), entity: r.entity, entity_id: r.entity_id, payload: r.payload, created_at: r.created_at });
    const fields = (names) => names.map((name) => ({ name }));

    function answer(sql, params) {
        if (/^SELECT COALESCE\(MAX\(id\), 0\) AS id FROM \w+$/.test(sql)) {
            const max = visible().reduce((m, r) => Math.max(m, r.id), 0);
            return { rows: [{ id: String(max) }], fields: fields(["id"]) };
        }
        if (/WHERE id > \$1 ORDER BY id LIMIT \$2$/.test(sql)) {
            const [after, limit] = params;
            const batch = visible().filter((r) => r.id > after).sort((a, b) => a.id - b.id).slice(0, limit);
            return { rows: batch.map(out), fields: fields(["id", "entity", "entity_id", "payload", "created_at"]) };
        }
        if (/WHERE id = ANY\(\$1::bigint\[\]\)$/.test(sql)) {
            const ids = new Set(params[0].map(Number));
            return { rows: visible().filter((r) => ids.has(r.id)).map(out), fields: fields(["id", "entity", "entity_id", "payload", "created_at"]) };
        }
        if (/^INSERT INTO \w+ \(entity, entity_id, payload\) VALUES \(\$1, \$2, \$3\)$/.test(sql)) {
            const [entity, entityId, payload] = params;
            pool.insert(entity, entityId, { payload });
            return { rows: [], rowCount: 1 };
        }
        if (/^DELETE FROM /.test(sql)) return { rows: [], rowCount: 3 };
        return { rows: [] };
    }

    return pool;
}

// Lets every pending promise continuation and immediate run: the bus's reads are a few awaits deep.
export const settle = async (rounds = 20) => {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

// A promise and the function that resolves it, for holding a fake's answer until the test lets go.
export const gate = () => {
    let open;
    const promise = new Promise((resolve) => { open = resolve; });
    return { promise, open };
};
