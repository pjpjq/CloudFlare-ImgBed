import { authenticateUploadRelay, UploadRelayError } from '../../utils/uploadRelayAuth.js';
import { registerUploadedFile, getUploadRegistration, checkpointUploadedFile, stageUploadedFile } from '../../utils/uploadRegistration.js';
import { claimUploadLease, releaseUploadLease } from '../../utils/uploadRelayLease.js';
import { getUploadTransfer, beginUploadTransfer, checkpointUploadPart } from '../../utils/uploadRelayTransfer.js';

export async function onRequest(context) {
    try {
        const payload = await authenticateUploadRelay(context.request, context.env.CATALYST_RELAY_SECRET);
        const action = Array.isArray(context.params.action) ? context.params.action.join('/') : context.params.action;
        let result;
        if (action === 'register') {
            result = await registerUploadedFile(context, payload);
        } else if (action === 'status') {
            result = await getUploadRegistration(context.env, payload.uploadId, payload.fileId);
        } else if (action === 'checkpoint') {
            result = await checkpointUploadedFile(context, payload);
        } else if (action === 'stage') {
            result = await stageUploadedFile(context, payload);
        } else if (action === 'claim') {
            result = await claimUploadLease(context, payload);
        } else if (action === 'release') {
            result = await releaseUploadLease(context.env, payload);
        } else if (action === 'transfer-status') {
            result = await getUploadTransfer(context.env, payload);
        } else if (action === 'transfer-begin') {
            result = await beginUploadTransfer(context.env, payload);
        } else if (action === 'transfer-part') {
            result = await checkpointUploadPart(context.env, payload);
        } else {
            throw new UploadRelayError(404, 'unknown_operation');
        }
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
        const expected = error instanceof UploadRelayError;
        const headers = { 'Cache-Control': 'no-store' };
        if (expected && error.retryAfter) headers['Retry-After'] = String(error.retryAfter);
        return Response.json({ error: expected ? error.message : 'upload_registration_unavailable' }, {
            status: expected ? error.status : 503, headers,
        });
    }
}
