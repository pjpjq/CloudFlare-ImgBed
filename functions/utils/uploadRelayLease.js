import { getDatabase } from './databaseAdapter.js';
import { getUploadRegistration, validateUploadIdentity } from './uploadRegistration.js';
import { UploadRelayError } from './uploadRelayAuth.js';

function validateJob(payload) {
    validateUploadIdentity(payload.uploadId, payload.fileId);
    if (typeof payload.owner !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.owner)) {
        throw new UploadRelayError(400, 'invalid_owner');
    }
}

export async function releaseUploadLease(env, payload) {
    validateJob(payload);
    await env.img_d1.prepare('DELETE FROM upload_relay_jobs WHERE upload_id = ? AND lease_owner = ?')
        .bind(payload.uploadId, payload.owner).run();
    return { released: true };
}

export async function claimUploadLease(context, payload, now = Date.now(), loadProfile = uploadProfile) {
    validateJob(payload);
    const state = await getUploadRegistration(context.env, payload.uploadId, payload.fileId);
    if (state.state !== 'missing' && state.state !== 'staged') return state;
    const sql = context.env.img_d1;
    const current = await sql.prepare('SELECT * FROM upload_relay_jobs WHERE upload_id = ?')
        .bind(payload.uploadId).first();
    if (current && current.lease_until > now && current.lease_owner !== payload.owner) {
        throw new UploadRelayError(409, 'upload_in_progress', Math.max(1, Math.ceil((current.lease_until - now) / 1000)));
    }
    // Fixed global limits bound provider traffic even across multiple Catalyst instances.
    const window = Math.floor(now / 60_000) * 60_000;
    const rate = await sql.prepare('INSERT INTO upload_relay_rate (id, window_start, starts) VALUES (1, ?, 1) ' +
        'ON CONFLICT(id) DO UPDATE SET window_start = excluded.window_start, starts = ' +
        'CASE WHEN window_start = excluded.window_start THEN starts + 1 ELSE 1 END ' +
        'WHERE window_start != excluded.window_start OR starts < 20 RETURNING starts')
        .bind(window).first();
    if (!rate) throw new UploadRelayError(429, 'upload_rate_limited', Math.ceil((window + 60_000 - now) / 1000));
    await sql.prepare('DELETE FROM upload_relay_jobs WHERE lease_until <= ?').bind(now).run();
    const lease = await sql.prepare('INSERT INTO upload_relay_jobs (upload_id, lease_owner, lease_until) ' +
        'SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM upload_relay_jobs WHERE lease_until > ?) < 2 ' +
        'ON CONFLICT(upload_id) DO NOTHING RETURNING lease_until')
        .bind(payload.uploadId, payload.owner, now + 45_000, now).first();
    if (!lease) throw new UploadRelayError(429, 'upload_concurrency_limited', 2);
    try {
        // Recheck after the lease: another instance may have checkpointed during acquisition.
        const latest = await getUploadRegistration(context.env, payload.uploadId, payload.fileId);
        if (latest.state !== 'missing' && latest.state !== 'staged') {
            await releaseUploadLease(context.env, payload);
            return latest;
        }
        return { state: 'claimed', leaseUntil: lease.lease_until, profile: await loadProfile(context),
            ...(latest.state === 'staged' ? { staged: latest.receipt } : {}) };
    } catch (error) {
        await releaseUploadLease(context.env, payload);
        throw error;
    }
}

async function uploadProfile(context) {
    const { fetchUploadConfig, fetchSecurityConfig, fetchPageConfig } = await import('./sysConfig.js');
    const [upload, security, page, blockedIPs] = await Promise.all([
        fetchUploadConfig(context.env, context), fetchSecurityConfig(context.env, { throwOnError: true }),
        fetchPageConfig(context.env), getDatabase(context.env).get('manage@blockipList'),
    ]);
    // Never distribute CF login hashes, sessions, API tokens or global purge credentials.
    return { upload, security: { upload: security.upload }, page, blockedIPs: blockedIPs || '' };
}
