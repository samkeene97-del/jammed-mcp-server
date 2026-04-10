const express = require('express');
const fs = require('fs');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const app = express();
app.use(express.json());

const DATA_DIR = '/var/data';
const DATA_FILE = path.join(DATA_DIR, 'bookings.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadBookings() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const data = JSON.parse(raw);
      console.log('Loaded ' + Object.keys(data).length + ' bookings from disk');
      return data;
    } else {
      console.log('No bookings file found on disk, starting fresh');
    }
  } catch (e) {
    console.error('Failed to load bookings from disk:', e.message);
  }
  return {};
}

function saveBookings() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(bookingMap), 'utf8');
  } catch (e) {
    console.error('DISK WRITE FAILED:', e.message);
  }
}

const bookingMap = loadBookings();

function upsertBooking(data) {
  if (!data || !data.code) return false;
  // Use code + start_at (unix) as key — most reliable unique identifier
  const timeKey = data.start_at || data.start_time || data.dates && data.dates[0] || 'unknown';
  const key = data.code + '_' + timeKey;
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

app.post('/webhook', (req, res) => {
  const payload = req.body;
  const data = payload.data || payload;
  const saved = upsertBooking(data);
  res.status(200).json({ received: true, saved: saved, total: Object.keys(bookingMap).length });
});

app.get('/bookings', (req, res) => res.json(getBookings()));
app.get('/bookings/count', (req, res) => res.json({ count: Object.keys(bookingMap).length }));
app.delete('/bookings', (req, res) => {
  Object.keys(bookingMap).forEach(k => delete bookingMap[k]);
  saveBookings();
  res.json({ cleared: true });
});

app.post('/mcp', async (req, res) => {
  const mcp = new McpServer({ name: 'jammed-bookings', version: '1.0.0' });

  mcp.tool('get_bookings', 'Get all Habitat Studios bookings', {}, async () => ({
    content: [{ type: 'text', text: JSON.stringify(getBookings()) }]
  }));

  mcp.tool('get_todays_bookings', "Get today's bookings for Habitat Studios", {}, async () => {
    const today = new Date().toISOString().split('T')[0];
    const todays = getBookings().filter(b => {
      const d = b.start_time || (b.dates && b.dates[0]) || '';
      return d.startsWith(today);
    });
    return { content: [{ type: 'text', text: JSON.stringify(todays) }] };
  });

  mcp.tool('get_bookings_for_date', 'Get bookings for a specific date (YYYY-MM-DD)', { date: { type: 'string' } }, async ({ date }) => {
    const matches = getBookings().filter(b => {
      const d = b.start_time || (b.dates && b.dates[0]) || '';
      return d.startsWith(date);
    });
    return { content: [{ type: 'text', text: JSON.stringify(matches) }] };
  });

  mcp.tool('get_bookings_for_week', 'Get bookings for the next 7 days', {}, async () => {
    const now = new Date();
    const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const matches = getBookings().filter(b => {
      const d = b.start_time || (b.dates && b.dates[0]);
      if (!d) return false;
      const bd = new Date(d);
      return bd >= now && bd <= weekOut;
    });
    matches.sort((a, b) => {
      const da = a.start_time || (a.dates && a.dates[0]) || '';
      const db = b.start_time || (b.dates && b.dates[0]) || '';
      return da > db ? 1 : -1;
    });
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
  console.log('Disk path: ' + DATA_FILE);
  console.log('Disk exists: ' + fs.existsSync(DATA_DIR));
  console.log('Bookings loaded: ' + Object.keys(bookingMap).length);
});
