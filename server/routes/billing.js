const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const db = require('../db');
const requireAuth = require('../middleware/requireAuth');

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

router.post('/create-checkout-session', requireAuth, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Billing is not configured yet.' });
  const user = req.user;
  try {
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${process.env.APP_URL}/?checkout=success`,
      cancel_url: `${process.env.APP_URL}/?checkout=cancelled`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not start checkout.' });
  }
});

router.post('/portal', requireAuth, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Billing is not configured yet.' });
  const user = req.user;
  if (!user.stripe_customer_id) return res.status(400).json({ error: 'No billing account yet.' });
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${process.env.APP_URL}/`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not open billing portal.' });
  }
});

// This handler needs the raw request body for Stripe's signature check,
// so it is mounted in server/index.js BEFORE the express.json() middleware.
async function webhookHandler(req, res) {
  if (!stripe) return res.status(500).send('Billing not configured');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const setStatusByCustomer = (customerId, status) => {
    db.prepare('UPDATE users SET subscription_status = ? WHERE stripe_customer_id = ?').run(status, customerId);
  };

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      db.prepare('UPDATE users SET subscription_status = ?, stripe_subscription_id = ? WHERE stripe_customer_id = ?').run(
        'active',
        session.subscription,
        session.customer
      );
      break;
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      setStatusByCustomer(sub.customer, sub.status === 'active' ? 'active' : sub.status);
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      setStatusByCustomer(sub.customer, 'cancelled');
      break;
    }
    default:
      break;
  }
  res.json({ received: true });
}

module.exports = { router, webhookHandler };