const express = require('express');
const { get, all, run } = require('../db');
const { uuid, randomToken, generateReference } = require('../lib/tokens');
const { sendSubmissionEmails } = require('../lib/email');

const router = express.Router();

const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

router.post('/submit', async (req, res) => {
  try {
    const data = req.body || {};
    const c = data.client || {};
    const p = data.pricing || {};

    if (!c.organisation || !c.contact || !c.email || !c.country || !c.delivery) {
      return res.status(400).json({ status: 'error', error: 'Missing required client fields' });
    }

    const id = uuid();
    const reference = c.reference || generateReference();
    const access_token = randomToken(24);
    const now = new Date().toISOString();

    await run(`
      INSERT INTO quotes (
        id, reference, access_token, created_at, updated_at, status,
        organisation, contact_name, email, phone, country, currency, delivery, quotation_date,
        total_inr, display_total, config_json, pricing_json, remarks
      ) VALUES (?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id, reference, access_token, now, now,
      c.organisation, c.contact, c.email, c.phone || null, c.country, c.currency || 'INR', c.delivery, c.date || null,
      p.total_ex_gst_inr || p.grand_total_inr || 0,
      p.display_total != null ? p.display_total : (p.grand_total_inr || 0),
      JSON.stringify(data.config || {}),
      JSON.stringify(data.pricing || {}),
      data.remarks || null,
    ]);

    await run(`
      INSERT INTO quote_status_history (quote_id, status, note, changed_by, changed_at)
      VALUES (?, 'received', 'Quote submitted by customer', 'system', ?)
    `, [id, now]);

    const base = `${req.protocol}://${req.get('host')}`;
    const portalUrl = `${base}/track.html?ref=${encodeURIComponent(reference)}&token=${access_token}`;

    if (!data.client) data.client = {};
    data.client.reference = reference;

    // NOTE: on Vercel serverless the function is frozen/killed the instant the
    // response is sent, so any not-yet-finished async work (email, webhook) is
    // dropped. We therefore AWAIT these before responding. Each is wrapped in its
    // own try/catch so a delivery failure never turns a saved quote into a 500.
    if (WEBHOOK_URL) {
      try {
        await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
      } catch (e) {
        console.error('Sheets webhook error:', e.message);
      }
    }

    try {
      await sendSubmissionEmails(data, portalUrl);
    } catch (e) {
      console.error('Email error:', e.message);
    }

    res.json({ status: 'ok', reference, portal_url: portalUrl });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

router.get('/quote/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const ref = (req.query.ref || '').toString();
    if (!token || !ref) return res.status(400).json({ error: 'Missing token or reference' });

    const row = await get('SELECT * FROM quotes WHERE access_token=? AND reference=?', [token, ref]);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const history = await all('SELECT status, note, eta_date, changed_at FROM quote_status_history WHERE quote_id=? ORDER BY id ASC', [row.id]);
    const comments = await all('SELECT comment, created_at FROM customer_comments WHERE quote_id=? ORDER BY id ASC', [row.id]);

    res.json({
      reference: row.reference,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      client: {
        organisation: row.organisation,
        contact: row.contact_name,
        email: row.email,
        phone: row.phone,
        country: row.country,
        currency: row.currency,
        delivery: row.delivery,
        date: row.quotation_date,
      },
      config: JSON.parse(row.config_json),
      pricing: JSON.parse(row.pricing_json),
      remarks: row.remarks,
      history,
      comments,
    });
  } catch (err) {
    console.error('Track error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/quote/:token/comment', async (req, res) => {
  try {
    const token = req.params.token;
    const ref = (req.query.ref || '').toString();
    const comment = (req.body?.comment || '').toString().trim();
    if (!comment) return res.status(400).json({ error: 'Comment required' });
    if (comment.length > 2000) return res.status(400).json({ error: 'Comment too long' });

    const row = await get('SELECT id FROM quotes WHERE access_token=? AND reference=?', [token, ref]);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const now = new Date().toISOString();
    await run('INSERT INTO customer_comments (quote_id, comment, created_at) VALUES (?, ?, ?)', [row.id, comment, now]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
