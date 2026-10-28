const encoder = new TextEncoder();
const MAX_BODY_BYTES = 32 * 1024;

export class UploadRelayError extends Error {
    constructor(status, code, retryAfter = 0) {
        super(code);
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

function signatureBytes(value) {
    if (!/^[a-f0-9]{64}$/.test(value || '')) {
        throw new UploadRelayError(401, 'invalid_signature');
    }
    return Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));
}

async function hmacKey(secret, usage) {
    return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}

function signedData(method, pathname, body, timestamp) {
    return encoder.encode(`${timestamp}\n${method}\n${pathname}\n${body}`);
}

export async function signUploadRelay(secret, method, pathname, body, timestamp) {
    const key = await hmacKey(secret, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, signedData(method, pathname, body, timestamp));
    return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function authenticateUploadRelay(request, secret, now = Date.now()) {
    if (typeof secret !== 'string' || encoder.encode(secret).length < 32) {
        throw new UploadRelayError(404, 'upload_relay_disabled');
    }
    if (request.method !== 'POST') {
        throw new UploadRelayError(405, 'method_not_allowed');
    }
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
        throw new UploadRelayError(415, 'metadata_json_required');
    }
    const timestamp = request.headers.get('x-upload-timestamp');
    if (!/^\d{10}$/.test(timestamp || '') || Math.abs(now / 1000 - Number(timestamp)) > 300) {
        throw new UploadRelayError(401, 'expired_signature');
    }
    const signature = signatureBytes(request.headers.get('x-upload-signature'));
    const declaredLength = request.headers.get('content-length');
    if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) {
        throw new UploadRelayError(413, 'metadata_too_large');
    }
    const reader = request.body?.getReader();
    if (!reader) throw new UploadRelayError(400, 'invalid_json');
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY_BYTES) {
                await reader.cancel();
                throw new UploadRelayError(413, 'metadata_too_large');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    let body;
    try {
        body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new UploadRelayError(400, 'invalid_json');
    }
    const key = await hmacKey(secret, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, signature,
        signedData(request.method, new URL(request.url).pathname, body, timestamp));
    if (!valid) throw new UploadRelayError(401, 'invalid_signature');
    try {
        const payload = JSON.parse(body);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
        return payload;
    } catch {
        throw new UploadRelayError(400, 'invalid_json');
    }
}
