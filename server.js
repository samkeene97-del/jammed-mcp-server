const express = require('express');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');

const app = express();
app.use(express.json());

let bookings = [];

app.post('/webhook', (req, res) => {
  const payload = req.body;
  const data = payload.data || payload;
  if (data && data.code) {
    const exists = bookings.find(b => b.code === data.code && b.start_time === data.start_time);
    if (!exists) bookings.push(data);
  }
  res.status(200).json({ received: true });
});

app.get('/bookings', (req, res) => res.json(bookings));
app.delete('/bookings', (req, res) => { bookings = []; res.json({ cleared: true }); });

const server = new Server({ name: 'jammed-bookings', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler({ method: 'tools/list' }, async () => ({
  tools: [
    { name: 'get_bookings', description: 'Get all Habitat Studios bookings', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_todays_bookings', description: "Get today's bookings", inputSchema: { type: 'object', properties: {} } },
    { name: 'clear_bookings', description: 'Clear all bookings', inputSchema: { type: 'object', properties: {} } }
  ]
}));

server.setRequestHandler({ method: 'tools/call' }, async (req) => {
  const name = req.params.name;
  if (name === 'get_bookings') return { content: [{ type: 'text', text: JSON.stringify(bookings) }] };
  if (name === 'get_todays_bookings') {
    const today = new Date().toISOString().split('T')[0];
    return { content: [{ type: 'text', text: JSON.stringify(bookings.filter(b => b.start_time && b.start_time.startsWith(today))) }] };
  }
  if (name === 'clear_bookings') { bookings = []; return { content: [{ type: 'text', text: 'Cleared' }] }; }
});

const transports = {};
app.get('/mcp', async (req, res) => {
  const transport = new SSEServerTransport('/mcp/message', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => delete transports[transport.sessionId]);
  await server.connect(transport);
});

app.post('/mcp/message', async (req, res) => {
  const transport = transports[req.query.sessionId];
  if (!transport) return res.status(404).json({ error: 'Session not found' });
  await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Jammed MCP server running on port ' + PORT));
