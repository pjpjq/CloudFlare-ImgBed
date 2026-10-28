import { RawSha256 } from '@aws-crypto/sha256-js/build/main/RawSha256.js';

export function hashPart(previous, bytes, manifest, last) {
    const hash = new RawSha256();
    if (previous) {
        if (!Array.isArray(previous.words) || previous.words.length !== 8 ||
            previous.words.some(word => !Number.isInteger(word) || word < -2147483648 || word > 2147483647) ||
            !Number.isSafeInteger(previous.bytesHashed) || previous.bytesHashed < 0 || previous.bytesHashed % 64) {
            throw new Error('invalid_hash_state');
        }
        // shortcut: locked AWS RawSha256 internal state; CI must revalidate this layout on SDK upgrades.
        hash.state.set(previous.words);
        hash.bytesHashed = previous.bytesHashed;
    }
    hash.update(bytes);
    if (last) {
        hash.update(new TextEncoder().encode(`\0${manifest.fileName}\0${manifest.contentType}`));
        return { digest: Buffer.from(hash.digest()).toString('hex') };
    }
    if (hash.bufferLength !== 0) throw new Error('hash_checkpoint_must_be_block_aligned');
    // No partial buffer is serialized: hash checkpoints never include original image bytes.
    return { hashState: { words: Array.from(hash.state), bytesHashed: hash.bytesHashed } };
}
