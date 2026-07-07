const express = require('express');
const bcrypt = require('bcryptjs');
const { get, all, run } = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { sendStatusUpdateEmail, sendCustomEmail } = require('../lib/email');

const router = express.Router();

const VALID_STATUSES = ['received', 'acknowledged', 'in_production', 'ready_to_ship', 'shipped', 'delivered', 'cancelled'];

router.post('/login', async (req, res) => {
  try {
    const email = (req.body?.email || '').toString().trim().toLowerCase();
    const password = (req.body?.password || '').toString();
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await get('SELECT id, email, name, password_hash FROM admin_users WHERE email=?', [email]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    req.session.adminId = user.id;
    req.session.adminEmail = user.email;
    req.session.adminName = user.name;
    res.json({ status: 'ok', admin: { email: user.email, name: user.name } });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ status: 'ok' });
});

router.get('/me', (req, res) => {
  if (!req.session?.adminId) return res.status(401).json({ error: 'Not logged in' });
  res.json({ email: req.session.adminEmail, name: req.session.adminName });
});

router.get('/quotes', requireAdmin, async (req, res) => {
  try {
    const { status, country, q, from, to } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, parseInt(req.query.pageSize) || 25);
    const where = [];
    const params = [];

    if (status && VALID_STATUSES.includes(status)) { where.push('status=?'); params.push(status); }
    if (country) { where.push('country=?'); params.push(country); }
    if (from) { where.push('created_at>=?'); params.push(from); }
    if (to) { where.push('created_at<=?'); params.push(to); }
    if (q) {
      where.push('(organisation LIKE ? OR contact_name LIKE ? OR email LIKE ? OR reference LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const totalRow = await get(`SELECT COUNT(*) as n FROM quotes ${whereSql}`, params);
    const total = totalRow?.n || 0;
    const rows = await all(`
      SELECT id, reference, created_at, updated_at, status, organisation, contact_name, email, country, currency, display_total, total_inr
      FROM quotes ${whereSql}
      ORDER BY datetime(created_at) DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, (page - 1) * pageSize]);

    res.json({ total, page, pageSize, rows });
  } catch (e) {
    console.error('List quotes error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/quotes/:id', requireAdmin, async (req, res) => {
  try {
    const row = await get('SELECT * FROM quotes WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const history = await all('SELECT id, status, note, eta_date, changed_by, changed_at FROM quote_status_history WHERE quote_id=? ORDER BY id ASC', [row.id]);
    const comments = await all('SELECT id, comment, created_at FROM customer_comments WHERE quote_id=? ORDER BY id ASC', [row.id]);

    const base = `${req.protocol}://${req.get('host')}`;
    const portalUrl = `${base}/track.html?ref=${encodeURIComponent(row.reference)}&token=${row.access_token}`;

    res.json({
      id: row.id,
      reference: row.reference,
      access_token: row.access_token,
      portal_url: portalUrl,
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
      total_inr: row.total_inr,
      display_total: row.display_total,
      history,
      comments,
    });
  } catch (e) {
    console.error('Get quote error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.patch('/quotes/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status, note, eta_date } = req.body || {};
    if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const row = await get('SELECT * FROM quotes WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const now = new Date().toISOString();
    const info = await run(`
      INSERT INTO quote_status_history (quote_id, status, note, eta_date, changed_by, changed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [row.id, status, note || null, eta_date || null, req.session.adminEmail, now]);

    await run('UPDATE quotes SET status=?, updated_at=? WHERE id=?', [status, now, row.id]);

    const history = { status, note, eta_date };
    // Await so the email actually completes before the serverless function is
    // frozen after res.json(); own try/catch so an email failure isn't a 500.
    try {
      await sendStatusUpdateEmail(row, history);
    } catch (e) {
      console.error('Status email error:', e.message);
    }

    res.json({ status: 'ok', history_id: info.lastInsertRowid });
  } catch (e) {
    console.error('Update status error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/quotes/:id/email', requireAdmin, async (req, res) => {
  try {
    const { subject, body } = req.body || {};
    if (!subject || !body) return res.status(400).json({ error: 'Subject and body required' });

    const row = await get('SELECT * FROM quotes WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });

    await sendCustomEmail(row, subject, body);
    res.json({ status: 'ok' });
  } catch (e) {
    console.error('Custom email error:', e.message);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

router.delete('/quotes/:id', requireAdmin, async (req, res) => {
  try {
    const r = await run('DELETE FROM quotes WHERE id=?', [req.params.id]);
    res.json({ status: 'ok', deleted: r.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
