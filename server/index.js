require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');

const authRoutes = require('./routes/auth');
const entryRoutes = require('./routes/entries');
const { router: billingRoutes, webhookHandler } = require('./routes/billing');

// Fail fast rather than silently running with an insecure default secret.
if (process.env.NODE_ENV === 'production') {
  const missing = ['JWT_SECRET', 'ANTHROPIC_API_KEY'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required environment variable(s): ${missing.join(', ')}. Refusing to start in production without them.`);
    process.exit(1);
  }
  if ((process.env.JWT_SECRET || '').length < 20) {
    console.error('JWT_SECRET is too short for production. Use a long, random string.');
    process.exit(1);
  }
}

const app = express();

// Required so secure cookies and rate-limiting see the real client IP/protocol
// when running behind a platform proxy (Render, Railway, etc.).
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false, // the plain HTML/JS frontend has no build step to hash inline scripts against
  })
);

// Stripe needs the raw body to verify webhook signatures, so this is
// mounted before express.json() touches the request.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), webhookHandler);

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/entries', entryRoutes);
app.use('/api/billing', billingRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

// Catch-all error handler: never leak stack traces or internals to clients.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Daybook server running on port ${PORT}`));