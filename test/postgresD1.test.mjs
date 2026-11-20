import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresD1 } from '../functions/utils/postgresD1.js';

test('translates the existing replace, ignore and list statements without interpolating values', async () => {
    const calls = [];
    const db = new PostgresD1('', {
        async query(sql, params) {
            calls.push([sql, params]);
            return { rowCount: 1, rows: [{ key: 'manage@Test' }] };
        },
    });

    assert.deepEqual(await db.prepare('INSERT OR REPLACE INTO settings (key, value, category) VALUES (?, ?, ?)')
        .bind('manage@Test', "'?", null).run(), { success: true, meta: { changes: 1, last_row_id: 0 } });
    assert.deepEqual(calls[0], [
        'INSERT INTO settings (key, value, category) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE ' +
        'SET value = EXCLUDED.value, category = EXCLUDED.category, description = EXCLUDED.description, ' +
        'created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at',
        ['manage@Test', "'?", null],
    ]);
    await db.prepare('INSERT OR IGNORE INTO files (id, value, metadata) VALUES (?, ?, ?)').bind('a', '', '{}').run();
    assert.equal(calls[1][0], 'INSERT INTO files (id, value, metadata) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING');
    assert.deepEqual(await db.prepare("SELECT key FROM settings WHERE key LIKE ? AND '?' = '?' ORDER BY key LIMIT ?")
        .bind('manage@%', 10).all(), { results: [{ key: 'manage@Test' }] });
    assert.equal(calls[2][0], "SELECT key FROM settings WHERE key ILIKE $1 ESCAPE '' AND '?' = '?' ORDER BY key LIMIT $2");
});

test('translates the relay JSON append and keeps the length check in the update', async () => {
    const db = new PostgresD1('', {
        async query(sql, params) {
            assert.equal(sql, 'UPDATE upload_relay_transfers SET parts = (parts::jsonb || jsonb_build_array($1::jsonb))::text ' +
                'WHERE upload_id = $2 AND jsonb_array_length(parts::jsonb) = $3');
            assert.deepEqual(params, ['{"index":0}', 'upload', 0]);
            return { rowCount: 1, rows: [] };
        },
    });
    await db.prepare("UPDATE upload_relay_transfers SET parts = json_insert(parts, '$[#]', json(?)) " +
        'WHERE upload_id = ? AND json_array_length(parts) = ?').bind('{"index":0}', 'upload', 0).run();
});

test('runs transaction statements on one client and rolls back on callback failure', async () => {
    const calls = [];
    const db = new PostgresD1('');
    db.withClient = callback => callback({
        async query(sql) {
            calls.push(sql);
            return { rows: [{ value: 42 }] };
        },
    });

    assert.equal(await db.transaction(tx => tx.prepare('SELECT ? AS value').bind(42).first('value')), 42);
    const problem = new Error('failed');
    await assert.rejects(db.transaction(async tx => {
        await tx.prepare('SELECT ? AS value').bind(42).first();
        throw problem;
    }), error => error === problem);
    const begin = 'BEGIN ISOLATION LEVEL READ COMMITTED';
    assert.deepEqual(calls, [begin, 'SELECT $1 AS value', 'COMMIT', begin, 'SELECT $1 AS value', 'ROLLBACK']);
});
