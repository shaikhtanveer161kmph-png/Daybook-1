const rateLimit = require('express-rate-limit');

// Slows down brute-force login/signup guessing: 10 attempts per IP per 15 minutes.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Wait a few minutes and try again.' },
});

// Protects your Anthropic API spend from being run up by one abusive account/IP:
// 20 entry-drafting calls per IP per 10 minutes is generous for a real user, tight for a script.
const draftLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests in a short time. Wait a bit and try again.' },
});

module.exports = { authLimiter, draftLimiter };