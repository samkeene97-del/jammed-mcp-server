const express = require('express');
const fs = require('fs');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const app = express();
app.use(express.json());

// Persistent storage on Render Disk at /var/data
const DATA_DIR = '/var/data';
const DATA_FILE = path.join(DATA_DIR, 'bookings.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Load bookings from disk on startup
function loadBookings() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const data = JSON.parse(raw);
      console.log(`Loaded ${Object.keys(data).length} bookings from disk`);
      return data;
    }
  } catch (e) {
    console.error('Failed to load bookings from disk:', e.message);
  }
  return {};
}

// Save bookings to disk
function saveBookings() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(bookingMap), 'utf8');
  } catch (e) {
    console.error('Failed to save bookings to disk:', e.message);
  }
}

// Bookings stored by unique key to avoid duplicates
const bookingMap = loadBookings();

function upsertBooking(data) {
  if (!data || !data.code) return false;
  const key = data.code + '_' + (data.start_time || data.start_at || '');
  const existing = bookingMap[key];
  if (!existing || (data.updated_at && (!existing.updated_at || data.updated_at >= existing.updated_at))) {
    bookingMap[key] = data;
    saveBookings();
    return true;
  }
  return false;
}

function getBookings() {
  return Object.values(bookingMap);
}

// Webhook from Jammed via Svix
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
  saveBookings();
  res.json({ cleared: true });
});

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
    saveBookings();
    return { content: [{ type: 'text', text: 'Bookings cleared' }] };
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Jammed MCP server running on port ' + PORT);
  console.log('Bookings loaded from disk: ' + Object.keys(bookingMap).length);
});
