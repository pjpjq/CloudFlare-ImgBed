import { getDatabase } from './databaseAdapter.js';
import { addFileToIndex } from './indexManager.js';
import { cleanRelayMetadata } from './uploadRelayMetadata.js';
import { UploadRelayError } from './uploadRelayAuth.js';

const CHANNELS = new Set(['TelegramNew', 'CloudflareR2', 'S3', 'Discord', 'HuggingFace', 'WebDAV', 'External']);
const LEASE_MS = 45_000;

function canonicalJson(value, depth = 0) {
    if (depth > 8) throw new UploadRelayError(400, 'invalid_receipt');
    if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, depth + 1)).join(',')}]`;
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        if (keys.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) {
            throw new UploadRelayError(400, 'invalid_receipt');
        }
        return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(',')}}`;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) throw new UploadRelayError(400, 'invalid_receipt');
    if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) {
        throw new UploadRelayError(400, 'invalid_receipt');
    }
    return JSON.stringify(value);
}

function validateReceipt(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new UploadRelayError(400, 'invalid_receipt');
    }
    const { uploadId, fileId, records } = payload;
    if (typeof uploadId !== 'string' || !/^[a-f0-9]{64}$/.test(uploadId) || typeof fileId !== 'string' ||
        !new RegExp(`^catalyst_${uploadId}\\.[a-z0-9]{1,12}$`).test(fileId) ||
        !Array.isArray(records) || records.length < 1 || records.length > 32) {
        throw new UploadRelayError(400, 'invalid_receipt');
    }
    const ids = new Set();
    const cleaned = records.map(record => {
        if (!record || typeof record !== 'object' || typeof record.id !== 'string' ||
            (record.id !== fileId && !record.id.startsWith(fileId + '_')) ||
            !/^[a-zA-Z0-9_.-]+$/.test(record.id) || record.id.length > 180 || ids.has(record.id) ||
            typeof record.value !== 'string' || record.value.length > 8192 ||
            !record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata) ||
            !CHANNELS.has(record.metadata.Channel)) {
            throw new UploadRelayError(400, 'invalid_receipt');
        }
        ids.add(record.id);
        return { id: record.id, value: record.value, metadata: cleanRelayMetadata(record.metadata) };
    });
    if (!ids.has(fileId)) throw new UploadRelayError(400, 'invalid_receipt');
    const receipt = { uploadId, fileId, records: cleaned };
    const serialized = canonicalJson(receipt);
    if (new TextEncoder().encode(serialized).byteLength > 32 * 1024) {
        throw new UploadRelayError(413, 'metadata_too_large');
    }
    return { receipt, serialized };
}

async function fingerprint(serialized) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

function completedResponse(fileId) {
    return [{ src: `/file/${fileId}` }];
}

function unstageMetadata(metadata) {
    const { UploadRelayStagedId, UploadRelayStagedFingerprint, ...cleaned } = metadata;
    return cleaned;
}

async function storageFingerprint(receipt) {
    return fingerprint(canonicalJson({ ...receipt, records: receipt.records.map(record => {
        const { Label, ...metadata } = unstageMetadata(record.metadata);
        return { ...record, metadata };
    }) }));
}

async function purgeRelayCache(context, receipt) {
    if (context.request && globalThis.caches) {
        const { purgeCDNCache } = await import('../upload/uploadTools.js');
        const url = new URL(context.request.url);
        const main = receipt.records.find(record => record.id === receipt.fileId);
        await purgeCDNCache(context.env, `${url.origin}/file/${receipt.fileId}`, url, main.metadata.Directory || '');
    }
}

export async function stageUploadedFile(context, payload) {
    const { receipt } = validateReceipt(payload);
    if (receipt.records.length !== 1 || !['S3', 'HuggingFace', 'WebDAV'].includes(receipt.records[0].metadata.Channel)) {
        throw new UploadRelayError(400, 'invalid_staged_upload');
    }
    const before = await getUploadRegistration(context.env, receipt.uploadId, receipt.fileId);
    const source = await storageFingerprint(receipt);
    if (before.state !== 'missing') {
        if (before.state === 'staged' && await storageFingerprint(validateReceipt(before.receipt).receipt) !== source) {
            throw new UploadRelayError(409, 'staged_storage_conflict');
        }
        return before;
    }
    const record = receipt.records[0];
    const metadata = { ...record.metadata, UploadRelayStagedId: receipt.uploadId, UploadRelayStagedFingerprint: source };
    // INSERT-only staging cannot overwrite a legacy file or race a completed registration.
    await context.env.img_d1.prepare('INSERT OR IGNORE INTO files (id, value, metadata) VALUES (?, ?, ?)')
        .bind(receipt.fileId, record.value, JSON.stringify(metadata)).run();
    const saved = await getUploadRegistration(context.env, receipt.uploadId, receipt.fileId);
    if (saved.state === 'staged' && await storageFingerprint(validateReceipt(saved.receipt).receipt) !== source) {
        throw new UploadRelayError(409, 'staged_storage_conflict');
    }
    await purgeRelayCache(context, receipt);
    return saved;
}

export async function checkpointUploadedFile(context, payload, now = Date.now()) {
    const { receipt, serialized } = validateReceipt(payload);
    const digest = await fingerprint(serialized);
    const { env } = context;
    if (!env.img_d1 || !env.img_index) throw new UploadRelayError(503, 'dual_d1_required');
    const db = getDatabase(env);
    const sql = env.img_d1;
    let job = await sql.prepare('SELECT * FROM upload_relay_registrations WHERE upload_id = ?')
        .bind(receipt.uploadId).first();
    if (job && (job.fingerprint !== digest || job.file_id !== receipt.fileId)) {
        throw new UploadRelayError(409, 'receipt_conflict');
    }
    const existing = await db.getWithMetadata(receipt.fileId);
    const staged = existing?.metadata?.UploadRelayStagedId === receipt.uploadId;
    if (existing) {
        if (staged ? existing.metadata.UploadRelayStagedFingerprint !== await storageFingerprint(receipt)
            : existing.metadata?.UploadRelayFingerprint !== digest) throw new UploadRelayError(409, 'file_id_conflict');
    }
    const cleanupTransfer = async () => {
        if (receipt.records.find(record => record.id === receipt.fileId)?.metadata.IsChunked) {
            await sql.prepare('DELETE FROM upload_relay_transfers WHERE upload_id = ?').bind(receipt.uploadId).run();
        }
    };
    if (!job && existing && !staged) {
        await cleanupTransfer();
        return { state: 'complete', result: completedResponse(receipt.fileId) };
    }
    if (!job) {
        await sql.prepare('INSERT OR IGNORE INTO upload_relay_registrations ' +
            '(upload_id, file_id, fingerprint, receipt, created_at) VALUES (?, ?, ?, ?, ?)')
            .bind(receipt.uploadId, receipt.fileId, digest, serialized, now).run();
    }
    job = await sql.prepare('SELECT * FROM upload_relay_registrations WHERE upload_id = ?')
        .bind(receipt.uploadId).first();
    if (!job || job.fingerprint !== digest || job.file_id !== receipt.fileId) {
        throw new UploadRelayError(409, 'receipt_conflict');
    }
    await cleanupTransfer();
    return { state: 'uploaded', receipt: JSON.parse(job.receipt) };
}

export async function registerUploadedFile(context, payload, now = Date.now()) {
    const checkpoint = await checkpointUploadedFile(context, payload, now);
    if (checkpoint.state === 'complete') return checkpoint.result;
    const receipt = checkpoint.receipt;
    const digest = await fingerprint(canonicalJson(receipt));
    const { env } = context;
    const db = getDatabase(env);
    const sql = env.img_d1;
    const owner = crypto.randomUUID();
    const job = await sql.prepare('UPDATE upload_relay_registrations SET lease_owner = ?, lease_until = ? ' +
        'WHERE upload_id = ? AND fingerprint = ? AND lease_until <= ? RETURNING *')
        .bind(owner, now + LEASE_MS, receipt.uploadId, digest, now).first();
    if (!job) throw new UploadRelayError(409, 'registration_in_progress', 2);
    try {
        const main = receipt.records.find(record => record.id === receipt.fileId);
        for (const record of receipt.records) {
            await db.put(record.id, record.value, {
                metadata: { ...record.metadata, UploadRelayFingerprint: digest, UploadRelayId: receipt.uploadId },
            });
        }
        // The existing index helper reports failures as {success:false}, not exceptions.
        const indexed = await addFileToIndex(context, receipt.fileId, {
            ...main.metadata, UploadRelayFingerprint: digest, UploadRelayId: receipt.uploadId,
        });
        if (!indexed.success) throw new UploadRelayError(503, 'index_registration_failed');
        await purgeRelayCache(context, receipt);
        const removed = await sql.prepare('DELETE FROM upload_relay_registrations ' +
            'WHERE upload_id = ? AND lease_owner = ? RETURNING upload_id')
            .bind(receipt.uploadId, owner).first();
        if (!removed) throw new UploadRelayError(409, 'registration_lease_lost', 2);
        return completedResponse(receipt.fileId);
    } catch (error) {
        await sql.prepare('UPDATE upload_relay_registrations SET lease_owner = NULL, lease_until = 0 ' +
            'WHERE upload_id = ? AND lease_owner = ?').bind(receipt.uploadId, owner).run();
        throw error;
    }
}

export async function getUploadRegistration(env, uploadId, fileId) {
    validateUploadIdentity(uploadId, fileId);
    if (!env.img_d1 || !env.img_index) throw new UploadRelayError(503, 'dual_d1_required');
    const job = await env.img_d1.prepare('SELECT file_id, receipt FROM upload_relay_registrations WHERE upload_id = ?')
        .bind(uploadId).first();
    if (job) {
        if (job.file_id !== fileId) throw new UploadRelayError(409, 'file_id_conflict');
        return { state: 'uploaded', receipt: JSON.parse(job.receipt) };
    }
    const file = await getDatabase(env).getWithMetadata(fileId);
    if (file?.metadata?.UploadRelayId === uploadId) {
        return { state: 'complete', result: completedResponse(fileId) };
    }
    if (file?.metadata?.UploadRelayStagedId === uploadId) return { state: 'staged', receipt: {
        kind: 'staged', uploadId, fileId, records: [{ id: fileId, value: file.value,
            metadata: unstageMetadata(file.metadata) }] } };
    if (file) throw new UploadRelayError(409, 'file_id_conflict');
    return { state: 'missing' };
}

export function validateUploadIdentity(uploadId, fileId) {
    if (typeof uploadId !== 'string' || !/^[a-f0-9]{64}$/.test(uploadId) || typeof fileId !== 'string' ||
        !new RegExp(`^catalyst_${uploadId}\\.[a-z0-9]{1,12}$`).test(fileId)) {
        throw new UploadRelayError(400, 'invalid_receipt');
    }
}
