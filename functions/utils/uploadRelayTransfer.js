import { validateUploadIdentity } from './uploadRegistration.js';
import { cleanRelayMetadata } from './uploadRelayMetadata.js';
import { UploadRelayError } from './uploadRelayAuth.js';

const CHUNK_SIZE = 16 * 1024 * 1024;
const reject = code => { throw new UploadRelayError(409, code); };

export async function getUploadTransfer(env, payload) {
    validateUploadIdentity(payload.uploadId, payload.fileId);
    const row = await env.img_d1.prepare('SELECT * FROM upload_relay_transfers WHERE upload_id = ?')
        .bind(payload.uploadId).first();
    if (!row) return { state: 'missing' };
    if (row.file_id !== payload.fileId) reject('transfer_conflict');
    return { state: 'transferring', transfer: { uploadId: row.upload_id, fileId: row.file_id,
        manifest: JSON.parse(row.manifest), parts: JSON.parse(row.parts), createdAt: row.created_at } };
}

export async function beginUploadTransfer(env, payload, now = Date.now()) {
    validateUploadIdentity(payload.uploadId, payload.fileId);
    const input = payload.manifest;
    if (!input || typeof input.fileName !== 'string' || !input.fileName || input.fileName.length > 512 ||
        typeof input.contentType !== 'string' || input.contentType.length > 200 ||
        !Number.isInteger(input.fileSize) || input.fileSize <= CHUNK_SIZE || input.fileSize > 100 * 1024 * 1024 ||
        input.chunkSize !== CHUNK_SIZE || input.totalChunks !== Math.ceil(input.fileSize / CHUNK_SIZE) ||
        input.channel !== 'TelegramNew' || typeof input.channelName !== 'string' || !input.channelName || input.channelName.length > 256 ||
        !input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata)) {
        throw new UploadRelayError(400, 'invalid_transfer');
    }
    const manifest = { fileName: input.fileName, contentType: input.contentType, fileSize: input.fileSize,
        chunkSize: CHUNK_SIZE, totalChunks: input.totalChunks, channel: input.channel, channelName: input.channelName,
        metadata: cleanRelayMetadata(input.metadata) };
    const serialized = JSON.stringify(manifest);
    if (new TextEncoder().encode(serialized).byteLength > 8192) throw new UploadRelayError(413, 'metadata_too_large');
    await env.img_d1.prepare('INSERT OR IGNORE INTO upload_relay_transfers ' +
        '(upload_id, file_id, manifest, created_at) VALUES (?, ?, ?, ?)')
        .bind(payload.uploadId, payload.fileId, serialized, now).run();
    const saved = await getUploadTransfer(env, payload);
    const actual = saved.transfer.manifest;
    for (const key of ['fileName', 'contentType', 'fileSize', 'chunkSize', 'totalChunks', 'channel', 'channelName']) {
        if (actual[key] !== manifest[key]) reject('transfer_conflict');
    }
    return saved;
}

export async function checkpointUploadPart(env, payload) {
    const saved = await getUploadTransfer(env, payload);
    if (saved.state !== 'transferring') throw new UploadRelayError(404, 'transfer_missing');
    const { manifest, parts } = saved.transfer;
    const part = payload.part;
    if (!part || !Number.isInteger(part.index) || part.index < 0 || part.index >= manifest.totalChunks ||
        typeof part.fileId !== 'string' || !part.fileId || part.fileId.length > 512 ||
        part.fileName !== `${manifest.fileName}.part${String(part.index).padStart(3, '0')}` ||
        part.size !== Math.min(CHUNK_SIZE, manifest.fileSize - part.index * CHUNK_SIZE) ||
        typeof part.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(part.sha256)) {
        throw new UploadRelayError(400, 'invalid_transfer_part');
    }
    const last = part.index === manifest.totalChunks - 1;
    if (last ? part.digest !== payload.uploadId : !part.hashState ||
        part.hashState.bytesHashed !== (part.index + 1) * CHUNK_SIZE ||
        !Array.isArray(part.hashState.words) || part.hashState.words.length !== 8 ||
        part.hashState.words.some(word => !Number.isInteger(word) || word < -2147483648 || word > 2147483647)) {
        throw new UploadRelayError(400, 'invalid_hash_checkpoint');
    }
    const clean = { index: part.index, fileId: part.fileId, fileName: part.fileName, size: part.size,
        sha256: part.sha256, ...(last ? { digest: part.digest } : { hashState: part.hashState }) };
    if (part.index === 0 && part.dimensions) {
        const { width, height } = part.dimensions;
        if (!Number.isInteger(width) || width < 1 || width > 0xffffffff ||
            !Number.isInteger(height) || height < 1 || height > 0xffffffff) throw new UploadRelayError(400, 'invalid_dimensions');
        clean.dimensions = { width, height };
    }
    const prior = parts[part.index];
    if (prior) {
        if (prior.sha256 !== clean.sha256 || prior.size !== clean.size) reject('part_content_conflict');
        return saved;
    }
    if (parts.length !== part.index) throw new UploadRelayError(409, 'part_out_of_order', 1);
    await env.img_d1.prepare("UPDATE upload_relay_transfers SET parts = json_insert(parts, '$[#]', json(?)) " +
        'WHERE upload_id = ? AND json_array_length(parts) = ?')
        .bind(JSON.stringify(clean), payload.uploadId, part.index).run();
    const winner = await getUploadTransfer(env, payload);
    const committed = winner.transfer.parts[part.index];
    if (!committed || committed.sha256 !== clean.sha256 || committed.size !== clean.size) reject('part_content_conflict');
    return winner;
}
