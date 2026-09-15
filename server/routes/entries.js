const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAuth = require('../middleware/requireAuth');
const requireSubscription = require('../middleware/requireSubscription');
const { draftLimiter } = require('../middleware/rateLimit');

const MAX_TEXT_LEN = 500; // what a user can type describing one transaction
const MAX_FIELD_LEN = 200; // account names, narration, party, item descriptions
const MAX_LINES = 20; // entries or items in a single voucher/bill

function clampStr(v, max) {
  return String(v ?? '').slice(0, max);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function pad4(n) {
  return String(n).padStart(4, '0');
}
function extractJSON(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no-json');
  return JSON.parse(match[0]);
}
function buildSystemPrompt() {
  return `You are a bookkeeping assistant for a small business. The user will describe one business transaction in plain, informal language (any language). Your job is to turn it into a structured accounting record.

Classify the transaction into exactly one of two buckets:
- "bill": ONLY when goods or services were sold to a customer, or income was earned from the business's core sales activity.
- "voucher": everything else — expenses, purchases, payments, salaries, bank transactions, loans, asset purchases, refunds, receipts not tied to a sale. When in doubt, choose "voucher".

Respond with ONLY raw JSON, no markdown fences, no commentary before or after, matching exactly one of these two shapes.

Voucher shape:
{"docType":"voucher","date":"YYYY-MM-DD","narration":"short plain description of what happened","entries":[{"account":"Account Name","side":"debit","amount":number},{"account":"Account Name","side":"credit","amount":number}]}

Bill shape:
{"docType":"bill","date":"YYYY-MM-DD","party":"customer name, or Cash Customer if unnamed","items":[{"description":"item or service","amount":number}],"total":number,"narration":"short plain description of what happened"}

Rules:
- Use today's date (${todayISO()}) if no date is stated or implied.
- For vouchers, apply standard double-entry rules: assets and expenses normally increase on the debit side; liabilities, capital, and income normally increase on the credit side. Total debits must equal total credits. A voucher usually has exactly one debit line and one credit line unless the transaction genuinely touches more than two accounts.
- Use clear, conventional account names, e.g. "Cash", "Bank", "Office Rent Expense", "Salaries Expense", "Accounts Payable — [name]", "Accounts Receivable — [name]", "Purchases", "Capital Account".
- For bills, use one line item per distinct good or service mentioned; otherwise a single line item is fine. total must equal the sum of item amounts.
- Amounts are plain numbers only — no currency symbols, no thousands separators.
- If a detail is missing, make the most reasonable bookkeeping judgment rather than asking a question.
- Output must be valid, parseable JSON and nothing else.`;
}

function rowToEntry(row) {
  const base = { id: row.id, docType: row.doc_type, number: row.number, date: row.date, narration: row.narration };
  if (row.doc_type === 'bill') {
    return { ...base, party: row.party, items: JSON.parse(row.items_json), total: row.total };
  }
  return { ...base, entries: JSON.parse(row.entries_json) };
}

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  res.json({ entries: rows.map(rowToEntry) });
});

router.post('/draft', requireAuth, requireSubscription, draftLimiter, async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Describe a transaction first.' });
  if (text.length > MAX_TEXT_LEN) {
    return res.status(400).json({ error: `Keep the description under ${MAX_TEXT_LEN} characters.` });
  }
  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: text }],
      }),
    });
    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('Anthropic API error:', errText);
      return res.status(502).json({ error: 'Could not reach the AI service. Try again shortly.' });
    }
    const data = await apiRes.json();
    const rawText = (data.content || []).map((b) => b.text || '').join('').trim();
    const parsed = extractJSON(rawText);

    if (parsed.docType === 'voucher') {
      if (!Array.isArray(parsed.entries) || parsed.entries.length < 2) throw new Error('bad-shape');
      return res.json({
        docType: 'voucher',
        date: parsed.date || todayISO(),
        narration: parsed.narration || text,
        entries: parsed.entries.map((e) => ({
          account: String(e.account || 'Unspecified'),
          side: e.side === 'credit' ? 'credit' : 'debit',
          amount: Number(e.amount) || 0,
        })),
      });
    }
    if (parsed.docType === 'bill') {
      if (!Array.isArray(parsed.items) || parsed.items.length < 1) throw new Error('bad-shape');
      const items = parsed.items.map((i) => ({ description: String(i.description || 'Item'), amount: Number(i.amount) || 0 }));
      return res.json({
        docType: 'bill',
        date: parsed.date || todayISO(),
        party: parsed.party || 'Cash Customer',
        items,
        narration: parsed.narration || text,
      });
    }
    throw new Error('bad-shape');
  } catch (e) {
    console.error(e);
    res.status(422).json({ error: "Couldn't turn that into an entry. Try including an amount and what it was for." });
  }
});

router.post('/', requireAuth, requireSubscription, (req, res) => {
  const data = req.body || {};
  const user = req.user;
  if (data.docType === 'voucher') {
    if (!Array.isArray(data.entries) || data.entries.length < 1) {
      return res.status(400).json({ error: 'A voucher needs at least one line.' });
    }
    if (data.entries.length > MAX_LINES) {
      return res.status(400).json({ error: `A voucher can have at most ${MAX_LINES} lines.` });
    }
    const entries = data.entries.map((e) => ({
      account: clampStr(e.account, MAX_FIELD_LEN),
      side: e.side === 'credit' ? 'credit' : 'debit',
      amount: Number(e.amount) || 0,
    }));
    const number = `JV-${pad4(user.voucher_counter)}`;
    const info = db
      .prepare('INSERT INTO entries (user_id, doc_type, number, date, narration, entries_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, 'voucher', number, data.date || todayISO(), clampStr(data.narration, MAX_FIELD_LEN), JSON.stringify(entries));
    db.prepare('UPDATE users SET voucher_counter = voucher_counter + 1 WHERE id = ?').run(user.id);
    return res.json(rowToEntry(db.prepare('SELECT * FROM entries WHERE id = ?').get(info.lastInsertRowid)));
  }
  if (data.docType === 'bill') {
    if (!Array.isArray(data.items) || data.items.length < 1) {
      return res.status(400).json({ error: 'A bill needs at least one item.' });
    }
    if (data.items.length > MAX_LINES) {
      return res.status(400).json({ error: `A bill can have at most ${MAX_LINES} items.` });
    }
    const items = data.items.map((i) => ({
      description: clampStr(i.description, MAX_FIELD_LEN),
      amount: Number(i.amount) || 0,
    }));
    const total = items.reduce((s, i) => s + i.amount, 0);
    const number = `INV-${pad4(user.bill_counter)}`;
    const info = db
      .prepare('INSERT INTO entries (user_id, doc_type, number, date, narration, party, items_json, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, 'bill', number, data.date || todayISO(), clampStr(data.narration, MAX_FIELD_LEN), clampStr(data.party || 'Cash Customer', MAX_FIELD_LEN), JSON.stringify(items), total);
    db.prepare('UPDATE users SET bill_counter = bill_counter + 1 WHERE id = ?').run(user.id);
    return res.json(rowToEntry(db.prepare('SELECT * FROM entries WHERE id = ?').get(info.lastInsertRowid)));
  }
  res.status(400).json({ error: 'Unrecognized entry type.' });
});

router.put('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Entry not found.' });
  const data = req.body || {};
  if (row.doc_type === 'bill') {
    const rawItems = Array.isArray(data.items) ? data.items.slice(0, MAX_LINES) : JSON.parse(row.items_json);
    const items = rawItems.map((i) => ({ description: clampStr(i.description, MAX_FIELD_LEN), amount: Number(i.amount) || 0 }));
    const total = items.reduce((s, i) => s + i.amount, 0);
    db.prepare('UPDATE entries SET date = ?, narration = ?, party = ?, items_json = ?, total = ? WHERE id = ?').run(
      data.date || row.date,
      data.narration !== undefined ? clampStr(data.narration, MAX_FIELD_LEN) : row.narration,
      data.party !== undefined ? clampStr(data.party, MAX_FIELD_LEN) : row.party,
      JSON.stringify(items),
      total,
      row.id
    );
  } else {
    const rawEntries = Array.isArray(data.entries) ? data.entries.slice(0, MAX_LINES) : JSON.parse(row.entries_json);
    const entries = rawEntries.map((e) => ({
      account: clampStr(e.account, MAX_FIELD_LEN),
      side: e.side === 'credit' ? 'credit' : 'debit',
      amount: Number(e.amount) || 0,
    }));
    db.prepare('UPDATE entries SET date = ?, narration = ?, entries_json = ? WHERE id = ?').run(
      data.date || row.date,
      data.narration !== undefined ? clampStr(data.narration, MAX_FIELD_LEN) : row.narration,
      JSON.stringify(entries),
      row.id
    );
  }
  res.json(rowToEntry(db.prepare('SELECT * FROM entries WHERE id = ?').get(row.id)));
});

router.delete('/:id', requireAuth, (req, res) => {
  const info = db.prepare('DELETE FROM entries WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Entry not found.' });
  res.json({ ok: true });
});

module.exports = router;