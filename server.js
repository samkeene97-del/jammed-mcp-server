const express = require('express');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const app = express();

app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

const DATA_DIR = '/var/data';
const DATA_FILE = path.join(DATA_DIR, 'bookings.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadBookings() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const data = JSON.parse(raw);
      console.log('Loaded ' + Object.keys(data).length + ' bookings from disk');
      return data;
    }
    console.log('No bookings file on disk yet');
  } catch (e) { console.error('Load error:', e.message); }
  return {};
}

function saveBookings() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(bookingMap), 'utf8'); }
  catch (e) { console.error('DISK WRITE FAILED:', e.message); }
}

const bookingMap = loadBookings();

function getDateStr(b) {
  return b.start || b.start_time || (b.dates && b.dates[0]) || '';
}

function upsertBooking(data) {
  if (!data || !data.code) return false;
  const timeKey = data.start_at || data.start || data.start_time || (data.dates && data.dates[0]) || 'unknown';
  const key = data.code + '_' + timeKey;
  const existing = bookingMap[key];
  if (!existing || (data.updated_at && (!existing.updated_at || data.updated_at >= existing.updated_at))) {
    bookingMap[key] = data;
    return true;
  }
  return false;
}

function getBookings() { return Object.values(bookingMap); }

app.post('/webhook', function(req, res) {
  const data = req.body.data || req.body;
  const saved = upsertBooking(data);
  if (saved) saveBookings();
  res.status(200).json({ received: true, saved: saved, total: Object.keys(bookingMap).length });
});

app.get('/bookings', function(req, res) { res.json(getBookings()); });
app.get('/bookings/count', function(req, res) { res.json({ count: Object.keys(bookingMap).length }); });
app.delete('/bookings', function(req, res) {
  Object.keys(bookingMap).forEach(function(k) { delete bookingMap[k]; });
  saveBookings();
  res.json({ cleared: true });
});

app.post('/mcp', async function(req, res) {
  const mcp = new McpServer({ name: 'jammed-bookings', version: '1.0.0' });

  // NOTE: get_bookings removed — too large for MCP transport (4000+ records).
  // Always use date-specific tools below instead.

  mcp.tool('get_todays_bookings', "Get today's bookings for Habitat Studios", {}, async function() {
    const today = new Date().toISOString().split('T')[0];
    const todays = getBookings().filter(function(b) { return getDateStr(b).startsWith(today); });
    const summary = { date: today, count: todays.length, bookings: todays.map(function(b) {
      return { name: b.name || b.title, room: b.room_name || (b.room && b.room.name), start: getDateStr(b), end: b.end || b.end_time };
    })};
    return { content: [{ type: 'text', text: JSON.stringify(summary) }] };
  });

  mcp.tool('get_bookings_for_date', 'Get bookings for a specific date (YYYY-MM-DD format)', { date: z.string().describe('Date in YYYY-MM-DD format, e.g. 2026-04-12') }, async function({ date }) {
    const matches = getBookings().filter(function(b) { return getDateStr(b).startsWith(date); });
    const summary = { date: date, count: matches.length, bookings: matches.map(function(b) {
      return { name: b.name || b.title, room: b.room_name || (b.room && b.room.name), start: getDateStr(b), end: b.end || b.end_time };
    })};
    return { content: [{ type: 'text', text: JSON.stringify(summary) }] };
  });

  mcp.tool('get_bookings_for_week', 'Get bookings for the next 7 days from today', {}, async function() {
    const now = new Date();
    const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const matches = getBookings().filter(function(b) {
      const d = getDateStr(b); if (!d) return false;
      const bd = new Date(d); return bd >= now && bd <= weekOut;
    });
    matches.sort(function(a, b) { return getDateStr(a) > getDateStr(b) ? 1 : -1; });
    const summary = matches.map(function(b) {
      return { name: b.name || b.title, room: b.room_name || (b.room && b.room.name), start: getDateStr(b), end: b.end || b.end_time };
    });
    return { content: [{ type: 'text', text: JSON.stringify({ count: summary.length, bookings: summary }) }] };
  });

  mcp.tool('get_bookings_summary', 'Get a summary of total bookings and date range in the system', {}, async function() {
    const all = getBookings();
    const dates = all.map(function(b) { return getDateStr(b); }).filter(Boolean).sort();
    return { content: [{ type: 'text', text: JSON.stringify({
      total: all.length,
      earliest: dates[0] || 'none',
      latest: dates[dates.length - 1] || 'none'
    }) }] };
  });

  mcp.tool('clear_bookings', 'Clear all stored bookings', {}, async function() {
    Object.keys(bookingMap).forEach(function(k) { delete bookingMap[k]; });
    saveBookings();
    return { content: [{ type: 'text', text: 'Bookings cleared' }] };
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Jammed MCP server running on port ' + PORT);
  console.log('Bookings on disk: ' + Object.keys(bookingMap).length);
});
