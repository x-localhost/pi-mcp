import http from 'node:http';
import { isAbsolute } from 'node:path';

const ROUTE = '/v1/chat/completions';
const TRACE_NAMES = ['x-pi-job-id', 'x-pi-request-id', 'x-pi-attempt-id'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function chatTraceHeaders(req) {
  const counts = Object.fromEntries(TRACE_NAMES.map(name => [name, 0]));
  for (let index = 0; index < (req.rawHeaders?.length ?? 0); index += 2) {
    const name = req.rawHeaders[index].toLowerCase();
    if (Object.hasOwn(counts, name)) counts[name]++;
  }
  const present = TRACE_NAMES.filter(name => req.headers[name] !== undefined);
  if (!present.length) return null;
  if (present.length !== TRACE_NAMES.length || TRACE_NAMES.some(name => counts[name] !== 1 ||
    typeof req.headers[name] !== 'string' || !UUID.test(req.headers[name]))) throw new Error('Invalid chat trace');
  return Object.fromEntries(TRACE_NAMES.map(name => [name, req.headers[name]]));
}
export async function startRelay({ socketPath, port = 18080 }) {
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Relay startup failed');
  const connections = new Set();
  const upstream = new Set();
  const server = http.createServer((req, res) => {
    if (!((req.method === 'GET' && req.url === '/healthz') || (req.method === 'POST' && (req.url === ROUTE || /^\/internal-mcp\/[a-z][a-z0-9_]{0,31}$/.test(req.url ?? '')))) || req.headers.upgrade) { res.writeHead(404); res.end(); return; }
    const headers = {};
    if (req.headers['content-type'] !== undefined) headers['content-type'] = req.headers['content-type'];
    if (req.headers['content-length'] !== undefined) headers['content-length'] = req.headers['content-length'];
    if (req.headers.accept !== undefined) headers.accept = req.headers.accept;
    if (req.method === 'POST' && req.url === ROUTE) {
      try { Object.assign(headers, chatTraceHeaders(req)); }
      catch { res.writeHead(400); res.end(); return; }
    }
    const peer = http.request({ socketPath, path: req.url, method: req.method, headers, timeout: 35_000, agent: false }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.add(peer);
    peer.on('close', () => upstream.delete(peer));
    peer.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy(); });
    peer.on('timeout', () => peer.destroy());
    req.on('error', () => peer.destroy());
    res.on('close', () => peer.destroy());
    req.pipe(peer);
  });
  server.maxHeadersCount = 64;
  server.maxConnections = 32;
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 2_000;
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  return { address: '127.0.0.1', port: server.address().port, close: async () => {
    server.closeAllConnections();
    for (const peer of upstream) peer.destroy();
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(() => resolve()));
  } };
}
