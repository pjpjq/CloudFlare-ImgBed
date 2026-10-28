import crypto from "node:crypto";
import { signUploadRelay } from '../../../functions/utils/uploadRelayAuth.js';

/**
 * Computes deterministic uploadId:
 * SHA256(bytes + NUL + UTF8 fileName + NUL + UTF8 contentType)
 */
export function computeUploadId(fileBytes, fileName, contentType) {
    const hash = crypto.createHash("sha256");
    hash.update(fileBytes);
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(String(fileName), "utf-8"));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(String(contentType), "utf-8"));
    return hash.digest("hex");
}

/**
 * Constant-time string comparison preventing timing analysis.
 */
export function timingSafeEqualStr(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const bufA = Buffer.from(a, "utf-8");
    const bufB = Buffer.from(b, "utf-8");
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Sign payload using Cloudflare Relay HMAC specification:
 * timestamp + "\n" + method + "\n" + pathname + "\n" + body
 */
export { signUploadRelay };

/**
 * Creates opaque durable receipt envelope:
 * signedData("RECEIPT", uploadId, payload, 0)
 */
export async function createReceiptEnvelope(rawReceipt, secret) {
    const payload = JSON.stringify(rawReceipt);
    if (Buffer.byteLength(payload, "utf-8") > 32 * 1024) {
        throw new Error("Receipt payload exceeds 32KiB");
    }
    const signature = await signUploadRelay(secret, "RECEIPT", rawReceipt.uploadId, payload, 0);
    return { payload, signature };
}

/**
 * Validates opaque durable receipt envelope using constant-time comparison.
 */
export async function verifyReceiptEnvelope(envelope, secret) {
    if (!envelope || typeof envelope !== "object") return null;
    const { payload, signature } = envelope;
    if (typeof payload !== "string" || typeof signature !== "string") return null;
    if (Buffer.byteLength(payload, "utf-8") > 32 * 1024) return null;
    if (!/^[a-f0-9]{64}$/.test(signature)) return null;

    let parsed;
    try {
        parsed = JSON.parse(payload);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        if (typeof parsed.uploadId !== "string" || !/^[a-f0-9]{64}$/.test(parsed.uploadId)) return null;
        if (typeof parsed.fileId !== "string" || !/^catalyst_[a-f0-9]{64}\.[a-z0-9]{1,12}$/.test(parsed.fileId)) return null;
    } catch {
        return null;
    }

    const expectedSignature = await signUploadRelay(secret, "RECEIPT", parsed.uploadId, payload, 0);
    if (!timingSafeEqualStr(signature, expectedSignature)) {
        return null;
    }
    return parsed;
}
