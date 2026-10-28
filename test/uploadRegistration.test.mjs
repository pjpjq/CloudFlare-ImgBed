import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { onRequest } from '../functions/api/uploadRelay/[[action]].js';
import { getDatabase } from '../functions/utils/databaseAdapter.js';
import { authenticateUploadRelay, signUploadRelay, UploadRelayError } from '../functions/utils/uploadRelayAuth.js';
import { checkpointUploadedFile, getUploadRegistration, registerUploadedFile, stageUploadedFile } from '../functions/utils/uploadRegistration.js';
import { claimUploadLease, releaseUploadLease } from '../functions/utils/uploadRelayLease.js';
import { beginUploadTransfer, getUploadTransfer, checkpointUploadPart } from '../functions/utils/uploadRelayTransfer.js';

const SECRET = 'unit-test-only-relay-secret-32-bytes';
const UPLOAD_ID = 'a'.repeat(64);
const FILE_ID = `catalyst_${UPLOAD_ID}.png`;
const NOW = 1793184000000;

class TestD1 {
    constructor() {
        this.sqlite = new DatabaseSync(':memory:');
        this.failIndex = false;
    }

    prepare(sql) {
        const database = this;
        return {
            params: [],
            bind(...params) {
                this.params = params.map(value => value === undefined ? null : typeof value === 'boolean' ? Number(value) : value);
                return this;
            },
            async first() {
                return database.sqlite.prepare(sql).get(...this.params) ?? null;
            },
            async all() {
                return { results: database.sqlite.prepare(sql).all(...this.params) };
            },
            async run() {
                if (database.failIndex && sql.includes('index_operations')) throw new Error('simulated_index_failure');
                if (database.beforeIndexWrite && sql.includes('index_operations')) await database.beforeIndexWrite();
                const result = database.sqlite.prepare(sql).run(...this.params);
                return { success: true, meta: { changes: Number(result.changes) } };
            },
        };
    }
}

function fixture(t) {
    const primary = new TestD1();
    const index = new TestD1();
    primary.sqlite.exec(readFileSync(new URL('../database/init.sql', import.meta.url), 'utf8'));
    primary.sqlite.exec(readFileSync(new URL('../database/upload-relay.sql', import.meta.url), 'utf8'));
    index.sqlite.exec(readFileSync(new URL('../database/index.sql', import.meta.url), 'utf8'));
    t.after(() => { primary.sqlite.close(); index.sqlite.close(); });
    return { env: { img_d1: primary, img_index: index }, primary, index };
}

function receipt() {
    return {
        uploadId: UPLOAD_ID,
        fileId: FILE_ID,
        records: [{
            id: FILE_ID,
            value: '',
            metadata: {
                FileName: 'chart.png', FileType: 'image/png', FileSize: '0.01', FileSizeBytes: 16,
                TimeStamp: NOW, Channel: 'TelegramNew', ChannelName: 'original-channel',
                TgFileId: 'provider-file-id', Directory: '', Label: 'None', ListType: 'None', Tags: [],
            },
        }],
    };
}

async function signedRequest(payload, path = '/api/uploadRelay/register', now = Date.now()) {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(now / 1000));
    const signature = await signUploadRelay(SECRET, 'POST', path, body, timestamp);
    return new Request('https://imgbed.test' + path, {
        method: 'POST', body,
        headers: { 'content-type': 'application/json', 'x-upload-timestamp': timestamp, 'x-upload-signature': signature },
    });
}

test('HMAC binds method, route, timestamp and exact metadata body', async () => {
    const request = await signedRequest(receipt(), undefined, NOW);
    assert.deepEqual(await authenticateUploadRelay(request.clone(), SECRET, NOW), receipt());
    const tampered = new Request('https://imgbed.test/api/uploadRelay/status', {
        method: 'POST', body: JSON.stringify(receipt()), headers: request.headers,
    });
    await assert.rejects(authenticateUploadRelay(tampered, SECRET, NOW), { status: 401 });
    await assert.rejects(authenticateUploadRelay(request.clone(), SECRET, NOW + 301_000), { status: 401 });
    await assert.rejects(authenticateUploadRelay(request.clone(), '', NOW), { status: 404 });
});

test('rejects image-sized bodies before metadata parsing or D1 access', async () => {
    const request = await signedRequest(receipt(), undefined, NOW);
    const headers = new Headers(request.headers);
    headers.set('content-length', '1048576');
    await assert.rejects(authenticateUploadRelay(new Request(request, { headers }), SECRET, NOW), { status: 413 });
    const oversized = { padding: 'x'.repeat(32769) };
    await assert.rejects(authenticateUploadRelay(await signedRequest(oversized, undefined, NOW), SECRET, NOW), { status: 413 });
});

test('registration writes primary metadata and one index operation without changing legacy records', async t => {
    const { env, primary, index } = fixture(t);
    const db = getDatabase(env);
    await db.put('old-image.png', 'old-value', { metadata: { FileName: 'old-image.png', Channel: 'TelegramNew' } });
    const before = await db.getWithMetadata('old-image.png');
    const response = await registerUploadedFile({ env }, receipt(), NOW);
    assert.deepEqual(response, [{ src: '/file/' + FILE_ID }]);
    const saved = await db.getWithMetadata(FILE_ID);
    assert.equal(saved.metadata.TgFileId, 'provider-file-id');
    assert.equal(saved.metadata.ChannelName, 'original-channel');
    assert.deepEqual(await db.getWithMetadata('old-image.png'), before);
    assert.equal(primary.sqlite.prepare('SELECT COUNT(*) AS n FROM index_operations').get().n, 0);
    assert.equal(index.sqlite.prepare('SELECT COUNT(*) AS n FROM index_operations').get().n, 1);
    assert.equal(primary.sqlite.prepare('SELECT COUNT(*) AS n FROM upload_relay_registrations').get().n, 0);
});

test('a lost successful HTTP response can be replayed without another index operation', async t => {
    const { env, index } = fixture(t);
    await registerUploadedFile({ env }, receipt(), NOW);
    await registerUploadedFile({ env }, receipt(), NOW + 1);
    const state = await getUploadRegistration(env, UPLOAD_ID, FILE_ID);
    assert.equal(state.state, 'complete');
    assert.equal(index.sqlite.prepare('SELECT COUNT(*) AS n FROM index_operations').get().n, 1);
});

test('index failure retains a receipt and retry completes without storage re-upload', async t => {
    const { env, primary, index } = fixture(t);
    index.failIndex = true;
    await assert.rejects(registerUploadedFile({ env }, receipt(), NOW), { status: 503 });
    assert.equal(primary.sqlite.prepare('SELECT COUNT(*) AS n FROM files').get().n, 1);
    const pending = await getUploadRegistration(env, UPLOAD_ID, FILE_ID);
    assert.equal(pending.state, 'uploaded');
    assert.deepEqual(pending.receipt, receipt());
    index.failIndex = false;
    await registerUploadedFile({ env }, pending.receipt, NOW + 1);
    assert.equal((await getUploadRegistration(env, UPLOAD_ID, FILE_ID)).state, 'complete');
    assert.equal(index.sqlite.prepare('SELECT COUNT(*) AS n FROM index_operations').get().n, 1);
});

test('concurrent duplicate callbacks have only one registration lease', async t => {
    const { env, index } = fixture(t);
    let entered;
    let release;
    const started = new Promise(resolve => { entered = resolve; });
    const paused = new Promise(resolve => { release = resolve; });
    index.beforeIndexWrite = async () => { entered(); await paused; };
    const first = registerUploadedFile({ env }, receipt(), NOW);
    await started;
    try {
        await assert.rejects(registerUploadedFile({ env }, receipt(), NOW), {
            status: 409, message: 'registration_in_progress',
        });
    } finally {
        release();
    }
    await first;
    index.beforeIndexWrite = null;
    await registerUploadedFile({ env }, receipt(), NOW + 1);
    assert.equal(index.sqlite.prepare('SELECT COUNT(*) AS n FROM index_operations').get().n, 1);
});

test('changed receipts and collisions cannot overwrite an existing file', async t => {
    const { env } = fixture(t);
    await registerUploadedFile({ env }, receipt(), NOW);
    const changed = receipt();
    changed.records[0].metadata.TgFileId = 'another-provider-id';
    await assert.rejects(registerUploadedFile({ env }, changed, NOW + 1), { status: 409 });
    assert.equal((await getDatabase(env).getWithMetadata(FILE_ID)).metadata.TgFileId, 'provider-file-id');
});

test('sensitive provider credentials are removed from both durable receipt and file metadata', async t => {
    const { env, primary, index } = fixture(t);
    const input = receipt();
    input.records[0].metadata.TgBotToken = 'must-not-persist';
    input.records[0].metadata.TgChatId = 'config-only-chat';
    index.failIndex = true;
    await assert.rejects(registerUploadedFile({ env }, input, NOW));
    assert.ok(!primary.sqlite.prepare('SELECT receipt FROM upload_relay_registrations').get().receipt.includes('must-not-persist'));
    const saved = await getDatabase(env).getWithMetadata(FILE_ID);
    assert.equal(saved.metadata.TgBotToken, undefined);
    assert.equal(saved.metadata.TgChatId, undefined);
});

test('rejects non-private namespaces, duplicate records, missing main record and malformed metadata', async t => {
    const { env } = fixture(t);
    for (const change of [
        value => { value.fileId = 'old-image.png'; },
        value => { value.records.push(structuredClone(value.records[0])); },
        value => { value.records[0].id += '_chunk_0'; },
        value => { value.uploadId = [UPLOAD_ID]; },
        value => { value.records[0].metadata = []; },
    ]) {
        const input = receipt();
        change(input);
        await assert.rejects(registerUploadedFile({ env }, input, NOW), { status: 400 });
    }
});

test('new endpoint is disabled without a secret and never exposes internal errors', async t => {
    const { env } = fixture(t);
    const context = { env, params: { action: ['register'] }, request: await signedRequest(receipt()) };
    assert.equal((await onRequest(context)).status, 404);
    context.env.CATALYST_RELAY_SECRET = SECRET;
    context.request = await signedRequest(receipt());
    assert.equal((await onRequest(context)).status, 200);
    const tampered = await signedRequest(receipt());
    tampered.headers.set('x-upload-signature', '0'.repeat(64));
    assert.equal((await onRequest({ ...context, request: tampered })).status, 401);
});

test('checkpoint persists only sanitized receipt before files or index are written', async t => {
    const { env, primary, index } = fixture(t);
    const input = receipt();
    input.records[0].metadata.TgBotToken = 'private-provider-token';
    const saved = await checkpointUploadedFile({ env }, input, NOW);
    assert.equal(saved.state, 'uploaded');
    assert.equal(saved.receipt.records[0].metadata.TgBotToken, undefined);
    assert.equal(primary.sqlite.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
    assert.equal(index.sqlite.prepare('SELECT COUNT(*) AS n FROM index_operations').get().n, 0);
    await registerUploadedFile({ env }, saved.receipt, NOW + 1);
    assert.equal((await getUploadRegistration(env, UPLOAD_ID, FILE_ID)).state, 'complete');
});

function job(id = UPLOAD_ID) {
    return { uploadId: id, fileId: `catalyst_${id}.png`, owner: crypto.randomUUID() };
}
const testProfile = async () => ({ upload: {}, security: { upload: {} }, page: {}, blockedIPs: '' });

test('upload lease fences duplicate and concurrent instances and expires without manual cleanup', async t => {
    const { env, primary } = fixture(t);
    const first = job();
    assert.equal((await claimUploadLease({ env }, first, NOW, testProfile)).state, 'claimed');
    await assert.rejects(claimUploadLease({ env }, job(), NOW, testProfile), { status: 409 });
    const second = job('b'.repeat(64));
    await claimUploadLease({ env }, second, NOW, testProfile);
    await assert.rejects(claimUploadLease({ env }, job('c'.repeat(64)), NOW, testProfile), { status: 429 });
    await releaseUploadLease(env, { ...first, owner: crypto.randomUUID() });
    assert.equal(primary.sqlite.prepare('SELECT COUNT(*) AS n FROM upload_relay_jobs').get().n, 2);
    await releaseUploadLease(env, first);
    assert.equal((await claimUploadLease({ env }, job('c'.repeat(64)), NOW, testProfile)).state, 'claimed');
    assert.equal((await claimUploadLease({ env }, job(), NOW + 45_001, testProfile)).state, 'claimed');
});

test('global minute limit survives independent leases and resets at next minute', async t => {
    const { env } = fixture(t);
    for (let i = 0; i < 20; i++) {
        const attempt = job(i.toString(16).padStart(64, '0'));
        await claimUploadLease({ env }, attempt, NOW, testProfile);
        await releaseUploadLease(env, attempt);
    }
    await assert.rejects(claimUploadLease({ env }, job(), NOW, testProfile), { status: 429 });
    assert.equal((await claimUploadLease({ env }, job(), NOW + 60_000, testProfile)).state, 'claimed');
});

test('uploaded receipt bypasses new provider lease and config failure releases its lease', async t => {
    const { env, primary } = fixture(t);
    await checkpointUploadedFile({ env }, receipt(), NOW);
    const saved = await claimUploadLease({ env }, job(), NOW, () => { throw new Error('must not load'); });
    assert.equal(saved.state, 'uploaded');
    await assert.rejects(claimUploadLease({ env }, job('b'.repeat(64)), NOW, async () => { throw new Error('profile unavailable'); }));
    assert.equal(primary.sqlite.prepare('SELECT COUNT(*) AS n FROM upload_relay_jobs').get().n, 0);
});

const CHUNK_SIZE = 16 * 1024 * 1024;
function transfer() {
    return { uploadId: UPLOAD_ID, fileId: FILE_ID, manifest: { fileName: 'chart.png', contentType: 'image/png',
        fileSize: CHUNK_SIZE + 1, chunkSize: CHUNK_SIZE, totalChunks: 2, channel: 'TelegramNew', channelName: 'original-channel',
        metadata: { ...receipt().records[0].metadata, IsChunked: true, TotalChunks: 2, TgBotToken: 'never-persist' } } };
}
function part(index) {
    return { uploadId: UPLOAD_ID, fileId: FILE_ID, part: { index, fileId: `provider-part-${index}`, fileName: `chart.png.part00${index}`,
        size: index ? 1 : CHUNK_SIZE, sha256: String(index + 1).repeat(64),
        ...(index ? { digest: UPLOAD_ID } : { hashState: { words: Array(8).fill(0), bytesHashed: CHUNK_SIZE } }) } };
}

test('transfer ledger persists metadata and block-aligned hash words, never publishes incomplete files', async t => {
    const { env, primary, index } = fixture(t);
    const first = await beginUploadTransfer(env, transfer(), NOW);
    assert.equal(first.transfer.manifest.metadata.TgBotToken, undefined);
    await beginUploadTransfer(env, transfer(), NOW + 1);
    assert.equal(primary.sqlite.prepare('SELECT COUNT(*) AS n FROM upload_relay_transfers').get().n, 1);
    await checkpointUploadPart(env, part(0));
    const loaded = await getUploadTransfer(env, { uploadId: UPLOAD_ID, fileId: FILE_ID });
    assert.deepEqual(Object.keys(loaded.transfer.parts[0].hashState).sort(), ['bytesHashed', 'words']);
    assert.equal(primary.sqlite.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
    assert.equal(index.sqlite.prepare('SELECT COUNT(*) AS n FROM index_operations').get().n, 0);
    const changed = transfer();
    changed.manifest.fileSize++;
    await assert.rejects(beginUploadTransfer(env, changed), { status: 409 });
});

test('duplicate part ACK preserves the first provider ID; different content and unordered parts are rejected', async t => {
    const { env } = fixture(t);
    await beginUploadTransfer(env, transfer(), NOW);
    await assert.rejects(checkpointUploadPart(env, part(1)), { status: 409 });
    await checkpointUploadPart(env, part(0));
    const duplicate = part(0);
    duplicate.part.fileId = 'duplicate-provider-file';
    const saved = await checkpointUploadPart(env, duplicate);
    assert.equal(saved.transfer.parts[0].fileId, 'provider-part-0');
    duplicate.part.sha256 = 'f'.repeat(64);
    await assert.rejects(checkpointUploadPart(env, duplicate), { status: 409 });
    const malformed = part(1);
    malformed.part.digest = 'f'.repeat(64);
    await assert.rejects(checkpointUploadPart(env, malformed), { status: 400 });
    const first = part(0);
    first.part.hashState.bytesHashed++;
    await assert.rejects(checkpointUploadPart(env, first), { status: 400 });
});

test('final registration removes transfer state only after a durable full receipt exists', async t => {
    const { env, primary, index } = fixture(t);
    await beginUploadTransfer(env, transfer(), NOW);
    await checkpointUploadPart(env, part(0));
    await checkpointUploadPart(env, part(1));
    const full = receipt();
    full.records[0].metadata.IsChunked = true;
    full.records[0].metadata.TotalChunks = 2;
    full.records[0].value = JSON.stringify([part(0).part, part(1).part]);
    index.failIndex = true;
    await assert.rejects(registerUploadedFile({ env }, full, NOW), { status: 503 });
    assert.equal(primary.sqlite.prepare('SELECT COUNT(*) AS n FROM upload_relay_transfers').get().n, 0);
    assert.equal((await getUploadRegistration(env, UPLOAD_ID, FILE_ID)).state, 'uploaded');
    index.failIndex = false;
    await registerUploadedFile({ env }, full, NOW + 1);
    assert.equal((await getUploadRegistration(env, UPLOAD_ID, FILE_ID)).state, 'complete');
});

test('private-storage staging is readable but not complete or indexed until moderation finishes', async t => {
    const { env, index } = fixture(t);
    const input = receipt();
    input.records[0].metadata.Channel = 'S3';
    input.records[0].metadata.S3FileKey = FILE_ID;
    input.records[0].metadata.accessKeyId = 'must-not-persist';
    const saved = await stageUploadedFile({ env }, input);
    assert.equal(saved.state, 'staged');
    assert.equal((await getDatabase(env).getWithMetadata(FILE_ID)).metadata.S3FileKey, FILE_ID);
    assert.ok(!JSON.stringify(saved).includes('must-not-persist'));
    assert.equal(index.sqlite.prepare('SELECT COUNT(*) AS n FROM index_operations').get().n, 0);
    const final = saved.receipt;
    final.records[0].metadata.Label = 'adult';
    await registerUploadedFile({ env }, final, NOW);
    assert.equal((await getUploadRegistration(env, UPLOAD_ID, FILE_ID)).state, 'complete');
    assert.equal((await getDatabase(env).getWithMetadata(FILE_ID)).metadata.Label, 'adult');
    assert.equal((await getDatabase(env).getWithMetadata(FILE_ID)).metadata.UploadRelayStagedId, undefined);
    await stageUploadedFile({ env }, input);
    assert.equal((await getDatabase(env).getWithMetadata(FILE_ID)).metadata.Label, 'adult');
});

test('staged storage reference cannot be replaced by final registration or collide with old files', async t => {
    const { env } = fixture(t);
    const input = receipt();
    input.records[0].metadata.Channel = 'WebDAV';
    input.records[0].metadata.WebDAVFilePath = FILE_ID;
    const staged = await stageUploadedFile({ env }, input);
    staged.receipt.records[0].metadata.WebDAVFilePath = 'different-original-object';
    await assert.rejects(stageUploadedFile({ env }, staged.receipt), { status: 409 });
    await assert.rejects(registerUploadedFile({ env }, staged.receipt), { status: 409 });
    assert.equal((await getDatabase(env).getWithMetadata(FILE_ID)).metadata.WebDAVFilePath, FILE_ID);
});

test('legacy files with empty or JSON-null metadata are conflicts, never overwritten or TypeErrors', async t => {
    for (const metadata of ['{}', 'null']) await t.test(metadata, async t => {
        const { env, primary } = fixture(t);
        primary.sqlite.prepare('INSERT INTO files (id, value, metadata) VALUES (?, ?, ?)').run(FILE_ID, 'legacy-value', metadata);
        await assert.rejects(getUploadRegistration(env, UPLOAD_ID, FILE_ID), { status: 409 });
        const input = receipt();
        input.records[0].metadata.Channel = 'S3';
        await assert.rejects(stageUploadedFile({ env }, input), { status: 409 });
        await assert.rejects(registerUploadedFile({ env }, input), { status: 409 });
        assert.deepEqual({ ...primary.sqlite.prepare('SELECT value, metadata FROM files WHERE id = ?').get(FILE_ID) },
            { value: 'legacy-value', metadata });
    });
});
