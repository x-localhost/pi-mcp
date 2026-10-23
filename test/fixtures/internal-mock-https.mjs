import https from 'node:https';
import fs from 'node:fs';

const key = fs.readFileSync('/fixture/key.pem');
const cert = fs.readFileSync('/fixture/cert.pem');
let count = 0;
const server = https.createServer({ key, cert }, async (request, response) => {
  if (request.url === '/counter') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ count }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || request.headers.authorization !== 'Bearer mock$literal-only-secret' || request.headers['x-corp-client'] !== 'mock-client') {
    response.writeHead(400); response.end(); return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  count++;
  console.log(JSON.stringify({ event: 'request', count, keys: Object.keys(body).sort(), model: body.model, messageRoles: body.messages?.map(message => message.role), tools: body.tools?.map(tool => tool.function?.name) }));
  if (JSON.stringify(body.messages).includes('CANCEL_MARKER_TEST')) {
    setTimeout(() => { if (!response.destroyed) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end('data: [DONE]\n\n'); } }, 30000).unref();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = chunk => response.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, ...chunk }] })}\n\n`);
  if (body.messages?.some(message => message.role === 'tool')) {
    if (!JSON.stringify(body.messages).includes('Pi MCP project workflow')) { response.end('data: [DONE]\n\n'); return; }
    send({ delta: { role: 'assistant', content: 'Internal mock completed.' }, finish_reason: null });
    send({ delta: {}, finish_reason: 'stop' });
  } else {
    send({ delta: { role: 'assistant', tool_calls: [{ index: 0, id: `read-${count}`, type: 'function', function: { name: 'read', arguments: '{"path":"AGENTS.md"}' } }] }, finish_reason: null });
    send({ delta: {}, finish_reason: 'tool_calls' });
  }
  response.end('data: [DONE]\n\n');
});
server.listen(8443, '0.0.0.0', () => console.log('mock ready'));
