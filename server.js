const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
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

const mcp = new McpServer({ name: 'jammed-bookings', version: '1.0.0' });

mcp.tool('get_bookings', 'Get all Habitat Studios bookings', {}, async () => ({
  content: [{ type: 'text', text: JSON.stringify(bookings) }]
}));

mcp.tool('get_todays_bookings', "Get today's bookings", {}, async () => {
  const today = new Date().toISOString().split('T')[0];
  return { content: [{ type: 'text', text: JSON.stringify(bookings.filter(b => b.start_time && b.start_time.startsWith(today))) }] };
});

mcp.tool('clear_bookings', 'Clear all stored bookings', {}, async () => {
  bookings = [];
  return { content: [{ type: 'text', text: 'Bookings cleared' }] };
});

const transports = {};
app.get('/mcp', async (req, res) => {
  const transport = new SSEServerTransport('/mcp/message', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => delete transports[transport.sessionId]);
  await mcp.connect(transport);
});

app.post('/mcp/message', async (req, res) => {
  const transport = transports[req.query.sessionId];
  if (!transport) return res.status(404).json({ error: 'Session not found' });
  await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Jammed MCP server running on port ' + PORT));
