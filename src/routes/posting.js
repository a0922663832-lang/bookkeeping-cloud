// src/routes/posting.js
// M3 stage 1a (webhook + pending review) + M3 stage 1b (HMAC + webhook log).
//
// Endpoints:
//   POST /B/:bookCode/internal/posting      Webhook entry (HMAC OR X-Posting-Token)
//   GET  /B/:bookCode/pending-journals      List pending review (JWT)
//   GET  /B/:bookCode/pending-journals/:id  Detail (JWT)
//   POST /B/:bookCode/pending-journals/:id/approve  (JWT, owner/admin)
//   POST /B/:bookCode/pending-journals/:id/reject   (JWT, owner/admin)
//
// Auth for /internal/posting:
//   - If env WEBHOOK_HMAC_SECRET is set (production): HMAC required, X-Timestamp + X-Signature.
//   - Else if env SHARED_POSTING_TOKEN is set: X-Posting-Token must match.
//   - Else (dev mode): accept all (LAN only).

'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth } = require('../auth');
const bookCode = require('../utils/bookCode');
const asyncHandler = require('../utils/asyncHandler');
const hmac = require('../utils/hmac');

const router = express.Router();

const SHARED_POSTING_TOKEN = process.env.SHARED_POSTING_TOKEN || null;

// ── helpers ─────────────────────────────────────────────────────────
async function loadBookOpen(req, res, next) {
  const code = (req.params.bookCode || '').toUpperCase();
  if (!bookCode.isValidFormat(code)) {
    return res.status(400).json({ error: 'invalid book code format' });
  }
  const result = await query(
    `SELECT id, code, posting_mode FROM books WHERE code = $1 AND is_active = TRUE`,
    [code]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'book not found' });
  }
  req.book = result.rows[0];
  next();
}

async function loadBookAuth(req, res, next) {
  const code = (req.params.bookCode || '').toUpperCase();
  if (!bookCode.isValidFormat(code)) {
    return res.status(400).json({ error: 'invalid book code format' });
  }
  const result = await query(
    `SELECT b.id, b.code, b.posting_mode, bm.role
       FROM books b JOIN book_members bm ON bm.book_id = b.id
      WHERE b.code = $1 AND bm.user_id = $2 AND b.is_active = TRUE`,
    [code, req.user.id]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'book not found or no access' });
  }
  req.book = { id: result.rows[0].id, code: result.rows[0].code, posting_mode: result.rows[0].posting_mode };
  req.bookMember = { role: result.rows[0].role };
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.bookMember || !roles.includes(req.bookMember.role)) {
      return res.status(403).json({ error: `forbidden, requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

const loadOpen = asyncHandler(loadBookOpen);
const loadAuth = asyncHandler(loadBookAuth);

function validateProposedJournal(p) {
  if (!p || typeof p !== 'object') return 'proposed_journal required (object)';
  if (!p.date || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return 'proposed_journal.date (YYYY-MM-DD) required';
  if (!['expense', 'income', 'transfer', 'reclassify'].includes(p.type)) return 'proposed_journal.type invalid';
  if (!(Number(p.amount) > 0)) return 'proposed_journal.amount must be > 0';
  if (!p.subject_id) return 'proposed_journal.subject_id required';
  if (p.type === 'expense' && !p.transfer_out_account_id) return 'expense requires transfer_out_account_id';
  if (p.type === 'income' && !p.transfer_in_account_id) return 'income requires transfer_in_account_id';
  if (p.type === 'transfer' && (!p.transfer_out_account_id || !p.transfer_in_account_id)) return 'transfer requires both transfer accounts';
  if (p.type === 'reclassify' && !p.reclassify_from_subject_id) return 'reclassify requires reclassify_from_subject_id';
  return null;
}

async function insertJournalFromProposed(client, bookId, p, externalSource, externalId, createdByUserId, isAuto) {
  const insertRes = await client.query(
    `INSERT INTO journal_logs (
       book_id, date, type, amount,
       subject_id, reclassify_from_subject_id,
       transfer_out_account_id, transfer_in_account_id,
       counterparty_id, summary, note,
       external_source, external_id, is_auto_posted,
       created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)
     RETURNING *`,
    [
      bookId, p.date, p.type, Number(p.amount),
      p.subject_id, p.reclassify_from_subject_id || null,
      p.transfer_out_account_id || null, p.transfer_in_account_id || null,
      p.counterparty_id || null, p.summary || null, p.note || null,
      externalSource, externalId, isAuto, createdByUserId,
    ]
  );
  const journal = insertRes.rows[0];
  const amt = Number(p.amount);
  if (p.type === 'expense' || p.type === 'transfer') {
    await client.query(
      `UPDATE ag_accounts SET current_balance = current_balance - $1, updated_at = NOW()
        WHERE id = $2 AND book_id = $3`,
      [amt, p.transfer_out_account_id, bookId]
    );
  }
  if (p.type === 'income' || p.type === 'transfer') {
    await client.query(
      `UPDATE ag_accounts SET current_balance = current_balance + $1, updated_at = NOW()
        WHERE id = $2 AND book_id = $3`,
      [amt, p.transfer_in_account_id, bookId]
    );
  }
  if (p.counterparty_id) {
    await client.query(
      `UPDATE counterparties SET promote_count = promote_count + 1, updated_at = NOW()
        WHERE id = $1 AND book_id = $2`,
      [p.counterparty_id, bookId]
    );
  }
  return journal;
}

// ── webhook log helper (M3 stage 1b) ────────────────────────────────
// Records every /internal/posting hit regardless of outcome.
// Fire-and-forget: any DB error is logged but not propagated.
async function logWebhookInbound(req, bookId, hmacValid, status, responseBody) {
  try {
    await query(
      `INSERT INTO webhook_logs_inbound
         (book_id, external_source, event_id, request_path, request_headers,
          request_body, response_status, response_body, hmac_valid, client_ip)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10)`,
      [
        bookId || null,
        (req.body && req.body.external_source) || null,
        (req.body && req.body.event_id) || null,
        req.originalUrl || req.url || '',
        JSON.stringify(req.headers || {}),
        JSON.stringify(req.body || {}),
        status,
        JSON.stringify(responseBody || {}),
        hmacValid,
        req.ip || req.connection?.remoteAddress || null,
      ]
    );
  } catch (e) {
    console.error('[webhook-log] failed:', e.message);
  }
}

// ============================================================================
// POST /B/:bookCode/internal/posting
// ============================================================================
router.post('/B/:bookCode/internal/posting', loadOpen, asyncHandler(async (req, res) => {
  // ── auth: HMAC > token > dev ─────────────────────────────────────
  let hmacValid = false;
  if (hmac.isConfigured()) {
    const r = hmac.verifyRequest(req.headers, req.rawBody || '');
    if (!r.valid) {
      await logWebhookInbound(req, req.book.id, false, 401, { error: r.reason });
      return res.status(401).json({ error: r.reason });
    }
    hmacValid = true;
  } else if (SHARED_POSTING_TOKEN) {
    if (req.headers['x-posting-token'] !== SHARED_POSTING_TOKEN) {
      await logWebhookInbound(req, req.book.id, false, 401, { error: 'invalid X-Posting-Token' });
      return res.status(401).json({ error: 'invalid or missing X-Posting-Token' });
    }
  }
  // else: dev mode, accept all

  const b = req.body || {};
  const { external_source, external_id, event_id, payload, proposed_journal } = b;

  if (!external_source || typeof external_source !== 'string' || external_source.length > 30) {
    const body = { error: 'external_source required (string, max 30)' };
    await logWebhookInbound(req, req.book.id, hmacValid, 400, body);
    return res.status(400).json(body);
  }
  if (!external_id || typeof external_id !== 'string' || external_id.length > 100) {
    const body = { error: 'external_id required (string, max 100)' };
    await logWebhookInbound(req, req.book.id, hmacValid, 400, body);
    return res.status(400).json(body);
  }
  const vErr = validateProposedJournal(proposed_journal);
  if (vErr) {
    const body = { error: vErr };
    await logWebhookInbound(req, req.book.id, hmacValid, 400, body);
    return res.status(400).json(body);
  }

  // ── idempotency check ──
  const existJ = await query(
    `SELECT id FROM journal_logs WHERE book_id = $1 AND external_source = $2 AND external_id = $3`,
    [req.book.id, external_source, external_id]
  );
  if (existJ.rows.length > 0) {
    const body = { idempotent: true, journal_id: existJ.rows[0].id, status: 'already_posted' };
    await logWebhookInbound(req, req.book.id, hmacValid, 200, body);
    return res.status(200).json(body);
  }
  const existP = await query(
    `SELECT id, status, resulting_journal_id FROM pending_journals
      WHERE book_id = $1 AND external_source = $2 AND external_id = $3`,
    [req.book.id, external_source, external_id]
  );
  if (existP.rows.length > 0) {
    const row = existP.rows[0];
    const body = { idempotent: true, pending_journal_id: row.id, status: row.status, journal_id: row.resulting_journal_id };
    await logWebhookInbound(req, req.book.id, hmacValid, 200, body);
    return res.status(200).json(body);
  }

  const mode = req.book.posting_mode || 'review';
  if (mode === 'manual') {
    const body = { error: 'book in manual mode, auto posting disabled' };
    await logWebhookInbound(req, req.book.id, hmacValid, 422, body);
    return res.status(422).json(body);
  }

  if (mode === 'auto') {
    const journal = await withTransaction(async (client) => {
      const pj = await client.query(
        `INSERT INTO pending_journals (book_id, external_source, external_id, event_id, payload, proposed_journal, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'auto_posted') RETURNING id`,
        [req.book.id, external_source, external_id, event_id || null,
         JSON.stringify(payload || {}), JSON.stringify(proposed_journal)]
      );
      const j = await insertJournalFromProposed(client, req.book.id, proposed_journal,
        external_source, external_id, null, true);
      await client.query(
        `UPDATE pending_journals SET resulting_journal_id = $1, reviewed_at = NOW() WHERE id = $2`,
        [j.id, pj.rows[0].id]
      );
      return j;
    });
    const body = { mode: 'auto', journal };
    await logWebhookInbound(req, req.book.id, hmacValid, 201, { journal_id: journal.id, mode: 'auto' });
    return res.status(201).json(body);
  }

  // review mode
  const pending = await query(
    `INSERT INTO pending_journals (book_id, external_source, external_id, event_id, payload, proposed_journal, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'pending') RETURNING *`,
    [req.book.id, external_source, external_id, event_id || null,
     JSON.stringify(payload || {}), JSON.stringify(proposed_journal)]
  );
  const body = { mode: 'review', pending_journal: pending.rows[0] };
  await logWebhookInbound(req, req.book.id, hmacValid, 202, { pending_id: pending.rows[0].id, mode: 'review' });
  res.status(202).json(body);
}));

// ============================================================================
// GET /B/:bookCode/pending-journals
// ============================================================================
router.get('/B/:bookCode/pending-journals', requireAuth, loadAuth, asyncHandler(async (req, res) => {
  const status = req.query.status || 'pending';
  if (!['pending', 'approved', 'rejected', 'auto_posted', 'all'].includes(status)) {
    return res.status(400).json({ error: 'invalid status filter' });
  }
  const where = ['book_id = $1'];
  const params = [req.book.id];
  if (status !== 'all') {
    where.push(`status = $${params.length + 1}`);
    params.push(status);
  }
  const result = await query(
    `SELECT * FROM pending_journals
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC LIMIT 200`,
    params
  );
  res.json({ pending_journals: result.rows, count: result.rows.length });
}));

router.get('/B/:bookCode/pending-journals/:id', requireAuth, loadAuth, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  const result = await query(
    `SELECT * FROM pending_journals WHERE id = $1 AND book_id = $2`,
    [id, req.book.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'pending journal not found' });
  res.json({ pending_journal: result.rows[0] });
}));

// ============================================================================
// POST approve / reject
// ============================================================================
router.post(
  '/B/:bookCode/pending-journals/:id/approve',
  requireAuth, loadAuth, requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });

    const result = await withTransaction(async (client) => {
      const pjRes = await client.query(
        `SELECT * FROM pending_journals WHERE id = $1 AND book_id = $2 FOR UPDATE`,
        [id, req.book.id]
      );
      if (pjRes.rows.length === 0) throw Object.assign(new Error('pending journal not found'), { status: 404 });
      const pj = pjRes.rows[0];
      if (pj.status !== 'pending') {
        throw Object.assign(new Error(`status is ${pj.status}, cannot approve`), { status: 409 });
      }
      const proposed = pj.proposed_journal;
      const vErr = validateProposedJournal(proposed);
      if (vErr) throw Object.assign(new Error(`proposed journal invalid: ${vErr}`), { status: 400 });

      const journal = await insertJournalFromProposed(
        client, req.book.id, proposed,
        pj.external_source, pj.external_id, req.user.id, true
      );
      await client.query(
        `UPDATE pending_journals SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(),
                review_note = $2, resulting_journal_id = $3, updated_at = NOW()
          WHERE id = $4`,
        [req.user.id, req.body.review_note || null, journal.id, id]
      );
      return { pending_id: id, journal };
    });

    res.json({ ok: true, ...result });
  })
);

router.post(
  '/B/:bookCode/pending-journals/:id/reject',
  requireAuth, loadAuth, requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const pjRes = await query(
      `SELECT id, status FROM pending_journals WHERE id = $1 AND book_id = $2`,
      [id, req.book.id]
    );
    if (pjRes.rows.length === 0) return res.status(404).json({ error: 'pending journal not found' });
    if (pjRes.rows[0].status !== 'pending') {
      return res.status(409).json({ error: `status is ${pjRes.rows[0].status}, cannot reject` });
    }
    await query(
      `UPDATE pending_journals SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(),
              review_note = $2, updated_at = NOW() WHERE id = $3`,
      [req.user.id, req.body.review_note || null, id]
    );
    res.json({ ok: true, pending_id: id, status: 'rejected' });
  })
);

router.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
});

module.exports = router;
