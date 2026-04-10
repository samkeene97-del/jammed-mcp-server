const express = require('express');
const app = express();
app.use(express.json());

let bookings = [];

app.post('/webhook', (req, res) => {
  const booking = req.body;
  if (booking && booking.code) {
    const exists = bookings.find(b => b.code === booking.code && b.start_time === booking.start_time);
    if (!exists) bookings.push(booking);
  }
  res.status(200).json({ received: true });
});

app.get('/bookings', (req, res) => {
  res.json(bookings);
});

app.delete('/bookings', (req, res) => {
  bookings = [];
  res.json({ cleared: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Jammed MCP server running on port ${PORT}`));
