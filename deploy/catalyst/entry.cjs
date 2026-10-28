const { createGateway } = require('./gateway.mjs');
const gateway = createGateway();

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
