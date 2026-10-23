import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const schema = { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['path'], additionalProperties: false };
const server = new Server({ name: 'docs', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'read', description: 'Read a document', inputSchema: schema }] }));
server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: process.env.PI_SECRET_TEST ? 'LEAK' : `DOC:${request.params.arguments.path}` }] }));
await server.connect(new StdioServerTransport());
