const { verifyToken } = require('../auth');
const db = require('../db');

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.token;
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Not signed in.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.userId);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  req.user = user;
  next();
}

module.exports = requireAuth;