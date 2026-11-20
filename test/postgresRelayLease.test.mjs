import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import pg from 'pg';

import { getDatabase } from '../functions/utils/databaseAdapter.js';
import { fetchSecurityConfig } from '../functions/utils/sysConfig.js';
import { checkpointUploadedFile, getUploadRegistration, registerUploadedFile } from '../functions/utils/uploadRegistration.js';
import { claimUploadLease, releaseUploadLease } from '../functions/utils/uploadRelayLease.js';
import { beginUploadTransfer, checkpointUploadPart } from '../functions/utils/uploadRelayTransfer.js';

const connectionString = process.env.IMGBED_TEST_POSTGRES_URL;
const NOW = 1_793_184_000_000;
const CHUNK_SIZE = 16 * 1024 * 1024;
const readSql = name => readFileSync(new URL(`../database/${name}`, import.meta.url), 'utf8');

function job(id) {
    const uploadId = id.toString(16).padStart(64, '0');
    return { uploadId, fileId: `catalyst_${uploadId}.png`, owner: randomUUID() };
}

test('relay claims and receipts on PostgreSQL with a separate SQLite index', { skip: !connectionString }, async t => {
    const schema = `imgbed_relay_${randomUUID().replaceAll('-', '')}`;
    const client = new pg.Client({ connectionString });
    await client.connect();
    t.after(async () => {
        try {
            await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
            await client.end();
        }
    });
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`);
    await client.query(readSql('postgres-primary.sql'));
    const primary = new URL(connectionString);
    primary.searchParams.set('options', `-csearch_path=${schema}`);

    const index = new DatabaseSync(':memory:');
    t.after(() => index.close());
    index.exec(readSql('index.sql'));
    const env = { IMG_PRIMARY_PG: { connectionString: primary.toString() }, img_index: {
        prepare: sql => ({ bind: (...args) => ({ run: async () => index.prepare(sql).run(...args) }) }),
    } };
    const context = { env };

    await t.test('parallel claims fence duplicate owners and preserve the global cap and rate counter', async () => {
        const claim = payload => claimUploadLease(context, payload, NOW, async () => ({}));
        const duplicates = [job(0), job(0)];
        const duplicateResults = await Promise.allSettled(duplicates.map(claim));
        assert.equal(duplicateResults.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(duplicateResults.find(result => result.status === 'rejected').reason.message, 'upload_in_progress');
        const winner = duplicateResults.findIndex(result => result.status === 'fulfilled');
        assert.equal(duplicateResults[winner].value.leaseUntil, NOW + 45_000);
        await releaseUploadLease(env, duplicates[winner]);

        const attempts = Array.from({ length: 8 }, (_, i) => job(i + 1));
        const results = await Promise.allSettled(attempts.map(claim));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
        for (const result of results.filter(item => item.status === 'rejected')) {
            assert.equal(result.reason.message, 'upload_concurrency_limited');
        }
        assert.equal((await client.query('SELECT starts FROM upload_relay_rate WHERE id = 1')).rows[0].starts, 9);
        assert.equal((await client.query('SELECT count(*)::int AS count FROM upload_relay_jobs')).rows[0].count, 2);
        await Promise.all(attempts.filter((_, i) => results[i].status === 'fulfilled').map(payload => releaseUploadLease(env, payload)));
    });

    await t.test('chunk checkpoints and repeat registrations publish one record and one index operation', async () => {
        const { uploadId, fileId } = job(25);
        const fileName = 'chart.png';
        const metadata = { FileName: fileName, Channel: 'TelegramNew', TimeStamp: NOW, IsChunked: true, TotalChunks: 2 };
        const manifest = { fileName, contentType: 'image/png', fileSize: CHUNK_SIZE + 1, chunkSize: CHUNK_SIZE,
            totalChunks: 2, channel: 'TelegramNew', channelName: 'test', metadata };
        const transfer = await beginUploadTransfer(env, { uploadId, fileId, manifest }, NOW);
        assert.equal(transfer.transfer.createdAt, NOW);
        const first = { index: 0, fileId: 'provider-first', fileName: `${fileName}.part000`, size: CHUNK_SIZE,
            sha256: 'f'.repeat(64), hashState: { words: Array(8).fill(0), bytesHashed: CHUNK_SIZE } };
        const duplicate = { ...first, fileId: 'provider-retry' };
        const [part1, part2] = await Promise.all([first, duplicate].map(part => checkpointUploadPart(env, { uploadId, fileId, part })));
        assert.deepEqual(part1, part2);
        const last = { index: 1, fileId: 'provider-last', fileName: `${fileName}.part001`, size: 1,
            sha256: 'e'.repeat(64), digest: uploadId };
        const completed = await checkpointUploadPart(env, { uploadId, fileId, part: last });
        assert.equal(completed.transfer.parts.length, 2);

        const payload = { uploadId, fileId, records: [{ id: fileId,
            value: JSON.stringify(completed.transfer.parts), metadata }] };
        assert.equal((await checkpointUploadedFile(context, payload, NOW)).state, 'uploaded');
        assert.equal((await checkpointUploadedFile(context, payload, NOW)).state, 'uploaded');
        const expected = [{ src: `/file/${fileId}` }];
        assert.deepEqual(await registerUploadedFile(context, payload, NOW), expected);
        assert.deepEqual(await registerUploadedFile(context, payload, NOW), expected);
        assert.deepEqual(await getUploadRegistration(env, uploadId, fileId), { state: 'complete', result: expected });
        assert.equal((await client.query('SELECT count(*)::int AS count FROM upload_relay_transfers')).rows[0].count, 0);
        assert.equal(index.prepare('SELECT count(*) AS count FROM index_operations').get().count, 1);
    });

    await t.test('existing file URL keeps its R2 key and PG settings errors fail closed', async () => {
        await import('../deploy/server/register.mjs');
        const { onRequest: readFile } = await import('../functions/file/[[path]].js');
        const id = 'legacy/old.png';
        await getDatabase(env).put(id, '', { metadata: {
            FileName: 'old.png', FileType: 'image/png', Channel: 'CloudflareR2', Label: 'None', ListType: 'None',
        } });
        const response = await readFile({
            request: new Request(`https://imgbed.test/file/${id}`), params: { path: ['legacy', 'old.png'] }, data: {},
            env: { ...env, img_r2: { async get(key) {
                assert.equal(key, id);
                return { body: new Uint8Array([137, 80, 78, 71]), writeHttpMetadata() {} };
            } } },
        });
        assert.equal(response.status, 200);
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([137, 80, 78, 71]));
        const missing = new URL(primary);
        missing.searchParams.set('host', `/tmp/imgbed-no-server-${schema}`);
        await assert.rejects(fetchSecurityConfig({ ...env, IMG_PRIMARY_PG: { connectionString: missing.href } }),
            { code: 'ENOENT' });
    });
});
