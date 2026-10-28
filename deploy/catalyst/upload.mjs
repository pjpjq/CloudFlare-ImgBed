import { PutObjectCommand } from '@aws-sdk/client-s3';
import { onRequest } from '../../functions/upload/index.js';
import { cleanRelayMetadata } from '../../functions/utils/uploadRelayMetadata.js';
import { createS3Client } from './adapters/s3Client.js';
import { getUploadIp } from '../../functions/upload/uploadTools.js';

export function selectedUploadChannel(profile, settings) {
    return settings.CATALYST_UPLOAD_CHANNEL || ['telegram', 'cfr2', 's3', 'discord', 'huggingface', 'webdav']
        .find(name => profile.upload[name]?.channels?.length);
}

export async function uploadToOriginalStorage(file, manifest, profile, identity, signal, settings = process.env, sourceRequest, onStage) {
    const records = new Map();
    const scoped = key => key === identity.fileId || key.startsWith(identity.fileId + '_');
    const capture = {
        async get(key) {
            if (key === 'manage@blockipList') return profile.blockedIPs;
            return records.get(key)?.value ?? null;
        },
        async getWithMetadata(key) { return records.get(key) || { value: null, metadata: null }; },
        async put(key, value, options = {}) {
            if (!scoped(key) || typeof value !== 'string' || value.length > 8192 || !options.metadata) {
                throw new Error('unexpected_storage_record');
            }
            const first = !records.has(key);
            records.set(key, { id: key, value, metadata: cleanRelayMetadata({ ...options.metadata,
                ...(key === identity.fileId ? { FileName: manifest.fileName } : {}) }) });
            const metadata = records.get(key).metadata;
            const needsPreview = metadata.Channel === 'S3' ||
                (metadata.Channel === 'HuggingFace' && profile.upload.huggingface?.channels.find(item => item.name === metadata.ChannelName)?.isPrivate) ||
                (metadata.Channel === 'WebDAV' && !profile.upload.webdav?.channels.find(item => item.name === metadata.ChannelName)?.publicUrl);
            if (first && key === identity.fileId && needsPreview && profile.security.upload.moderate?.enabled) {
                if (!onStage) throw new Error('staging_required');
                await onStage({ ...identity, records: [...records.values()] });
            }
        },
    };
    const env = { img_url: capture, CATALYST_AUTHORIZED: true, CATALYST_PROFILE: profile, dev_mode: 'true' };
    if (settings.R2_ENDPOINT && settings.R2_BUCKET && settings.R2_ACCESS_KEY_ID && settings.R2_SECRET_ACCESS_KEY) {
        const client = createS3Client({ endpoint: settings.R2_ENDPOINT, region: 'auto', pathStyle: true,
            accessKeyId: settings.R2_ACCESS_KEY_ID, secretAccessKey: settings.R2_SECRET_ACCESS_KEY });
        env.img_r2 = { async put(key, body, options) {
            await client.send(new PutObjectCommand({ Bucket: settings.R2_BUCKET, Key: key,
                Body: new Uint8Array(await body.arrayBuffer()), ContentType: options.httpMetadata.contentType }), { abortSignal: signal });
        } };
    }
    const body = new FormData();
    body.append('file', new File([file], identity.fileId, { type: manifest.contentType }));
    const url = new URL('/upload?uploadNameType=origin', settings.CF_IMGBED_URL);
    const channel = selectedUploadChannel(profile, settings);
    if (channel) url.searchParams.set('uploadChannel', channel);
    if (settings.CATALYST_UPLOAD_CHANNEL_NAME) url.searchParams.set('channelName', settings.CATALYST_UPLOAD_CHANNEL_NAME);
    const pending = [];
    const uploadIp = sourceRequest && getUploadIp(sourceRequest);
    const response = await onRequest({ env, request: new Request(url, { method: 'POST', body,
        headers: uploadIp ? { 'cf-connecting-ip': uploadIp } : {} }),
        params: {}, data: {}, waitUntil: task => pending.push(task) });
    await Promise.all(pending);
    if (response.status !== 200 || !records.has(identity.fileId)) throw new Error('storage_upload_failed');
    return { ...identity, records: [...records.values()] };
}
