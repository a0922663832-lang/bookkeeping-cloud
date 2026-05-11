// src/routes/posting.js
// M3 stage 1a: webhook 接收 + Pending Review.
//
// Endpoints:
//   POST /B/:bookCode/internal/posting      接收外部入帳事件 (進貨 / POS / INLINE / HR)
//   GET  /B/:bookCode/pending-journals      列待審事件
//   GET  /B/:bookCode/pending-journals/:id  詳情
//   POST /B/:bookCode/pending-journals/:id/approve   核准 -> 寫進 journal_logs
//   POST /B/:bookCode/pending-journals/:id/reject    退回
//
// Auth: 第一版 /internal/posting 用 X-Posting-Token header (env SHARED_POSTING_TOKEN).
//       未設 token = development 模式接受所有 (僅內網用).
//       HMAC 簽章驗證留 M3 階段 1b.

'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth } = require('../auth');
const bookCode = require('../utils/bookCode');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

const SHARED_POSTING_TOKEN = process.env.SHARED_POSTING_TOKEN || null;

// ── helper: load book by code without requireAuth (for /internal/posting) ──
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

// ── helper: same loadBook with auth + role check (for review endpoints) ──
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

// ── helper: validate proposed_journal (subset of POST /journals validation) ──
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

// 寫 journal_logs (含帳戶餘額更新 + counterparty promote_count),共用 approve + auto_post.
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
      externalSource, externalId, isAuto,
      createdByUserId,
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

// ============================================================================
// POST /B/:bookCode/internal/posting
//
// Body:
//   external_source: string (required, e.g. "leo_invoice", "leo_pos", "inline")
//   external_id:     string (required, source-system unique id, used for idempotency)
//   event_id:        string (optional, source-system event uuid for webhook retry tracking)
//   payload:         object (optional, raw event payload for audit)
//   proposed_journal: { date, type, amount, subject_id, transfer_out_account_id?,
//                       transfer_in_account_id?, reclassify_from_subject_id?,
//                       counterparty_id?, summary?, note? }
//
// Auth: X-Posting-Token header must match env SHARED_POSTING_TOKEN (if set).
//
// Behavior:
//   - Idempotency: if (book, source, ext_id) already in journal_logs or pending_journals
//                  with status != rejected, return 200 with existing record (no double-write)
//   - book.posting_mode = 'auto'  -> insert journal_logs directly, return 201 { journal, mode: 'auto' }
//   - book.posting_mode = 'review' (default) -> insert pending_journals, return 202 { pending_journal, mode: 'review' }
//   - book.posting_mode = 'manual' -> 422 (refuse all auto posting)
// ============================================================================
router.post('/B/:bookCode/internal/posting', loadOpen, asyncHandler(async (req, res) => {
  // ── auth ──
  if (SHARED_POSTING_TOKEN) {
    const tok = req.headers['x-posting-token'];
    if (tok !== SHARED_POSTING_TOKEN) {
      return res.status(401).json({ error: 'invalid or missing X-Posting-Token' });
    }
  }
  // (if SHARED_POSTING_TOKEN not set, accept all — development / LAN-only)

  const b = req.body || {};
  const { external_source, external_id, event_id, payload, proposed_journal } = b;

  if (!external_source || typeof external_source !== 'string' || external_source.length > 30) {
    return res.status(400).json({ error: 'external_source required (string, max 30)' });
  }
  if (!external_id || typeof external_id !== 'string' || external_id.length > 100) {
    return res.status(400).json({ error: 'external_id required (string, max 100)' });
  }
  const vErr = validateProposedJournal(proposed_journal);
  if (vErr) return res.status(400).json({ error: vErr });

  // ── 冪等檢查: 已存在 journal_logs? ──
  const existJ = await query(
    `SELECT id FROM journal_logs WHERE book_id = $1 AND external_source = $2 AND external_id = $3`,
    [req.book.id, external_source, external_id]
  );
  if (existJ.rows.length > 0) {
    return res.status(200).json({ idempotent: true, journal_id: existJ.rows[0].id, status: 'already_posted' });
  }

  // ── 冪等檢查: 已存在 pending_journals? (含 pending / approved / rejected 都算 dup) ──
  const existP = await query(
    `SELECT id, status, resulting_journal_id FROM pending_journals
      WHERE book_id = $1 AND external_source = $2 AND external_id = $3`,
    [req.book.id, external_source, external_id]
  );
  if (existP.rows.length > 0) {
    const row = existP.rows[0];
    return res.status(200).json({
      idempotent: true,
      pending_journal_id: row.id,
      status: row.status,
      journal_id: row.resulting_journal_id,
    });
  }

  // ── 依 posting_mode 分支 ──
  const mode = req.book.posting_mode || 'review';
  if (mode === 'manual') {
    return res.status(422).json({ error: 'book in manual mode, auto posting disabled' });
  }

  if (mode === 'auto') {
    const journal = await withTransaction(async (client) => {
      // 也寫一筆 pending_journals (status=auto_posted) 做 audit trail
      const pj = await client.query(
        `INSERT INTO pending_journals (book_id, external_source, external_id, event_id, payload, proposed_journal, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'auto_posted') RETURNING id`,
        [req.book.id, external_source, external_id, event_id || null,
         JSON.stringify(payload || {}), JSON.stringify(proposed_journal)]
      );
      const j = await insertJournalFromProposed(
        client, req.book.id, proposed_journal,
        external_source, external_id, null, true
      );
      await client.query(
        `UPDATE pending_journals SET resulting_journal_id = $1, reviewed_at = NOW() WHERE id = $2`,
        [j.id, pj.rows[0].id]
      );
      return j;
    });
    return res.status(201).json({ mode: 'auto', journal });
  }

  // review mode (default)
  const pending = await query(
    `INSERT INTO pending_journals (book_id, external_source, external_id, event_id, payload, proposed_journal, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'pending') RETURNING *`,
    [req.book.id, external_source, external_id, event_id || null,
     JSON.stringify(payload || {}), JSON.stringify(proposed_journal)]
  );
  res.status(202).json({ mode: 'review', pending_journal: pending.rows[0] });
}));

// ============================================================================
// GET /B/:bookCode/pending-journals?status=pending
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
// POST /B/:bookCode/pending-journals/:id/approve
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
      if (pjRes.rows.length === 0) {
        throw Object.assign(new Error('pending journal not found'), { status: 404 });
      }
      const pj = pjRes.rows[0];
      if (pj.status !== 'pending') {
        throw Object.assign(new Error(`pending journal status is ${pj.status}, cannot approve`), { status: 409 });
      }
      const proposed = pj.proposed_journal;
      const vErr = validateProposedJournal(proposed);
      if (vErr) throw Object.assign(new Error(`proposed journal invalid: ${vErr}`), { status: 400 });

      const journal = await insertJournalFromProposed(
        client, req.book.id, proposed,
        pj.external_source, pj.external_id, req.user.id, true
      );

      await client.query(
        `UPDATE pending_journals
            SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(),
                review_note = $2, resulting_journal_id = $3, updated_at = NOW()
          WHERE id = $4`,
        [req.user.id, req.body.review_note || null, journal.id, id]
      );

      return { pending_id: id, journal };
    });

    res.json({ ok: true, ...result });
  })
);

// ============================================================================
// POST /B/:bookCode/pending-journals/:id/reject
// ============================================================================
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
      `UPDATE pending_journals
          SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(),
              review_note = $2, updated_at = NOW()
        WHERE id = $3`,
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
