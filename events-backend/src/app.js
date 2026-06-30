const express = require('express');
const cors = require('cors');
const path = require('path');

const authRouter = require('./routes/auth');
const uploadRouter = require('./routes/upload');
const eventsRouter = require('./routes/events');
const bookingsRouter = require('./routes/bookings');
const wishlistRouter = require('./routes/wishlist');
const seatsRouter = require('./routes/seats');
const screeningsRouter = require('./routes/screenings');
const bannersRouter = require('./routes/banners');
const walletRouter = require('./routes/wallet');
const paymentsRouter = require('./routes/payments');
const adminRouter    = require('./routes/admin');

const app = express();

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/events/api/admin/upload', uploadRouter);

app.use('/events/api/auth', authRouter);
app.use('/events/api/events', eventsRouter);
app.use('/events/api/events/:id', seatsRouter);
app.use('/events/api/events',    screeningsRouter);
app.use('/events/api/screenings', screeningsRouter);
app.use('/events/api/bookings', bookingsRouter);
app.use('/events/api/wishlist', wishlistRouter);
app.use('/events/api/banners', bannersRouter);
app.use('/events/api/wallet', walletRouter);
app.use('/events/api/payments', paymentsRouter);
app.use('/events/api/admin',   adminRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use((err, _req, res, _next) => {
  // Log full details server-side only
  console.error(`[error] ${err.message}`);

  // Prisma and MySQL errors — never expose to client
  const isPrismaError = err.constructor?.name?.startsWith('PrismaClient') || err.code?.startsWith?.('P');
  const isMysqlError = typeof err.errno === 'number' || err.sqlState != null;

  if (isPrismaError || isMysqlError) {
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }

  // App-level errors with an explicit HTTP status (4xx) are safe to forward
  const status = err.status || 500;
  const message = status < 500 ? err.message : 'Something went wrong. Please try again.';
  res.status(status).json({ success: false, message });
});

module.exports = app;
