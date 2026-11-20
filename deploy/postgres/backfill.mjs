import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';

const dates = 'created_at:d updated_at:d';
const tables = Object.fromEntries(Object.entries({
    files: `id value metadata file_name file_type file_size upload_ip upload_address list_type timestamp:i
        label directory channel channel_name tg_file_id tg_chat_id tg_bot_token is_chunked:b tags ${dates}`,
    settings: `key value category description ${dates}`,
    index_operations: 'id type timestamp:i data processed:b created_at:d',
    index_metadata: `key last_updated:i total_count:i last_operation_id chunk_count:i chunk_size:i ${dates}`,
    other_data: `key value type description ${dates}`,
    upload_relay_registrations: 'upload_id file_id fingerprint receipt lease_owner lease_until:i created_at:i',
    upload_relay_jobs: 'upload_id lease_owner lease_until:i',
    upload_relay_rate: 'id:i window_start:i starts:i',
    upload_relay_transfers: 'upload_id file_id manifest parts created_at:i',
}).map(([name, definitions]) => [name, definitions.split(/\s+/).map(column => column.split(':'))]));

const state = 'public._imgbed_d1_backfill';
const lockId = '531027942726303185';
const env = process.env;

class BackfillError extends Error {}
function requireValue(value, message) {
    if (!value) throw new BackfillError(message);
    return value;
}

const sha256 = () => createHash('sha256');
const sourceId = value => sha256().update('imgbed-d1-backfill-v1:').update(value).digest('hex');

async function openSource() {
    if (env.MIGRATION_SOURCE_SQLITE) {
        const { DatabaseSync } = await import('node:sqlite');
        const file = await realpath(env.MIGRATION_SOURCE_SQLITE);
        const { dev, ino } = await stat(file, { bigint: true });
        const db = new DatabaseSync(file, { readOnly: true });
        return {
            id: sourceId(`sqlite:${file}:${dev}:${ino}`),
            async query(sql, params) {
                const statement = db.prepare(sql);
                statement.setReturnArrays(true);
                return statement.all(...params);
            },
            close: () => db.close(),
        };
    }

    const account = env.CLOUDFLARE_ACCOUNT_ID;
    const database = env.CLOUDFLARE_D1_DATABASE_ID?.toLowerCase();
    const token = env.CLOUDFLARE_API_TOKEN;
    requireValue(/^[a-f\d]{32}$/i.test(account || ''), 'set CLOUDFLARE_ACCOUNT_ID to the Cloudflare account ID');
    requireValue(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(database || ''),
        'set CLOUDFLARE_D1_DATABASE_ID to the img_url database UUID');
    requireValue(token, 'set CLOUDFLARE_API_TOKEN with D1 Read permission');
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}`;
    async function request(suffix, payload) {
        let response;
        try {
            response = await fetch(endpoint + suffix, {
                method: payload ? 'POST' : 'GET',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: payload && JSON.stringify(payload),
                redirect: 'error', signal: AbortSignal.timeout(30_000),
            });
        } catch {
            throw new BackfillError('D1 request failed or timed out');
        }
        requireValue(response.ok, `D1 request failed (HTTP ${response.status})`);
        const body = await response.json().catch(() => null);
        requireValue(body?.success === true, 'D1 rejected the request');
        return body.result;
    }
    const identity = await request('');
    requireValue(identity?.name === 'img_url' && identity.uuid?.toLowerCase() === database,
        'D1 identity must match the primary img_url database');
    return {
        id: sourceId(`d1:${account.toLowerCase()}:${database}`),
        async query(sql, params) {
            const result = (await request('/raw', { sql, params }))?.[0];
            requireValue(result?.success === true && Array.isArray(result.results?.rows),
                'D1 did not return a valid row set');
            requireValue(result.meta?.served_by_primary !== false, 'D1 returned a replica result; use primary reads');
            return result.results.rows;
        },
        close() {},
    };
}

function normalize(value, type, field) {
    if (value === null) return null;
    requireValue(typeof value === 'string' && !value.includes('\0'), `unsupported value type in ${field}`);
    if (type === 'i') {
        requireValue(/^(?:0|-?[1-9]\d*)$/.test(value), `invalid integer in ${field}`);
    } else if (type === 'b') {
        requireValue(value === '0' || value === '1', `invalid boolean in ${field}`);
        return value === '1' ? 'true' : 'false';
    } else if (type === 'd') {
        const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)?$/.exec(value);
        requireValue(match, `invalid UTC timestamp in ${field}`);
        const fraction = match[3]?.replace(/0+$/, '');
        return `${match[1]} ${match[2]}${fraction ? `.${fraction}` : ''}`;
    }
    return value;
}

async function page(source, table, cursor, limit, postgres = false) {
    const columns = tables[table];
    const [key, numericKey] = columns[0];
    const direction = `src."${key}"` + (numericKey ? '' : ` COLLATE ${postgres ? '"C"' : 'BINARY'}`);
    const castKey = numericKey ? (postgres ? 'CAST($1 AS BIGINT)' : 'CAST(? AS INTEGER)') : (postgres ? '$1' : '?');
    const fields = columns.map(([name, type]) => type
        ? `CAST(src."${name}" AS TEXT) AS "${name}"` : `src."${name}"`);
    const sql = `SELECT ${fields.join(', ')} FROM ${postgres ? 'public.' : ''}${table} AS src`
        + (cursor === null ? '' : ` WHERE ${direction} > ${castKey}`)
        + ` ORDER BY ${direction} LIMIT ${postgres ? (cursor === null ? '$1' : '$2') : '?'}`;
    const rows = await source.query(sql, cursor === null ? [String(limit)] : [cursor, String(limit)]);
    requireValue(rows.length <= limit, `oversize keyset page in ${table}`);
    return rows.map(row => {
        requireValue(Array.isArray(row) && row.length === columns.length && row[0] !== null,
            `invalid row shape or NULL primary key in ${table}`);
        const values = postgres ? row : row.map((value, i) => {
            const [name, type] = columns[i];
            return normalize(value, type, `${table}.${name}`);
        });
        const next = values[0];
        const advances = cursor === null || (numericKey ? BigInt(next) > BigInt(cursor)
            : Buffer.compare(Buffer.from(next), Buffer.from(cursor)) > 0);
        requireValue(advances, `non-advancing keyset cursor in ${table}`);
        cursor = next;
        return values;
    });
}

async function transaction(client, fn, begin = 'BEGIN') {
    await client.query(begin);
    try {
        const value = await fn();
        await client.query('COMMIT');
        return value;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function initOrResume(client, source, apply) {
    const { rows: relations } = await client.query(
        `SELECT n.nspname AS schema, c.relname AS name
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
           AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
           AND n.nspname !~ '^pg_(temp|toast_temp)_'`);
    if (!relations.length && apply) {
        const schema = await readFile(new URL('../../database/postgres-primary.sql', import.meta.url), 'utf8');
        await transaction(client, async () => {
            await client.query(schema);
            await client.query(`CREATE TABLE ${state} (
                table_name TEXT PRIMARY KEY, source_id TEXT NOT NULL,
                cursor TEXT, row_count BIGINT NOT NULL DEFAULT 0, complete BOOLEAN NOT NULL DEFAULT FALSE
            )`);
            await client.query(`INSERT INTO ${state} (table_name, source_id)
                SELECT unnest($1::text[]), $2`, [Object.keys(tables), source.id]);
        });
    } else {
        const expected = new Set([...Object.keys(tables), '_imgbed_d1_backfill']);
        requireValue(relations.length === expected.size
            && relations.every(({ schema, name }) => schema === 'public' && expected.has(name)),
        'target is not the exact migration-owned public table set (or an empty database for --apply)');
    }
    const { rows } = await client.query(`SELECT * FROM ${state}`);
    requireValue(rows.length === Object.keys(tables).length
        && rows.every(row => Object.hasOwn(tables, row.table_name) && row.source_id === source.id),
    'target is not a checkpoint for this source');
    return new Map(rows.map(row => [row.table_name, row]));
}

async function insertPage(client, table, rows) {
    const columns = tables[table].map(([name]) => `"${name}"`);
    const values = rows.map((row, i) => '(' + row.map((_, j) => `$${i * columns.length + j + 1}`).join(',') + ')');
    await client.query(`INSERT INTO public.${table} (${columns.join(',')}) VALUES ${values.join(',')}`, rows.flat());
}

async function load(client, source, table, progress, limit) {
    if (progress.complete) return;
    let cursor = progress.cursor;
    let count = BigInt(progress.row_count);
    for (let batches = 1; ; batches++) {
        const rows = await page(source, table, cursor, limit);
        if (rows.length) {
            cursor = rows.at(-1)[0];
            count += BigInt(rows.length);
        }
        await transaction(client, async () => {
            if (rows.length) await insertPage(client, table, rows);
            await client.query(`UPDATE ${state} SET cursor = $2, row_count = $3, complete = $4 WHERE table_name = $1`,
                [table, cursor, count.toString(), rows.length === 0]);
        });
        if (!rows.length) {
            console.log(`${table}: loaded ${count} rows`);
            return;
        }
        if (batches % 25 === 0) console.log(`${table}: checkpointed ${count} rows`);
    }
}

async function digest(source, table, limit, postgres) {
    const hash = sha256();
    let count = 0n;
    let cursor = null;
    for (;;) {
        const rows = await page(source, table, cursor, limit, postgres);
        if (!rows.length) return { count, digest: hash.digest('hex') };
        for (const row of rows) hash.update(JSON.stringify(row)).update('\n');
        count += BigInt(rows.length);
        cursor = rows.at(-1)[0];
    }
}

function targetSettings() {
    const database = env.MIGRATION_EXPECTED_DATABASE;
    requireValue(/^imgbed_[a-z0-9_]{1,55}$/.test(database || ''),
        'set MIGRATION_EXPECTED_DATABASE to an isolated imgbed_<suffix> database');
    let url;
    try {
        url = new URL(env.MIGRATION_DATABASE_URL);
    } catch {
        throw new BackfillError('set MIGRATION_DATABASE_URL to the isolated PostgreSQL database URL');
    }
    requireValue(['postgres:', 'postgresql:'].includes(url.protocol) && url.pathname === '/' + database
        && !url.searchParams.has('dbname') && !url.searchParams.has('database'),
    'PostgreSQL URL path must exactly match MIGRATION_EXPECTED_DATABASE');
    return { database, connectionString: url.toString() };
}

async function main() {
    const mode = process.argv[2] ?? '--dry-run';
    if (mode === '--help') {
        console.log('backfill.mjs [--dry-run | --apply | --verify]');
        console.log('Source: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN (D1 Read),'
            + ' or MIGRATION_SOURCE_SQLITE for a local fixture.');
        console.log('Apply/verify: MIGRATION_DATABASE_URL, MIGRATION_EXPECTED_DATABASE (imgbed_<suffix>).'
            + ' Optional MIGRATION_PAGE_SIZE (1-500, default 100).');
        return;
    }
    requireValue(process.argv.length <= 3 && ['--dry-run', '--apply', '--verify'].includes(mode),
        'use --dry-run, --apply or --verify');
    const limit = Number(env.MIGRATION_PAGE_SIZE ?? 100);
    requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 500, 'MIGRATION_PAGE_SIZE must be 1–500');
    const target = mode !== '--dry-run' ? targetSettings() : null;
    phase = 'opening source';
    const source = await openSource();
    let client;
    try {
        if (!env.MIGRATION_SOURCE_SQLITE && target) {
            console.log('D1 pagination is not a snapshot; keep writers frozen for the final verified apply and cutover.');
        }
        if (mode !== '--verify') {
            for (const table of Object.keys(tables)) {
                phase = `sampling ${table}`;
                const sample = await page(source, table, null, mode === '--dry-run' ? limit : 1);
                if (mode === '--dry-run') console.log(`${table}: validated ${sample.length} sample rows`);
            }
        }
        if (!target) return;

        phase = 'checking isolated PostgreSQL target';
        const { Client } = await import('pg');
        client = new Client({ connectionString: target.connectionString, connectionTimeoutMillis: 10_000 });
        await client.connect();
        const { rows: [identity] } = await client.query(`SELECT pg_catalog.current_database() AS db,
            pg_catalog.current_setting('server_encoding') AS encoding`);
        requireValue(identity.db === target.database && identity.encoding === 'UTF8',
            'connected PostgreSQL database name or UTF8 encoding does not match');
        await client.query("SET search_path TO public, pg_catalog; SET DateStyle TO 'ISO, YMD';"
            + " SET statement_timeout TO '60s'; SET lock_timeout TO '10s'");
        const { rows: [{ locked }] } = await client.query('SELECT pg_catalog.pg_try_advisory_lock($1::bigint) AS locked',
            [lockId]);
        requireValue(locked, 'another migration or verification is active on this target');
        const checkpoint = await initOrResume(client, source, mode === '--apply');
        if (mode === '--apply') {
            for (const [table, progress] of checkpoint) {
                phase = `loading ${table}`;
                await load(client, source, table, progress, limit);
            }
        } else {
            requireValue([...checkpoint.values()].every(row => row.complete), 'target load is incomplete; rerun --apply');
        }
        await transaction(client, async () => {
            const pgSource = { query: async (text, values) => (await client.query({ text, values, rowMode: 'array' })).rows };
            for (const table of Object.keys(tables)) {
                phase = `verifying ${table}`;
                const original = await digest(source, table, limit, false);
                const copied = await digest(pgSource, table, limit, true);
                requireValue(original.count === copied.count && original.digest === copied.digest,
                    'source and target differ; do not cut over (freeze source writes and start with a fresh target)');
                console.log(`${table}: verified ${copied.count} rows (digest matched)`);
            }
        }, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    } finally {
        try {
            if (client) await client.end();
        } finally {
            source.close();
        }
    }
}

let phase = 'validating arguments';
main().catch(error => {
    // Provider error text, raw rows, cursor values, and connection details may contain secrets.
    const code = /^[0-9A-Z_]{2,40}$/.test(error?.code || '') ? ` (${error.code})` : '';
    console.error(`Backfill stopped while ${phase}: ${error instanceof BackfillError ? error.message : `operation failed${code}`}`);
    process.exitCode = 1;
});
