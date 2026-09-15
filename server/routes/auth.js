const express = require('express');
const router = express.Router();
const db = require('../db');
const { hashPassword, verifyPassword, signToken } = require('../auth');
const requireAuth = require('../middleware/requireAuth');
const { authLimiter } = require('../middleware/rateLimit');

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/signup', authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  if (!password || typeof password !== 'string' || password.length < 10 || password.length > 200) {
    return res.status(400).json({ error: 'Password must be at least 10 characters.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });
  const password_hash = hashPassword(password);
  const info = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email.toLowerCase(), password_hash);
  const token = signToken(info.lastInsertRowid);
  res.cookie('token', token, COOKIE_OPTS);
  res.json({ id: info.lastInsertRowid, email: email.toLowerCase() });
});

router.post('/login', authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  const token = signToken(user.id);
  res.cookie('token', token, COOKIE_OPTS);
  res.json({ id: user.id, email: user.email });
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const u = req.user;
  const entryCount = db.prepare('SELECT COUNT(*) AS c FROM entries WHERE user_id = ?').get(u.id).c;
  res.json({
    id: u.id,
    email: u.email,
    currency: u.currency,
    subscriptionStatus: u.subscription_status,
    entryCount,
  });
});

router.put('/currency', requireAuth, (req, res) => {
  const { currency } = req.body || {};
  if (!currency) return res.status(400).json({ error: 'Currency symbol required.' });
  db.prepare('UPDATE users SET currency = ? WHERE id = ?').run(currency, req.user.id);
  res.json({ currency });
});

module.exports = router;