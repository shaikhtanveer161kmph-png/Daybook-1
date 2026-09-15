const db = require('../db');

const FREE_TRIAL_ENTRIES = Number(process.env.FREE_TRIAL_ENTRIES || 5);

function requireSubscription(req, res, next) {
  const user = req.user;
  if (user.subscription_status === 'active') return next();
  const count = db.prepare('SELECT COUNT(*) AS c FROM entries WHERE user_id = ?').get(user.id).c;
  if (count < FREE_TRIAL_ENTRIES) return next();
  return res.status(402).json({
    error: 'Free trial used up. Subscribe to keep creating entries.',
    trialLimit: FREE_TRIAL_ENTRIES,
  });
}

module.exports = requireSubscription;