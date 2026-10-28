import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createGateway } from '../../deploy/catalyst/gateway.mjs';
import { computeUploadId, signUploadRelay } from '../../deploy/catalyst/utils/crypto.js';
import { onRequest as cfRelay } from '../../functions/api/uploadRelay/[[action]].js';
import { onRequest as readFile } from '../../functions/file/[[path]].js';
import { getDatabase } from '../../functions/utils/databaseAdapter.js';
import { hashPart } from '../../deploy/catalyst/hashProgress.mjs';
import { currentSignal } from '../../deploy/catalyst/runtime.mjs';

const env = { CATALYST_UPLOAD_TOKEN: 'dummy-client-token-not-real-32-bytes',
    CATALYST_RELAY_SECRET: 'dummy-service-secret-not-real-32-bytes', CF_IMGBED_URL: 'https://imgbed.test' };
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const manifest = { fileName: '作者_📈.png', contentType: 'image/png' };
const identity = { uploadId: computeUploadId(bytes, manifest.fileName, manifest.contentType) };
identity.fileId = `catalyst_${identity.uploadId}.png`;
const result = [{ src: '/file/' + identity.fileId }];

function request(action = 'upload', body, options = {}) {
    if (action === 'upload') {
        body = new FormData();
        const actual = options.manifest || manifest;
        body.append('file', new File([options.bytes || bytes], actual.fileName, { type: actual.contentType }));
        body.append('manifest', JSON.stringify(actual));
    }
    return new Request('https://gateway.test/server/imgbed_upload/execute?action=' + action, {
        method: 'POST', headers: { 'X-Upload-Token': env.CATALYST_UPLOAD_TOKEN,
            ...(action === 'upload' ? { 'Idempotency-Key': options.id || identity.uploadId } : { 'Content-Type': 'application/json' }) },
        body: action === 'upload' ? body : JSON.stringify(body),
    });
}

function fixture(options = {}) {
    let receipt;
    let complete = false;
    let uploads = 0;
    let failCheckpoint = false;
    let failRegister = false;
    const calls = [];
    const profile = { upload: { telegram: { channels: [{ name: 'original-tg', botToken: 'private-provider-token',
        chatId: 'dummy-chat' }], loadBalance: { enabled: false } } },
        security: { upload: { moderate: { enabled: false }, ipQuery: { enabled: false } } },
        page: { config: [] }, blockedIPs: '' };
    const relay = async (action, payload) => {
        calls.push({ action, payload });
        assert.ok(!Buffer.isBuffer(payload));
        if (action === 'status') return complete ? { state: 'complete', result } : receipt ? { state: 'uploaded', receipt } : { state: 'missing' };
        if (action === 'claim') return { state: 'claimed', leaseUntil: Date.now() + 45_000, profile };
        if (action === 'release') return { released: true };
        if (action === 'checkpoint') {
            if (failCheckpoint) throw new Error('private upstream details');
            receipt = payload;
            return { state: 'uploaded', receipt };
        }
        if (action === 'register') {
            if (failRegister) throw new Error('private index details');
            complete = true;
            return result;
        }
        throw new Error('unexpected operation');
    };
    const upload = async (file, actual, config, id) => {
        uploads++;
        assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array(bytes));
        assert.equal(actual.fileName, manifest.fileName);
        assert.deepEqual(id, identity);
        return { ...id, records: [{ id: id.fileId, value: '', metadata: { Channel: 'TelegramNew',
            ChannelName: 'original-tg', FileName: actual.fileName, TgFileId: 'dummy-file', TgBotToken: 'must-not-escape' } }] };
    };
    return { gateway: createGateway({ env, relay, ...(!options.realStorage ? { upload } : {}) }), calls, profile,
        get uploads() { return uploads; }, get receipt() { return receipt; },
        set failCheckpoint(value) { failCheckpoint = value; }, set failRegister(value) { failRegister = value; } };
}

test('gateway authenticates before parsing body or touching storage/CF', async () => {
    const f = fixture();
    const input = request();
    input.headers.set('X-Upload-Token', 'wrong');
    assert.equal((await f.gateway(input)).status, 401);
    const oauthOnly = request();
    oauthOnly.headers.delete('X-Upload-Token');
    oauthOnly.headers.set('Authorization', `Bearer ${env.CATALYST_UPLOAD_TOKEN}`);
    assert.equal((await f.gateway(oauthOnly)).status, 401);
    assert.equal(f.calls.length, 0);
    assert.equal(f.uploads, 0);
});

test('stable Unicode content ID uploads once and sends only sanitized metadata to CF', async () => {
    const f = fixture();
    assert.deepEqual(await (await f.gateway(request())).json(), result);
    assert.deepEqual(await (await f.gateway(request())).json(), result);
    assert.equal(f.uploads, 1);
    assert.equal(f.receipt.records[0].metadata.TgBotToken, undefined);
    assert.ok(!JSON.stringify(f.receipt).includes('must-not-escape'));
    assert.deepEqual(f.calls.map(call => call.action), ['status', 'claim', 'checkpoint', 'register', 'release', 'status']);
});

test('storage success and CF outage returns a signed receipt that registers without another upload', async () => {
    const f = fixture();
    f.failCheckpoint = true;
    const response = await f.gateway(request());
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.state, 'uploaded');
    assert.match(body.receipt.signature, /^[a-f0-9]{64}$/);
    assert.ok(!body.receipt.payload.includes('must-not-escape'));
    f.failCheckpoint = false;
    assert.deepEqual(await (await f.gateway(request('register', { receipt: body.receipt }))).json(), result);
    assert.equal(f.uploads, 1);
});

test('index outage is recoverable from CF status and receipt, not provider reupload', async () => {
    const f = fixture();
    f.failRegister = true;
    assert.equal((await f.gateway(request())).status, 202);
    const saved = await (await f.gateway(request('status', { ...identity, ...manifest }))).json();
    assert.equal(saved.state, 'uploaded');
    f.failRegister = false;
    assert.deepEqual(await (await f.gateway(request('register', { receipt: saved.receipt }))).json(), result);
    assert.equal(f.uploads, 1);
});

test('forged receipts and wrong content hashes are rejected before CF/storage', async () => {
    const f = fixture();
    assert.equal((await f.gateway(request('register', { receipt: { payload: '{}', signature: '0'.repeat(64) } }))).status, 400);
    assert.equal((await f.gateway(request('upload', null, { id: '0'.repeat(64) }))).status, 409);
    assert.equal(f.calls.length, 0);
    assert.equal(f.uploads, 0);
});

test('real upstream Telegram handler runs locally and preserves file metadata', async () => {
    const f = fixture({ realStorage: true });
    const previous = globalThis.fetch;
    let sent = 0;
    globalThis.fetch = async (input, options) => {
        const url = String(input);
        assert.ok(url.startsWith('https://api.telegram.org/'));
        if (url.includes('/getFile?')) return Response.json({ ok: true, result: { file_path: 'dummy.png' } });
        sent++;
        const file = options.body.get('photo');
        assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array(bytes));
        return Response.json({ ok: true, result: { photo: [{ file_id: 'provider-file', file_size: bytes.length }] } });
    };
    try {
        const response = await f.gateway(request());
        assert.equal(response.status, 200);
        assert.equal(sent, 1);
        assert.equal(f.receipt.records[0].metadata.TgFileId, 'provider-file');
        assert.equal(f.receipt.records[0].metadata.FileName, manifest.fileName);
        assert.equal(f.receipt.records[0].metadata.ChannelName, 'original-tg');
    } finally { globalThis.fetch = previous; }
});

test('large images reuse upstream Telegram chunk format rather than truncating or skipping', async () => {
    const f = fixture({ realStorage: true });
    const large = new Uint8Array(16 * 1024 * 1024 + 1);
    large.set(bytes);
    const largeId = computeUploadId(large, manifest.fileName, manifest.contentType);
    const previous = globalThis.fetch;
    let sent = 0;
    globalThis.fetch = async (input, options) => {
        assert.ok(String(input).includes('/sendDocument'));
        sent++;
        const file = options.body.get('document');
        return Response.json({ ok: true, result: { document: { file_id: `part-${sent}`, file_size: file.size } } });
    };
    try {
        const response = await f.gateway(request('upload', null, { bytes: large, id: largeId }));
        assert.equal(response.status, 200);
        assert.equal(sent, 2);
        const main = f.receipt.records[0];
        assert.equal(main.id, `catalyst_${largeId}.png`);
        assert.equal(main.metadata.IsChunked, true);
        const parts = JSON.parse(main.value);
        assert.deepEqual(parts.map(part => part.fileId), ['part-1', 'part-2']);
        assert.equal(parts.reduce((sum, part) => sum + part.size, 0), large.length);
    } finally { globalThis.fetch = previous; }
});

function d1Fixture(t) {
    const make = () => {
        const sqlite = new DatabaseSync(':memory:');
        const adapter = { sqlite, failIndex: false, prepare(sql) {
            let params = [];
            return { bind(...values) { params = values; return this; },
                async first() { return sqlite.prepare(sql).get(...params) || null; },
                async all() { return { results: sqlite.prepare(sql).all(...params) }; },
                async run() {
                    if (adapter.failIndex && sql.includes('index_operations')) throw new Error('index-offline');
                    const changed = sqlite.prepare(sql).run(...params);
                    return { success: true, meta: { changes: Number(changed.changes) } };
                } };
        } };
        t.after(() => sqlite.close());
        return adapter;
    };
    const primary = make();
    const index = make();
    primary.sqlite.exec(readFileSync('database/init.sql', 'utf8'));
    primary.sqlite.exec(readFileSync('database/upload-relay.sql', 'utf8'));
    index.sqlite.exec(readFileSync('database/index.sql', 'utf8'));
    const cfEnv = { img_d1: primary, img_index: index, CATALYST_RELAY_SECRET: env.CATALYST_RELAY_SECRET,
        TG_BOT_TOKEN: 'dummy-existing-token', TG_CHAT_ID: 'dummy-existing-chat' };
    return { primary, index, cfEnv };
}

test('full local path: Catalyst -> original Telegram -> authenticated CF -> dual D1 -> new and old /file/', async t => {
    const { cfEnv, primary, index } = d1Fixture(t);
    const database = getDatabase(cfEnv);
    await database.put('legacy.png', '', { metadata: { Channel: 'TelegramNew', ChannelName: 'Telegram_env',
        TgFileId: 'legacy-provider-file', FileName: 'old.png', FileType: 'image/png', Label: 'None', ListType: 'None' } });
    const before = await database.getWithMetadata('legacy.png');
    const previous = globalThis.fetch;
    const relayPaths = [];
    let uploads = 0;
    globalThis.fetch = async (input, options) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname === 'imgbed.test') {
            relayPaths.push(url.pathname);
            assert.ok(url.pathname.startsWith('/api/uploadRelay/'));
            return cfRelay({ env: cfEnv, request: new Request(url, options),
                params: { action: [url.pathname.split('/').pop()] } });
        }
        assert.equal(url.hostname, 'api.telegram.org');
        if (url.pathname.endsWith('/sendPhoto')) {
            uploads++;
            return Response.json({ ok: true, result: { photo: [{ file_id: 'new-provider-file', file_size: bytes.length }] } });
        }
        if (url.pathname.endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'dummy.png' } });
        assert.ok(url.pathname.startsWith('/file/bot'));
        return new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
    };
    try {
        const gateway = createGateway({ env });
        index.failIndex = true;
        const partial = await gateway(request());
        assert.equal(partial.status, 202);
        const saved = await partial.json();
        assert.equal(primary.sqlite.prepare('SELECT COUNT(*) AS n FROM upload_relay_registrations').get().n, 1);
        index.failIndex = false;
        assert.deepEqual(await (await gateway(request('register', { receipt: saved.receipt }))).json(), result);
        assert.deepEqual(await (await gateway(request())).json(), result);
        assert.equal(uploads, 1);
        assert.equal(primary.sqlite.prepare('SELECT COUNT(*) AS n FROM index_operations').get().n, 0);
        assert.equal(index.sqlite.prepare('SELECT COUNT(*) AS n FROM index_operations').get().n, 1);
        assert.equal(primary.sqlite.prepare('SELECT COUNT(*) AS n FROM upload_relay_registrations').get().n, 0);
        for (const fileId of ['legacy.png', identity.fileId]) {
            const response = await readFile({ env: cfEnv, request: new Request('https://imgbed.test/file/' + fileId),
                params: { path: fileId }, data: {}, waitUntil() {} });
            assert.equal(response.status, 200);
            assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array(bytes));
        }
        assert.deepEqual(await database.getWithMetadata('legacy.png'), before);
        assert.ok(!relayPaths.includes('/upload'));
        const record = await database.getWithMetadata(identity.fileId);
        assert.equal(record.metadata.FileName, manifest.fileName);
        assert.equal(record.metadata.ChannelName, 'Telegram_env');
        assert.equal(record.metadata.TgBotToken, undefined);
    } finally { globalThis.fetch = previous; }
});

test('R2 uses the existing bucket and identical stable object key via S3, never local storage', async () => {
    const f = fixture({ realStorage: true });
    f.profile.upload.telegram.channels = [];
    f.profile.upload.cfr2 = { channels: [{ name: 'R2_env' }] };
    const settings = { ...env, R2_ENDPOINT: 'https://r2-storage.test', R2_BUCKET: 'existing-bucket',
        R2_ACCESS_KEY_ID: 'dummy-access-key', R2_SECRET_ACCESS_KEY: 'dummy-secret-key' };
    const relay = async (action, payload) => {
        if (action === 'status') return { state: 'missing' };
        if (action === 'claim') return { state: 'claimed', profile: f.profile };
        if (action === 'checkpoint') return { state: 'uploaded', receipt: payload };
        if (action === 'register') { assert.equal(payload.records[0].metadata.Channel, 'CloudflareR2'); return result; }
        return { released: true };
    };
    const previous = globalThis.fetch;
    let writes = 0;
    globalThis.fetch = async input => {
        assert.ok(input instanceof Request);
        const url = new URL(input.url);
        assert.equal(url.hostname, 'r2-storage.test');
        assert.equal(url.pathname, '/existing-bucket/' + identity.fileId);
        assert.equal(input.method, 'PUT');
        assert.deepEqual(new Uint8Array(await input.arrayBuffer()), new Uint8Array(bytes));
        writes++;
        return new Response('', { headers: { ETag: '"dummy-etag"' } });
    };
    try {
        assert.equal((await createGateway({ env: settings, relay })(request())).status, 200);
        assert.equal(writes, 1);
    } finally { globalThis.fetch = previous; }
});

test('built Advanced I/O entry exports native req/res handler and denies unauthenticated HTTP', async t => {
    Object.assign(process.env, { CF_IMGBED_URL: env.CF_IMGBED_URL,
        IMGBED_UPLOAD_TOKEN: env.CATALYST_UPLOAD_TOKEN, IMGBED_RELAY_SECRET: env.CATALYST_RELAY_SECRET });
    const require = createRequire(process.cwd() + '/test-entry.cjs');
    const handler = require(process.cwd() + '/deploy/catalyst/build/functions/imgbed_upload/index.cjs');
    assert.equal(typeof handler, 'function');
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/execute`, { method: 'POST', body: 'not-an-image' });
        assert.equal(response.status, 401);
        const authenticated = await fetch(`http://127.0.0.1:${server.address().port}/execute`, {
            method: 'POST', headers: { 'X-Upload-Token': env.CATALYST_UPLOAD_TOKEN }, body: 'not-an-image' });
        assert.equal(authenticated.status, 415);
    } finally { await new Promise(resolve => server.close(resolve)); }
});

test('resumable hash state matches native SHA256 including Unicode filename and stores no image buffer', () => {
    const prefix = new Uint8Array(128).fill(0x5a);
    const tail = new Uint8Array([1, 2, 3]);
    const state = hashPart(null, prefix, manifest, false).hashState;
    assert.deepEqual(Object.keys(state).sort(), ['bytesHashed', 'words']);
    assert.equal(hashPart(state, tail, manifest, true).digest,
        computeUploadId(new Uint8Array([...prefix, ...tail]), manifest.fileName, manifest.contentType));
    assert.throws(() => hashPart(null, new Uint8Array(63), manifest, false));
    assert.throws(() => hashPart({ words: [1], bytesHashed: 64 }, tail, manifest, true));
});

function partRequest(data, index, uploadId, totalSize) {
    const form = new FormData();
    form.append('file', new File([data], manifest.fileName, { type: manifest.contentType }));
    form.append('manifest', JSON.stringify({ ...manifest, uploadId, fileSize: totalSize, index,
        sha256: computeChunkHash(data) }));
    return new Request('https://gateway.test/execute?action=part', { method: 'POST', body: form,
        headers: { 'X-Upload-Token': env.CATALYST_UPLOAD_TOKEN, 'Idempotency-Key': uploadId } });
}
function computeChunkHash(data) {
    return createRequire(process.cwd() + '/hash-test.cjs')('node:crypto').createHash('sha256').update(data).digest('hex');
}

test('large transfer crosses invocation deadlines, recovers a lost part checkpoint, and reads through original /file/', async t => {
    const { cfEnv, primary, index } = d1Fixture(t);
    const size = 16 * 1024 * 1024 + 1;
    const image = new Uint8Array(size);
    image.set(bytes);
    const uploadId = computeUploadId(image, manifest.fileName, manifest.contentType);
    const fileId = `catalyst_${uploadId}.png`;
    const providers = new Map();
    const previous = globalThis.fetch;
    let failCheckpoint = true;
    let sends = 0;
    const deadline = 2000;
    globalThis.fetch = async (input, options) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname === 'imgbed.test') {
            assert.ok(url.pathname.startsWith('/api/uploadRelay/'));
            assert.ok(Buffer.byteLength(options.body) < 32 * 1024);
            if (url.pathname.endsWith('/transfer-part') && failCheckpoint) {
                failCheckpoint = false;
                return Response.json({ error: 'simulated_metadata_outage' }, { status: 503 });
            }
            return cfRelay({ env: cfEnv, request: new Request(url, options), params: { action: [url.pathname.split('/').pop()] } });
        }
        assert.equal(url.hostname, 'api.telegram.org');
        if (url.pathname.endsWith('/sendDocument')) {
            await new Promise(resolve => setTimeout(resolve, 1200));
            const body = new Uint8Array(await options.body.get('document').arrayBuffer());
            const fileId = `persisted-part-${++sends}`;
            providers.set(fileId, body);
            return Response.json({ ok: true, result: { document: { file_id: fileId, file_size: body.length } } });
        }
        if (url.pathname.endsWith('/getFile')) return Response.json({ ok: true,
            result: { file_path: 'uploaded/' + url.searchParams.get('file_id') } });
        const body = providers.get(url.pathname.split('/').pop());
        assert.ok(body);
        return new Response(body, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(body.length) } });
    };
    const fresh = () => createGateway({ env, deadlineMs: deadline });
    const info = { ...manifest, uploadId, fileSize: size };
    try {
        const started = Date.now();
        const prepared = await (await fresh()(request('prepare', info))).json();
        assert.equal(prepared.nextIndex, 0);
        const first = await fresh()(partRequest(image.slice(0, 16 * 1024 * 1024), 0, uploadId, size));
        assert.equal(first.status, 202);
        const receipt = await first.json();
        assert.equal(receipt.state, 'part_uploaded');
        assert.equal(primary.sqlite.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
        const acknowledged = await (await fresh()(request('part-receipt', { receipt: receipt.receipt }))).json();
        assert.equal(acknowledged.nextIndex, 1);
        const duplicate = await (await fresh()(partRequest(image.slice(0, 16 * 1024 * 1024), 0, uploadId, size))).json();
        assert.equal(duplicate.nextIndex, 1);
        assert.equal(sends, 1);
        const finished = await fresh()(partRequest(image.slice(16 * 1024 * 1024), 1, uploadId, size));
        assert.equal(finished.status, 200);
        assert.deepEqual(await finished.json(), [{ src: '/file/' + fileId }]);
        assert.ok(Date.now() - started > deadline);
        assert.equal(sends, 2);
        assert.equal(primary.sqlite.prepare('SELECT COUNT(*) AS n FROM upload_relay_transfers').get().n, 0);
        assert.equal(index.sqlite.prepare('SELECT COUNT(*) AS n FROM index_operations').get().n, 1);
        const response = await readFile({ env: cfEnv, request: new Request('https://imgbed.test/file/' + fileId),
            params: { path: fileId }, data: {}, waitUntil() {} });
        assert.equal(response.status, 200);
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image);
    } finally { globalThis.fetch = previous; }
});

test('upstream Telegram photo-to-document retry and per-channel load balancing remain intact', async () => {
    const f = fixture({ realStorage: true });
    f.profile.upload.telegram.channels.push({ name: 'second-tg', botToken: 'dummy-second-token', chatId: 'dummy-chat' });
    f.profile.upload.telegram.loadBalance.enabled = true;
    const random = Math.random;
    const previous = globalThis.fetch;
    const operations = [];
    Math.random = () => .75;
    globalThis.fetch = async (input, options) => {
        const url = new URL(String(input));
        assert.ok(url.pathname.startsWith('/botdummy-second-token/'));
        if (url.pathname.endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'dummy.png' } });
        operations.push(url.pathname.split('/').pop());
        if (url.pathname.endsWith('/sendPhoto')) return Response.json({ ok: false, description: 'document-required' });
        assert.equal(url.pathname.split('/').pop(), 'sendDocument');
        return Response.json({ ok: true, result: { document: { file_id: 'document-retry-file', file_size: bytes.length } } });
    };
    try {
        assert.equal((await f.gateway(request())).status, 200);
        assert.deepEqual(operations, ['sendPhoto', 'sendDocument']);
        assert.equal(f.receipt.records[0].metadata.ChannelName, 'second-tg');
    } finally { Math.random = random; globalThis.fetch = previous; }
});

test('blocked upload IP stops before provider access and cannot lose its address in the Node adapter', async () => {
    const f = fixture({ realStorage: true });
    f.profile.blockedIPs = '198.51.100.8';
    const input = request();
    input.headers.set('x-forwarded-for', '198.51.100.8');
    const previous = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('must not access provider'); };
    try { assert.equal((await f.gateway(input)).status, 403); }
    finally { globalThis.fetch = previous; }
});

test('private S3, WebDAV and HuggingFace moderation can read staged metadata and resume without another storage upload', async t => {
    for (const channel of ['s3', 'webdav', 'huggingface']) await t.test(channel, async t => {
        const { cfEnv, primary, index } = d1Fixture(t);
        const database = getDatabase(cfEnv);
        const config = channel === 's3'
            ? { name: 'private-storage', enabled: true, endpoint: 'https://storage.test', bucketName: 'existing-bucket',
                region: 'auto', pathStyle: true, accessKeyId: 'dummy-access', secretAccessKey: 'dummy-private-secret' }
            : channel === 'webdav'
                ? { name: 'private-storage', enabled: true, baseUrl: 'https://storage.test', username: 'dummy-user', password: 'dummy-private-secret' }
                : { name: 'private-storage', enabled: true, repo: 'dummy/private-images', token: 'dummy-private-secret', isPrivate: true };
        await database.put('manage@sysConfig@upload', JSON.stringify({ [channel]: { channels: [config] } }));
        await database.put('manage@sysConfig@security', JSON.stringify({ upload: {
            moderate: { enabled: true, channel: 'nsfwjs', nsfwApiPath: 'https://moderator.test/check' }, ipQuery: { enabled: false } } }));
        const settings = { ...env, CATALYST_UPLOAD_CHANNEL: channel };
        const previous = globalThis.fetch;
        let writes = 0;
        let reviews = 0;
        let loseStageReply = true;
        let stored;
        globalThis.fetch = async (input, options = {}) => {
            currentSignal()?.throwIfAborted();
            if (input instanceof Request) input.signal.throwIfAborted();
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.hostname === 'imgbed.test') {
                if (url.pathname.startsWith('/api/uploadRelay/')) {
                    const response = await cfRelay({ env: cfEnv, request: new Request(url, options),
                        params: { action: [url.pathname.split('/').pop()] } });
                    if (url.pathname.endsWith('/stage') && loseStageReply) {
                        loseStageReply = false;
                        return Response.json({ error: 'lost-stage-ack' }, { status: 503 });
                    }
                    return response;
                }
                assert.equal(url.pathname, '/file/' + identity.fileId);
                return readFile({ env: cfEnv, request: new Request(url), params: { path: identity.fileId }, data: {}, waitUntil() {} });
            }
            if (url.hostname === 'moderator.test') {
                reviews++;
                assert.equal(index.sqlite.prepare('SELECT COUNT(*) AS n FROM index_operations').get().n, 0);
                const preview = await globalThis.fetch(url.searchParams.get('url'));
                assert.equal(preview.status, 200);
                assert.deepEqual(new Uint8Array(await preview.arrayBuffer()), new Uint8Array(bytes));
                return Response.json({ score: .95 });
            }
            if (url.hostname === 'huggingface.co') {
                assert.equal(options.headers.Authorization, 'Bearer dummy-private-secret');
                if (url.pathname === '/api/datasets/dummy/private-images') return Response.json({});
                if (url.pathname.endsWith('/preupload/main')) return Response.json({ files: [{ uploadMode: 'lfs' }] });
                if (url.pathname.endsWith('/objects/batch')) {
                    const { objects } = JSON.parse(options.body);
                    return Response.json({ objects: [{ ...objects[0], actions: { upload: { href: 'https://storage.test/upload' } } }] });
                }
                if (url.pathname.endsWith('/commit/main')) return Response.json({ commitOid: 'dummy-commit' });
                assert.ok(url.pathname.startsWith('/datasets/dummy/private-images/resolve/main/'));
                return new Response(stored, { headers: { 'Content-Type': 'image/png' } });
            }
            assert.equal(url.hostname, 'storage.test');
            const method = input instanceof Request ? input.method : options.method || 'GET';
            if (method === 'PUT') {
                writes++;
                stored = new Uint8Array(await (input instanceof Request ? input : options.body).arrayBuffer());
                return new Response(null, { status: 201, headers: { ETag: '"dummy-etag"' } });
            }
            assert.equal(method, 'GET');
            return new Response(stored, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(stored.length), ETag: '"dummy-etag"' } });
        };
        try {
            const upload = request();
            upload.headers.set('x-forwarded-for', '198.51.100.9');
            const interrupted = await createGateway({ env: settings })(upload);
            assert.equal(interrupted.status, 202);
            const pending = await interrupted.json();
            assert.equal(pending.state, 'staged');
            assert.equal((await database.getWithMetadata(identity.fileId)).metadata.UploadIP, '198.51.100.9');
            assert.equal(primary.sqlite.prepare('SELECT COUNT(*) AS n FROM upload_relay_jobs').get().n, 0);
            await database.put('manage@blockipList', '198.51.100.10');
            const retry = request('register', { receipt: pending.receipt });
            retry.headers.set('x-forwarded-for', '198.51.100.10');
            const completed = await createGateway({ env: settings })(retry);
            assert.equal(completed.status, 200);
            assert.equal(writes, 1);
            assert.equal(reviews, 1);
            const saved = await database.getWithMetadata(identity.fileId);
            assert.equal(saved.metadata.Label, 'adult');
            assert.equal(saved.metadata.UploadRelayStagedId, undefined);
            assert.ok(!JSON.stringify(saved).includes('dummy-private-secret'));
            assert.equal(index.sqlite.prepare('SELECT COUNT(*) AS n FROM index_operations').get().n, 1);
        } finally { globalThis.fetch = previous; }
    });
});

test('Discord keeps PNG, GIF and WebP bytes and reads through the original /file handler', async t => {
    const samples = [
        ['png', bytes],
        ['gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')],
        ['webp', Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJQBOgCHwAP7+4AAAAA==', 'base64')],
    ];
    for (const [ext, content] of samples) await t.test(ext, async t => {
        const { cfEnv, index } = d1Fixture(t);
        const database = getDatabase(cfEnv);
        await database.put('manage@sysConfig@upload', JSON.stringify({ discord: { channels: [{ name: 'original-discord',
            enabled: true, botToken: 'dummy-private-discord-secret', channelId: 'dummy-channel' }] } }));
        const actual = { fileName: `作者.${ext}`, contentType: `image/${ext}` };
        const id = computeUploadId(content, actual.fileName, actual.contentType);
        const fileId = `catalyst_${id}.${ext}`;
        const message = { id: 'dummy-message', attachments: [{ id: 'dummy-attachment', filename: fileId,
            size: content.length, content_type: actual.contentType, url: 'https://cdn.discordapp.com/dummy-image' }] };
        let writes = 0;
        const previous = globalThis.fetch;
        globalThis.fetch = async (input, options = {}) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.hostname === 'imgbed.test') {
                assert.ok(url.pathname.startsWith('/api/uploadRelay/'));
                return cfRelay({ env: cfEnv, request: new Request(url, options),
                    params: { action: [url.pathname.split('/').pop()] } });
            }
            if (url.hostname === 'discord.com') {
                assert.equal(options.headers.Authorization, 'Bot dummy-private-discord-secret');
                if (options.method === 'POST') {
                    writes++;
                    const uploaded = options.body.get('files[0]');
                    assert.equal(uploaded.type, actual.contentType);
                    assert.deepEqual(new Uint8Array(await uploaded.arrayBuffer()), new Uint8Array(content));
                }
                return Response.json(message);
            }
            assert.equal(url.hostname, 'cdn.discordapp.com');
            assert.equal(new Headers(options.headers).has('Authorization'), false);
            return new Response(content, { headers: { 'Content-Type': actual.contentType } });
        };
        try {
            const gateway = createGateway({ env: { ...env, CATALYST_UPLOAD_CHANNEL: 'discord' } });
            const input = () => request('upload', null, { bytes: content, manifest: actual, id });
            const expected = [{ src: '/file/' + fileId }];
            assert.deepEqual(await (await gateway(input())).json(), expected);
            assert.deepEqual(await (await gateway(input())).json(), expected);
            const response = await readFile({ env: cfEnv, request: new Request('https://imgbed.test/file/' + fileId),
                params: { path: fileId }, data: {}, waitUntil() {} });
            assert.equal(response.status, 200);
            assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array(content));
            assert.equal(writes, 1);
            assert.equal(index.sqlite.prepare('SELECT COUNT(*) AS n FROM index_operations').get().n, 1);
            assert.ok(!JSON.stringify(await database.getWithMetadata(fileId)).includes('dummy-private-discord-secret'));
        } finally { globalThis.fetch = previous; }
    });
});
