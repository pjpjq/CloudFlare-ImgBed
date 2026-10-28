import { cleanPersistedMetadata } from './metadata/metadataSecurity.js';
import { UploadRelayError } from './uploadRelayAuth.js';

const PRIVATE_FIELDS = new Set(['accesstoken', 'accesskeyid', 'secretaccesskey', 'bottoken', 'token',
    'password', 'authorization', 'apikey', 'clientsecret', 'headers', 'cfapikey', 'cfemail',
    'catalystrelaysecret', 'catalystuploadtoken']);

export function cleanRelayMetadata(metadata) {
    function visit(value, depth = 0) {
        if (depth > 8) throw new UploadRelayError(400, 'invalid_metadata');
        if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).filter(([key]) => {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new UploadRelayError(400, 'invalid_metadata');
            return !PRIVATE_FIELDS.has(key.replace(/[-_]/g, '').toLowerCase());
        }).map(([key, item]) => [key, visit(item, depth + 1)]));
    }
    return visit(cleanPersistedMetadata(metadata));
}
