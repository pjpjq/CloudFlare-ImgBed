import { createHash } from 'node:crypto';
import { TelegramAPI } from '../../functions/utils/storage/telegramAPI.js';
import { getUploadIp, getIPAddress, getImageDimensions } from '../../functions/upload/uploadTools.js';
import { resolveFileType, getFileTypeCategory } from '../../functions/utils/mimeTypes.js';
import { selectedUploadChannel } from './upload.mjs';
import { hashPart } from './hashProgress.mjs';

export const CHUNK_SIZE = 16 * 1024 * 1024;
const fail = (status, code) => { throw Object.assign(new Error(code), { status }); };

function assertInput(manifest, input) {
    for (const key of ['fileName', 'contentType', 'fileSize']) {
        if (manifest[key] !== input[key]) fail(409, 'transfer_conflict');
    }
}

export async function prepareTransfer(input, identity, profile, relay, settings, request) {
    if (!Number.isInteger(input.fileSize) || input.fileSize < 1 || input.fileSize > 100 * 1024 * 1024) fail(400, 'invalid_file_size');
    const saved = await relay('transfer-status', identity);
    if (saved.state === 'transferring') {
        assertInput(saved.transfer.manifest, input);
        return saved;
    }
    if (input.fileSize <= CHUNK_SIZE || selectedUploadChannel(profile, settings) !== 'telegram') return { state: 'single' };
    const options = profile.upload.telegram;
    const channel = options.channels.find(item => item.name === settings.CATALYST_UPLOAD_CHANNEL_NAME) ||
        options.channels[options.loadBalance?.enabled ? Math.floor(Math.random() * options.channels.length) : 0];
    if (!channel?.name) fail(503, 'channel_unavailable');
    const uploadIp = getUploadIp(request);
    if ((profile.blockedIPs || '').split(',').includes(uploadIp)) fail(403, 'ip_blocked');
    const fileType = resolveFileType(input.fileName, input.contentType);
    const metadata = { FileName: input.fileName, FileType: fileType, FileSizeBytes: input.fileSize,
        FileSize: (input.fileSize / 1024 / 1024).toFixed(2), UploadIP: uploadIp,
        UploadAddress: await getIPAddress({ CATALYST_PROFILE: profile }, uploadIp, profile.security),
        ListType: 'None', Label: 'None', Directory: '', Tags: [], Channel: 'TelegramNew', ChannelName: channel.name,
        IsChunked: true, TotalChunks: Math.ceil(input.fileSize / CHUNK_SIZE) };
    return relay('transfer-begin', { ...identity, manifest: { fileName: input.fileName, contentType: input.contentType,
        fileSize: input.fileSize, chunkSize: CHUNK_SIZE, totalChunks: metadata.TotalChunks,
        channel: 'TelegramNew', channelName: channel.name, metadata } });
}

export async function uploadTransferPart(file, input, identity, profile, relay) {
    const saved = await relay('transfer-status', identity);
    if (saved.state !== 'transferring') fail(409, 'transfer_missing');
    const { manifest, parts } = saved.transfer;
    assertInput(manifest, input);
    const index = input.index;
    if (!Number.isInteger(index) || index < 0 || index >= manifest.totalChunks ||
        file.size !== Math.min(CHUNK_SIZE, manifest.fileSize - index * CHUNK_SIZE) ||
        typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)) fail(400, 'invalid_part');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== input.sha256) fail(409, 'part_hash_mismatch');
    if (parts[index]) {
        if (parts[index].sha256 !== input.sha256) fail(409, 'part_content_conflict');
        return { saved };
    }
    if (index !== parts.length) fail(409, 'part_out_of_order');
    const last = index === manifest.totalChunks - 1;
    const checksum = hashPart(index ? parts[index - 1].hashState : null, bytes, manifest, last);
    if (last && checksum.digest !== identity.uploadId) fail(409, 'image_hash_mismatch');
    const channel = profile.upload.telegram.channels.find(item => item.name === manifest.channelName);
    if (!channel) fail(503, 'channel_unavailable');
    const api = new TelegramAPI(channel.botToken, channel.proxyUrl || '');
    const fileName = `${manifest.fileName}.part${String(index).padStart(3, '0')}`;
    const response = await api.sendFile(file, channel.chatId, 'sendDocument', 'document',
        `Part ${index + 1}/${manifest.totalChunks}`, fileName);
    const info = api.getFileInfo(response);
    if (!info?.file_id || info.file_size !== file.size) fail(502, 'invalid_provider_receipt');
    const part = { index, fileId: info.file_id, fileName, size: file.size, sha256: input.sha256, ...checksum };
    if (index === 0 && getFileTypeCategory(manifest.metadata.FileType) === 'image') {
        const dimensions = getImageDimensions(bytes.subarray(0, 65536).buffer.slice(bytes.byteOffset, bytes.byteOffset + Math.min(bytes.length, 65536)), manifest.metadata.FileType);
        if (dimensions) part.dimensions = dimensions;
    }
    return { checkpoint: { kind: 'part_checkpoint', ...identity, part } };
}

export function transferView(saved) {
    const { manifest, parts } = saved.transfer;
    return { state: 'transferring', chunkSize: CHUNK_SIZE, nextIndex: parts.length, totalChunks: manifest.totalChunks };
}

export function transferReceipt(saved) {
    const { uploadId, fileId, manifest, parts, createdAt } = saved.transfer;
    if (parts.length !== manifest.totalChunks || parts.reduce((size, part) => size + part.size, 0) !== manifest.fileSize ||
        parts.at(-1)?.digest !== uploadId) return null;
    const dimensions = parts[0].dimensions;
    return { uploadId, fileId, records: [{ id: fileId,
        value: JSON.stringify(parts.map(({ index, fileId, fileName, size }) => ({ index, fileId, fileName, size }))),
        metadata: { ...manifest.metadata, TimeStamp: createdAt,
            ...(dimensions ? { Width: dimensions.width, Height: dimensions.height } : {}) } }] };
}
