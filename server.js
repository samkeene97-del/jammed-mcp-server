const express = require('express');
const https = require('https');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const app = express();
app.use(express.json());

// Bookings stored by unique key (code + start_time) to avoid duplicates
const bookingMap = {};

function upsertBooking(data) {
  if (!data || !data.code) return;
  const key = data.code + '_' + (data.start_time || data.start_at || '');
  const existing = bookingMap[key];
  // Keep the most recently updated version
  if (!existing || (data.updated_at && (!existing.updated_at || data.updated_at >= existing.updated_at))) {
    bookingMap[key] = data;
  }
}

function getBookings() {
  return Object.values(bookingMap);
}

// Webhook receiver from Jammed via Svix
app.post('/webhook', (req, res) => {
  const payload = req.body;
  const data = payload.data || payload;
  upsertBooking(data);
  res.status(200).json({ received: true });
});

app.get('/bookings', (req, res) => res.json(getBookings()));
app.get('/bookings/count', (req, res) => res.json({ count: Object.keys(bookingMap).length }));
app.delete('/bookings', (req, res) => {
  Object.keys(bookingMap).forEach(k => delete bookingMap[k]);
  res.json({ cleared: true });
});

// Svix auto-recovery: fetch all messages from the last 72 hours every 2 hours
// This ensures any missed webhooks are replayed automatically
const SVIX_APP_ID = 'app_2pDRvJcjhMMJVFY2iCT08h0qU2g';
const SVIX_ENDPOINT_ID = 'ep_3AiOhXWgfFimkmSsCZ8QtCHjtf2';
const SVIX_TOKEN = process.env.SVIX_TOKEN;
const SERVER_URL = process.env.SERVER_URL || 'https://jammed-mcp-server.onrender.com';

async function svixReplay() {
  if (!SVIX_TOKEN) {
    console.log('SVIX_TOKEN not set - skipping auto-replay');
    return;
  }
  try {
    const since = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const body = JSON.stringify({ since });
    console.log('Running Svix replay since', since);

    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.svix.com',
        path: `/api/v1/app/${SVIX_APP_ID}/endpoint/${SVIX_ENDPOINT_ID}/recover/`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SVIX_TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          console.log('Svix replay response:', res.statusCode, data.substring(0, 200));
          resolve();
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.error('Svix replay error:', err.message);
  }
}

// Run replay on startup, then every 2 hours
svixReplay();
setInterval(svixReplay, 2 * 60 * 60 * 1000);

// MCP endpoint
app.post('/mcp', async (req, res) => {
  const mcp = new McpServer({ name: 'jammed-bookings', version: '1.0.0' });

  mcp.tool('get_bookings', 'Get all Habitat Studios bookings', {}, async () => ({
    content: [{ type: 'text', text: JSON.stringify(getBookings()) }]
  }));

  mcp.tool('get_todays_bookings', "Get today's bookings for Habitat Studios", {}, async () => {
    const today = new Date().toISOString().split('T')[0];
    const todays = getBookings().filter(b => {
      const d = b.start_time || b.dates?.[0] || '';
      return d.startsWith(today);
    });
    return { content: [{ type: 'text', text: JSON.stringify(todays) }] };
  });

  mcp.tool('get_bookings_for_date', "Get bookings for a specific date (YYYY-MM-DD)", { date: { type: 'string' } }, async ({ date }) => {
    const matches = getBookings().filter(b => {
      const d = b.start_time || b.dates?.[0] || '';
      return d.startsWith(date);
    });
    return { content: [{ type: 'text', text: JSON.stringify(matches) }] };
  });

  mcp.tool('get_bookings_for_week', "Get bookings for the next 7 days", {}, async () => {
    const now = new Date();
    const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const matches = getBookings().filter(b => {
      const d = b.start_time || b.dates?.[0];
      if (!d) return false;
      const bd = new Date(d);
      return bd >= now && bd <= weekOut;
    });
    matches.sort((a, b) => (a.start_time || a.dates?.[0]) > (b.start_time || b.dates?.[0]) ? 1 : -1);
    return { content: [{ type: 'text', text: JSON.stringify(matches) }] };
  });

  mcp.tool('clear_bookings', 'Clear all stored bookings', {}, async () => {
    Object.keys(bookingMap).forEach(k => delete bookingMap[k]);
    return { content: [{ type: 'text', text: 'Bookings cleared' }] };
  });

  mcp.tool('trigger_replay', 'Manually trigger a Svix replay to refresh booking data', {}, async () => {
    await svixReplay();
    return { content: [{ type: 'text', text: 'Replay triggered. New bookings will arrive via webhook shortly.' }] };
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Jammed MCP server running on port ' + PORT));
