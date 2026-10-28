const { createGateway } = require('./gateway.mjs');
// Keep platform-reserved CATALYST_* names out of deployed environment variables.
const gateway = createGateway({ env: { ...process.env,
    CATALYST_UPLOAD_TOKEN: process.env.IMGBED_UPLOAD_TOKEN,
    CATALYST_RELAY_SECRET: process.env.IMGBED_RELAY_SECRET,
    CATALYST_UPLOAD_CHANNEL: process.env.IMGBED_UPLOAD_CHANNEL,
    CATALYST_UPLOAD_CHANNEL_NAME: process.env.IMGBED_UPLOAD_CHANNEL_NAME,
} });

module.exports = async (req, res) => {
    try {
        const request = new Request(new URL(req.url, 'https://catalyst.invalid'), {
            method: req.method, headers: req.headers,
            ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: req, duplex: 'half' }),
        });
        const response = await gateway(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end('{"error":"upload_unavailable"}');
    }
};
