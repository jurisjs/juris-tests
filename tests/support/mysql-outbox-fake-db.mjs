// A stand-in for one MariaDB/MySQL outbox table, for the MySQL change bus's tests.
//
// `fakeOutboxDb()` is the adapter the bus takes (what fromMysql2 or fromMariadb would hand it): its
// `query(sql, params)` records every statement with its parameters and answers the rows as an
// array, or a write's { affectedRows, insertId }. It answers the statements the bus sends (the
// cursor's MAX(id), a batch after the cursor, the ids it jumped over with IN (?, …), a publish's
// INSERT, a prune's DELETE). A row can be inserted uncommitted (`reserve`) and committed later
// (`commit`): the AUTO_INCREMENT gap. `onQuery(sql, params)` runs first and may throw, wait, or
// answer something of its own. With `bigint: true` ids come back as BigInt, as mariadb gives them.
//
// `mysql2Pool(db)` and `mariadbPool(db)` put the same table behind a raw driver's shape, for the
// adapters of ../../db.js: mysql2/promise answers [rows, fields], mariadb the rows themselves (with
// its `meta` on the array).
export function fakeOutboxDb({ start = 0, bigint = false } = {}) {
    const rows = [];          // { id, entity, entity_id, payload, created_at, visible }
    let nextId = start + 1;
    const id = (n) => (bigint ? BigInt(n) : n);
    const out = (r) => ({ id: id(r.id), entity: r.entity, entity_id: r.entity_id, payload: r.payload, created_at: r.created_at });
    const visible = () => rows.filter((r) => r.visible);

    const db = {
        queries: [],
        onQuery: null,
        rows,
        insert(entity, entityId, { payload = null, at = new Date() } = {}) {
            const row = db.reserve(entity, entityId, { payload, at });
            db.commit(row.id);
            return row;
        },
        reserve(entity, entityId, { payload = null, at = new Date() } = {}) {
            const row = { id: nextId++, entity, entity_id: String(entityId), payload, created_at: at, visible: false };
            rows.push(row);
            return row;
        },
        commit(n) { rows.find((r) => r.id === n).visible = true; },
        batchReads: () => db.queries.filter((q) => /WHERE id > \?/.test(q.sql)),
        gapReads: () => db.queries.filter((q) => /WHERE id IN \(/.test(q.sql)),

        async query(sql, params) {
            db.queries.push({ sql, params });
            if (db.onQuery) {
                const scripted = await db.onQuery(sql, params);
                if (scripted !== undefined) return scripted;
            }
            return db.answer(sql, params);
        },

        // The table's answer to a statement, as the adapter hands it on.
        answer(sql, params = []) {
            if (/^SELECT COALESCE\(MAX\(id\), 0\) AS id FROM \w+$/.test(sql)) {
                return [{ id: id(visible().reduce((m, r) => Math.max(m, r.id), 0)) }];
            }
            if (/WHERE id > \? ORDER BY id LIMIT \?$/.test(sql)) {
                const [after, limit] = params;
                return visible().filter((r) => r.id > after).sort((a, b) => a.id - b.id).slice(0, limit).map(out);
            }
            if (/WHERE id IN \((\?,)*\?\)$/.test(sql)) {
                const wanted = new Set(params.map(Number));
                return visible().filter((r) => wanted.has(r.id)).map(out);
            }
            if (/^INSERT INTO \w+ \(entity, entity_id, payload\) VALUES \(\?, \?, \?\)$/.test(sql)) {
                const [entity, entityId, payload] = params;
                const row = db.insert(entity, entityId, { payload });
                return { affectedRows: 1, insertId: row.id };
            }
            if (/^DELETE FROM /.test(sql)) return { affectedRows: 4, insertId: 0 };
            return [];
        },
    };
    return db;
}

const FIELDS = ["id", "entity", "entity_id", "payload", "created_at"].map((name) => ({ name }));

// mysql2/promise: [rows, fields] for a SELECT, [ResultSetHeader, undefined] for a write.
export const mysql2Pool = (db) => ({
    async query(sql, params) {
        db.queries.push({ sql, params });
        const result = db.answer(sql, params);
        return Array.isArray(result) ? [result, FIELDS] : [result, undefined];
    },
});

// mariadb: the rows themselves, the column metadata on the array as `meta`; a write's OkPacket.
export const mariadbPool = (db) => ({
    async query(sql, params) {
        db.queries.push({ sql, params });
        const result = db.answer(sql, params);
        if (Array.isArray(result)) Object.defineProperty(result, "meta", { value: FIELDS, enumerable: false });
        return result;
    },
});

export const settle = async (rounds = 20) => {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

export const gate = () => {
    let open;
    const promise = new Promise((resolve) => { open = resolve; });
    return { promise, open };
};
