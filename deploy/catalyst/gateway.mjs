import { randomUUID } from 'node:crypto';
import { resolveFileExt } from '../../functions/utils/mimeTypes.js';
import { cleanRelayMetadata } from '../../functions/utils/uploadRelayMetadata.js';
import { uploadToOriginalStorage } from './upload.mjs';
import { currentSignal, runWithDeadline, abortCurrentInvocation, outsideInvocation } from './runtime.mjs';
import { getUploadIp, moderateContent } from '../../functions/upload/uploadTools.js';
import { CHUNK_SIZE, prepareTransfer, uploadTransferPart, transferView, transferReceipt } from './resumable.mjs';
import { computeUploadId, timingSafeEqualStr, signUploadRelay, createReceiptEnvelope, verifyReceiptEnvelope } from './utils/crypto.js';

const fail = (status, code) => { throw Object.assign(new Error(code), { status }); };
const json = (body, status = 200, retryAfter = 0) => Response.json(body, { status,
    headers: { 'Cache-Control': 'no-store', ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}) } });

function safeOrigin(value, allowLocalHttp) {
    try {
        const url = new URL(value);
        if (!url.username && !url.password && !url.search && !url.hash && url.pathname === '/' &&
            (url.protocol === 'https:' || (allowLocalHttp && url.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return url.origin;
    } catch {}
    fail(503, 'invalid_cf_origin');
}

async function readLimited(message, limit, signal) {
    if (Number(message.headers.get('content-length')) > limit) fail(413, 'body_too_large');
    if (!message.body) return new Uint8Array();
    const reader = message.body.getReader();
    const cancel = () => { void reader.cancel(); };
    signal?.addEventListener('abort', cancel, { once: true });
    let size = 0;
    const parts = [];
    try {
        while (true) {
            signal?.throwIfAborted();
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > limit) { await reader.cancel(); fail(413, 'body_too_large'); }
            parts.push(value);
        }
    } finally {
        signal?.removeEventListener('abort', cancel);
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
}

function manifestIdentity(manifest, uploadId) {
    if (!manifest || typeof manifest.fileName !== 'string' || !manifest.fileName || manifest.fileName.length > 512 ||
        /[\u0000-\u001f\u007f]/.test(manifest.fileName) || typeof manifest.contentType !== 'string' ||
        !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:;[ -~]*)?$/.test(manifest.contentType) || manifest.contentType.length > 200 ||
        typeof uploadId !== 'string' || !/^[a-f0-9]{64}$/.test(uploadId)) fail(400, 'invalid_manifest');
    const ext = resolveFileExt(manifest.fileName, manifest.contentType);
    if (!/^[a-z0-9]{1,12}$/.test(ext)) fail(400, 'invalid_extension');
    return { uploadId, fileId: `catalyst_${uploadId}.${ext}` };
}

function cleanReceipt(receipt, identity) {
    if (receipt?.uploadId !== identity.uploadId || receipt.fileId !== identity.fileId ||
        !Array.isArray(receipt.records) || receipt.records.length < 1 || receipt.records.length > 32) fail(502, 'invalid_storage_receipt');
    const ids = new Set();
    const records = receipt.records.map(record => {
        if (typeof record.id !== 'string' || (record.id !== identity.fileId && !record.id.startsWith(identity.fileId + '_')) ||
            !/^[a-zA-Z0-9_.-]{1,180}$/.test(record.id) || ids.has(record.id) || typeof record.value !== 'string' ||
            record.value.length > 8192 || !record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) {
            fail(502, 'invalid_storage_receipt');
        }
        ids.add(record.id);
        return { id: record.id, value: record.value, metadata: cleanRelayMetadata(record.metadata) };
    });
    if (!ids.has(identity.fileId)) fail(502, 'invalid_storage_receipt');
    return { ...identity, records };
}

export function createGateway({ env = process.env, relay, upload, allowLocalHttp = false, deadlineMs = 25_000 } = {}) {
    const callRelay = relay || (async (action, payload) => {
        const url = new URL(`/api/uploadRelay/${action}`, safeOrigin(env.CF_IMGBED_URL, allowLocalHttp));
        const body = JSON.stringify(payload);
        if (Buffer.byteLength(body) > 32 * 1024) fail(413, 'metadata_too_large');
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = await signUploadRelay(env.CATALYST_RELAY_SECRET, 'POST', url.pathname, body, timestamp);
        const response = await fetch(url, { method: 'POST', body, redirect: 'error',
            signal: AbortSignal.any([currentSignal(), AbortSignal.timeout(5000)].filter(Boolean)),
            headers: { 'Content-Type': 'application/json', 'x-upload-timestamp': timestamp, 'x-upload-signature': signature } });
        const bytes = await readLimited(response, 1024 * 1024, currentSignal());
        if (!response.ok) throw Object.assign(new Error('relay_unavailable'), { status: response.status,
            retryAfter: Math.min(300, Math.max(1, Number(response.headers.get('Retry-After')) || 2)) });
        return JSON.parse(new TextDecoder().decode(bytes));
    });
    const store = upload || ((file, manifest, profile, identity, signal, request, onStage) =>
        uploadToOriginalStorage(file, manifest, profile, identity, signal, env, request, onStage));

    return async request => {
        let pendingEnvelope;
        let pendingState = 'uploaded';
        try {
            if (Buffer.byteLength(env.CATALYST_UPLOAD_TOKEN || '') < 32 || Buffer.byteLength(env.CATALYST_RELAY_SECRET || '') < 32) {
                fail(404, 'disabled');
            }
            // Catalyst reserves Authorization for its own OAuth tokens.
            if (!timingSafeEqualStr(request.headers.get('X-Upload-Token'), env.CATALYST_UPLOAD_TOKEN)) fail(401, 'unauthorized');
            if (request.method !== 'POST') fail(405, 'method_not_allowed');
            return await runWithDeadline(async signal => {
                const action = new URL(request.url).searchParams.get('action') || 'upload';
                const envelopeState = async state => ['uploaded', 'staged'].includes(state.state)
                    ? { state: state.state, receipt: await createReceiptEnvelope(state.receipt, env.CATALYST_RELAY_SECRET) } : state;
                const finish = async (raw, checkpoint = false) => {
                    let receipt = cleanReceipt(raw, { uploadId: raw.uploadId, fileId: raw.fileId });
                    pendingState = 'uploaded';
                    pendingEnvelope = await createReceiptEnvelope(receipt, env.CATALYST_RELAY_SECRET);
                    try {
                        if (checkpoint) {
                            const saved = await callRelay('checkpoint', receipt);
                            if (saved.state === 'complete') return json(saved.result);
                            receipt = saved.receipt;
                        }
                        return json(await callRelay('register', receipt));
                    } catch {
                        return json({ state: 'uploaded', receipt: pendingEnvelope }, 202);
                    }
                };

                const reviewStaged = async (raw, profile) => {
                    const receipt = cleanReceipt(raw, { uploadId: raw.uploadId, fileId: raw.fileId });
                    pendingState = 'staged';
                    pendingEnvelope = await createReceiptEnvelope({ ...receipt, kind: 'staged' }, env.CATALYST_RELAY_SECRET);
                    const label = await moderateContent({ CATALYST_PROFILE: profile }, `${env.CF_IMGBED_URL}/file/${receipt.fileId}`);
                    receipt.records.find(record => record.id === receipt.fileId).metadata.Label = label;
                    return finish(receipt, true);
                };

                const runUpload = async (identity, work) => {
                    const state = await callRelay('status', identity);
                    if (state.state === 'complete') return json(state.result);
                    if (state.state === 'uploaded') return finish(state.receipt);
                    const job = { ...identity, owner: randomUUID() };
                    const claimed = await callRelay('claim', job);
                    if (claimed.state === 'complete') return json(claimed.result);
                    if (claimed.state === 'uploaded') return finish(claimed.receipt);
                    if (claimed.state !== 'claimed' || !claimed.profile) fail(503, 'claim_unavailable');
                    try {
                        const uploadIp = claimed.staged?.records.find(record => record.id === identity.fileId)?.metadata.UploadIP || getUploadIp(request);
                        if ((claimed.profile.blockedIPs || '').split(',').includes(uploadIp)) fail(403, 'ip_blocked');
                        return claimed.staged ? await reviewStaged(claimed.staged, claimed.profile) : await work(claimed.profile);
                    }
                    finally { try { await outsideInvocation(() => callRelay('release', job)); } catch {} }
                };
                const transferResponse = saved => {
                    const receipt = transferReceipt(saved);
                    return receipt ? finish(receipt, true) : json(transferView(saved));
                };

                if (['register', 'status', 'prepare', 'part-receipt'].includes(action)) {
                    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) fail(415, 'json_required');
                    let input;
                    try { input = JSON.parse(new TextDecoder().decode(await readLimited(request, 70 * 1024, signal))); }
                    catch (error) { if (error.status) throw error; fail(400, 'invalid_json'); }
                    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'invalid_json');
                    if (action === 'prepare') {
                        const identity = manifestIdentity(input, input.uploadId);
                        return runUpload(identity, async profile => {
                            const saved = await prepareTransfer(input, identity, profile, callRelay, env, request);
                            return saved.state === 'single' ? json(saved) : transferResponse(saved);
                        });
                    }
                    if (action === 'status') {
                        const identity = manifestIdentity(input, input.uploadId);
                        return json(await envelopeState(await callRelay('status', identity)));
                    }
                    const receipt = await verifyReceiptEnvelope(input?.receipt, env.CATALYST_RELAY_SECRET);
                    if (!receipt || !new RegExp(`^catalyst_${receipt.uploadId}\\.[a-z0-9]{1,12}$`).test(receipt.fileId)) fail(400, 'invalid_receipt');
                    const state = await callRelay('status', { uploadId: receipt.uploadId, fileId: receipt.fileId });
                    if (state.state === 'complete') return json(state.result);
                    if (action === 'part-receipt') {
                        if (state.state === 'uploaded') return finish(state.receipt);
                        if (receipt.kind !== 'part_checkpoint') fail(400, 'invalid_part_receipt');
                        return transferResponse(await callRelay('transfer-part', receipt));
                    }
                    if (receipt.kind === 'staged' || state.state === 'staged') {
                        return runUpload({ uploadId: receipt.uploadId, fileId: receipt.fileId }, async profile => {
                            const saved = await callRelay('stage', receipt);
                            if (saved.state === 'complete') return json(saved.result);
                            if (saved.state === 'uploaded') return finish(saved.receipt);
                            return reviewStaged(saved.receipt, profile);
                        });
                    }
                    return finish(state.state === 'uploaded' ? state.receipt : receipt, state.state !== 'uploaded');
                }
                if (action !== 'upload' && action !== 'part') fail(404, 'unknown_operation');
                if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('multipart/form-data;')) fail(415, 'multipart_required');
                // Same request eligibility as CF's existing 100 MiB path; no image type/size filtering by caller.
                const bytes = await readLimited(request, (action === 'part' ? CHUNK_SIZE : 100 * 1024 * 1024) + 64 * 1024, signal);
                const form = await new Request(request.url, { method: 'POST', headers: request.headers, body: bytes }).formData();
                const file = form.get('file');
                let manifest;
                try { manifest = JSON.parse(form.get('manifest')); } catch { fail(400, 'invalid_manifest'); }
                const identity = manifestIdentity(manifest, request.headers.get('Idempotency-Key'));
                if (!(file instanceof File)) fail(400, 'file_required');
                if (action === 'part') return runUpload(identity, async profile => {
                    const uploaded = await uploadTransferPart(file, manifest, identity, profile, callRelay);
                    if (uploaded.saved) return transferResponse(uploaded.saved);
                    pendingState = 'part_uploaded';
                    pendingEnvelope = await createReceiptEnvelope(uploaded.checkpoint, env.CATALYST_RELAY_SECRET);
                    try { return await transferResponse(await callRelay('transfer-part', uploaded.checkpoint)); }
                    catch { return json({ state: pendingState, receipt: pendingEnvelope }, 202); }
                });
                const computed = computeUploadId(new Uint8Array(await file.arrayBuffer()), manifest.fileName, manifest.contentType);
                if (computed !== identity.uploadId) fail(409, 'idempotency_mismatch');
                return runUpload(identity, async profile => {
                    const onStage = async raw => {
                        const receipt = { ...cleanReceipt(raw, identity), kind: 'staged' };
                        pendingState = 'staged';
                        pendingEnvelope = await createReceiptEnvelope(receipt, env.CATALYST_RELAY_SECRET);
                        try { await callRelay('stage', receipt); }
                        catch (error) { abortCurrentInvocation(); throw error; }
                    };
                    const receipt = cleanReceipt(await store(file, manifest, profile, identity, signal, request, onStage), identity);
                    return await finish(receipt, true);
                });
            }, deadlineMs);
        } catch (error) {
            if (pendingEnvelope) return json({ state: pendingState, receipt: pendingEnvelope }, 202);
            const status = [400, 401, 403, 404, 405, 409, 413, 415, 429, 503, 504].includes(error.status) ? error.status : 503;
            return json({ error: status < 500 ? 'upload_rejected' : 'upload_unavailable' }, status, error.retryAfter || 0);
        }
    };
}
