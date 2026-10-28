import { FetchHttpHandler } from '@smithy/fetch-http-handler';
import { createS3Client as upstreamClient } from '../../../functions/utils/storage/s3Client.js';
import { currentSignal } from '../runtime.mjs';

export function createS3Client(channel, options = {}) {
    // The invocation abort signal enforces the deadline without leaving an SDK timeout timer behind.
    const client = upstreamClient(channel, { requestHandler: new FetchHttpHandler(), ...options });
    const send = client.send.bind(client);
    client.send = (command, options = {}) => send(command, { ...options, abortSignal: currentSignal() || options.abortSignal });
    return client;
}
