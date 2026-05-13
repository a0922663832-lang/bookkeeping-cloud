// src/routes/posting.js
// M3 webhook + M5 composite journal + per-source posting_mode + triggered_by + invoices.
//
// Endpoints:
//   POST /B/:bookCode/internal/posting      Webhook entry (HMAC OR X-Posting-Token)
//   GET  /B/:bookCode/pending-journals      List pending review (JWT)
//   GET  /B/:bookCode/pending-journals/:id  Detail (JWT)
//   POST /B/:bookCode/pending-journals/:id/approve  (JWT, owner/admin)
//   POST /B/:bookCode/pending-journals/:id/reject   (JWT, owner/admin)

'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth } = require('../auth');
const bookCode = require('../utils/bookCode');
const asyncHandler = require('../utils/asyncHandler');
const hmac = require('../utils/hmac');

const router = express.Router();

const SHARED_POSTING_TOKEN = process.env.SHARED_POSTING_TOKEN || null;
const SYSTEM_BOT_USER_ID = 0;  // D21 / migration 010

// ── helpers ─────────────────────────────────────────────────────────
async function loadBookOpen(req, res, next) {
  const code = (req.params.bookCode || '').toUpperCase();
  if (!bookCode.isValidFormat(code)) return res.status(400).json({ error: 'invalid book code format' });
  const result = await query(
    `SELECT id, code, posting_mode, posting_mode_per_source FROM books WHERE code = $1 AND is_active = TRUE`,
    [code]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'book not found' });
  req.book = result.rows[0];
  next();
}

async function loadBookAuth(req, res, next) {
  const code = (req.params.bookCode || '').toUpperCase();
  if (!bookCode.isValidFormat(code)) return res.status(400).json({ error: 'invalid book code format' });
  const result = await query(
    `SELECT b.id, b.code, b.posting_mode, b.posting_mode_per_source, bm.role
       FROM books b JOIN book_members bm ON bm.book_id = b.id
      WHERE b.code = $1 AND bm.user_id = $2 AND b.is_active = TRUE`,
    [code, req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'book not found or no access' });
  req.book = {
    id: result.rows[0].id,
    code: result.rows[0].code,
    posting_mode: result.rows[0].posting_mode,
    posting_mode_per_source: result.rows[0].posting_mode_per_source,
  };
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

// ── N7：per-source per-event_type posting mode resolver ─────────────
function resolvePostingMode(book, source, eventType) {
  const cfg = book.posting_mode_per_source || {};
  const sourceVal = cfg[source];
  if (typeof sourceVal === 'string') return sourceVal;
  if (sourceVal && typeof sourceVal === 'object') {
    return sourceVal[eventType] || sourceVal._default || book.posting_mode;
  }
  return book.posting_mode || 'review';
}

// ── Q14：subject_code/account_ref resolvers (with legacy fallback) ──
async function resolveSubjectId(client, bookId, leg) {
  if (leg.subject_code) {
    const r = await client.query(
      `SELECT id FROM subjects WHERE book_id = $1 AND code = $2 AND is_active = TRUE`,
      [bookId, leg.subject_code]
    );
    if (r.rows.length === 0) throw new Error(`subject_code '${leg.subject_code}' not found in book`);
    return r.rows[0].id;
  }
  if (leg.subject_id) return Number(leg.subject_id);
  throw new Error('leg missing subject reference (need subject_code or subject_id)');
}

async function resolveAccountId(client, bookId, leg) {
  if (leg.account_ref) {
    const r = await client.query(
      `SELECT id FROM ag_accounts WHERE book_id = $1 AND name = $2 AND is_active = TRUE`,
      [bookId, leg.account_ref]
    );
    if (r.rows.length === 0) throw new Error(`account_ref '${leg.account_ref}' not found in book`);
    return r.rows[0].id;
  }
  if (leg.account_id) return Number(leg.account_id);
  throw new Error('leg missing account reference (need account_ref or account_id)');
}

// ── validators ──────────────────────────────────────────────────────
function validateProposedJournal(p) {
  if (!p || typeof p !== 'object') return 'proposed_journal required (object)';
  if (!p.date || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return 'proposed_journal.date (YYYY-MM-DD) required';
  if (!['expense', 'income', 'transfer', 'reclassify', 'composite'].includes(p.type)) {
    return 'proposed_journal.type invalid';
  }
  if (p.type === 'composite') return validateCompositePayload(p);
  if (!(Number(p.amount) > 0)) return 'proposed_journal.amount must be > 0';
  if (!p.subject_id && !p.subject_code) return 'proposed_journal.subject_id or subject_code required';
  if (p.type === 'expense' && !p.transfer_out_account_id && !p.transfer_out_account_ref) return 'expense requires transfer_out_account_id';
  if (p.type === 'income' && !p.transfer_in_account_id && !p.transfer_in_account_ref) return 'income requires transfer_in_account_id';
  if (p.type === 'transfer' && ((!p.transfer_out_account_id && !p.transfer_out_account_ref) || (!p.transfer_in_account_id && !p.transfer_in_account_ref))) return 'transfer requires both accounts';
  if (p.type === 'reclassify' && !p.reclassify_from_subject_id && !p.reclassify_from_subject_code) return 'reclassify requires reclassify_from_subject_id';
  return null;
}

function validateCompositePayload(p) {
  if (!Array.isArray(p.legs) || p.legs.length === 0) return 'composite requires legs[] (non-empty)';
  for (let i = 0; i < p.legs.length; i++) {
    const leg = p.legs[i];
    if (!leg || typeof leg !== 'object') return `legs[${i}] must be object`;
    if (!['subject', 'account'].includes(leg.kind)) return `legs[${i}].kind must be subject|account`;
    if (leg.kind === 'subject' && !leg.subject_code && !leg.subject_id) {
      return `legs[${i}] subject requires subject_code or subject_id`;
    }
    if (leg.kind === 'account' && !leg.account_ref && !leg.account_id) {
      return `legs[${i}] account requires account_ref or account_id`;
    }
    if (leg.amount === undefined || leg.amount === null || isNaN(Number(leg.amount))) {
      return `legs[${i}].amount must be number`;
    }
  }
  return null;
}

// ── Insert: legacy single-subject journal (expense/income/transfer/reclassify) ──
async function insertLegacyJournal(client, bookId, p, externalSource, externalId, createdByUserId, isAuto, triggeredByEmpId, webhookLogId) {
  // resolve string refs to ids
  let subjectId = p.subject_id;
  if (!subjectId && p.subject_code) {
    subjectId = await resolveSubjectId(client, bookId, { subject_code: p.subject_code });
  }
  let outAccountId = p.transfer_out_account_id;
  if (!outAccountId && p.transfer_out_account_ref) {
    outAccountId = await resolveAccountId(client, bookId, { account_ref: p.transfer_out_account_ref });
  }
  let inAccountId = p.transfer_in_account_id;
  if (!inAccountId && p.transfer_in_account_ref) {
    inAccountId = await resolveAccountId(client, bookId, { account_ref: p.transfer_in_account_ref });
  }
  let reclassifyFrom = p.reclassify_from_subject_id;
  if (!reclassifyFrom && p.reclassify_from_subject_code) {
    reclassifyFrom = await resolveSubjectId(client, bookId, { subject_code: p.reclassify_from_subject_code });
  }

  const insertRes = await client.query(
    `INSERT INTO journal_logs (
       book_id, date, type, amount,
       subject_id, reclassify_from_subject_id,
       transfer_out_account_id, transfer_in_account_id,
       counterparty_id, summary, note,
       external_source, external_id, is_auto_posted,
       triggered_by_external_emp_id, webhook_log_id,
       is_composite,
       created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, FALSE, $17, $17)
     RETURNING *`,
    [
      bookId, p.date, p.type, Number(p.amount),
      subjectId, reclassifyFrom || null,
      outAccountId || null, inAccountId || null,
      p.counterparty_id || null, p.summary || null, p.note || null,
      externalSource, externalId, isAuto,
      triggeredByEmpId || null, webhookLogId || null,
      createdByUserId,
    ]
  );
  const journal = insertRes.rows[0];
  const amt = Number(p.amount);
  if (p.type === 'expense' || p.type === 'transfer') {
    await client.query(
      `UPDATE ag_accounts SET current_balance = current_balance - $1, updated_at = NOW()
        WHERE id = $2 AND book_id = $3`,
      [amt, outAccountId, bookId]
    );
  }
  if (p.type === 'income' || p.type === 'transfer') {
    await client.query(
      `UPDATE ag_accounts SET current_balance = current_balance + $1, updated_at = NOW()
        WHERE id = $2 AND book_id = $3`,
      [amt, inAccountId, bookId]
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

// ── Insert: composite journal (N legs) ──────────────────────────────
async function insertCompositeJournal(client, bookId, p, externalSource, externalId, createdByUserId, isAuto, triggeredByEmpId, webhookLogId) {
  // resolve all leg refs
  const resolvedLegs = [];
  for (let i = 0; i < p.legs.length; i++) {
    const leg = p.legs[i];
    const resolved = {
      leg_no: leg.leg_no || (i + 1),
      kind: leg.kind,
      subject_id: null,
      account_id: null,
      amount: Number(leg.amount),
      note: leg.note || null,
    };
    if (leg.kind === 'subject') {
      resolved.subject_id = await resolveSubjectId(client, bookId, leg);
    } else {
      resolved.account_id = await resolveAccountId(client, bookId, leg);
    }
    resolvedLegs.push(resolved);
  }

  // 4.3.4 balance gap (allow non-zero; alert via app code if !=0)
  const accountSum = resolvedLegs.filter(l => l.kind === 'account').reduce((s, l) => s + l.amount, 0);
  const subjectSum = resolvedLegs.filter(l => l.kind === 'subject').reduce((s, l) => s + l.amount, 0);
  const balanceGap = accountSum - subjectSum;

  // primary subject_id for header (first subject leg, or fallback to first leg)
  const primarySubject = resolvedLegs.find(l => l.kind === 'subject');
  const primarySubjectId = primarySubject ? primarySubject.subject_id : null;

  // header amount: settled_net heuristic = sum of positive account legs (cash inflow); or 0 for pure reclassify
  const headerAmount = Math.max(0, accountSum);

  const journalRes = await client.query(
    `INSERT INTO journal_logs (
       book_id, date, type, amount,
       subject_id,
       summary, note,
       external_source, external_id, is_auto_posted,
       triggered_by_external_emp_id, webhook_log_id,
       is_composite,
       created_by, updated_by
     ) VALUES ($1, $2, 'composite', $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, $12, $12)
     RETURNING *`,
    [
      bookId, p.date, headerAmount,
      primarySubjectId,
      p.summary || null, p.note || null,
      externalSource, externalId, isAuto,
      triggeredByEmpId || null, webhookLogId || null,
      createdByUserId,
    ]
  );
  const journal = journalRes.rows[0];

  // insert legs + apply balance updates
  for (const leg of resolvedLegs) {
    await client.query(
      `INSERT INTO journal_legs (journal_log_id, leg_no, kind, subject_id, account_id, amount, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [journal.id, leg.leg_no, leg.kind, leg.subject_id, leg.account_id, leg.amount, leg.note]
    );
    if (leg.kind === 'account') {
      await client.query(
        `UPDATE ag_accounts SET current_balance = current_balance + $1, updated_at = NOW()
          WHERE id = $2 AND book_id = $3`,
        [leg.amount, leg.account_id, bookId]
      );
    }
    // subject legs: SQL no balance update (reports compute via journal_legs GROUP BY)
  }

  return { journal, balance_gap: balanceGap };
}

// ── Insert dispatcher ───────────────────────────────────────────────
async function insertJournalFromProposed(client, bookId, p, externalSource, externalId, createdByUserId, isAuto, triggeredByEmpId, webhookLogId) {
  if (p.type === 'composite') {
    return insertCompositeJournal(client, bookId, p, externalSource, externalId, createdByUserId, isAuto, triggeredByEmpId, webhookLogId);
  }
  const journal = await insertLegacyJournal(client, bookId, p, externalSource, externalId, createdByUserId, isAuto, triggeredByEmpId, webhookLogId);
  return { journal, balance_gap: null };
}

// ── D25: invoices writer ────────────────────────────────────────────
async function writeInvoices(client, bookId, journalLogId, invoices) {
  if (!Array.isArray(invoices) || invoices.length === 0) return;
  for (const inv of invoices) {
    await client.query(
      `INSERT INTO invoices (book_id, journal_log_id, external_order_id, external_source,
                              invoice_number, invoice_period, amount, customer_tax_id, is_void)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        bookId, journalLogId,
        inv.external_order_id ? String(inv.external_order_id) : null,
        inv.external_source || 'leo_pos',
        inv.invoice_number || null,
        inv.invoice_period || null,
        Number(inv.amount) || 0,
        inv.customer_tax_id || null,
        !!inv.is_void,
      ]
    );
  }
}

// ── webhook log helper (returns log id for FK) ──────────────────────
async function logWebhookInbound(req, bookId, hmacValid, status, responseBody) {
  try {
    const r = await query(
      `INSERT INTO webhook_logs_inbound
         (book_id, external_source, event_id, request_path, request_headers,
          request_body, response_status, response_body, hmac_valid, client_ip)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10)
       RETURNING id`,
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
    return r.rows[0]?.id || null;
  } catch (e) {
    console.error('[webhook-log] failed:', e.message);
    return null;
  }
}

// ============================================================================
// POST /B/:bookCode/internal/posting
// ============================================================================
router.post('/B/:bookCode/internal/posting', loadOpen, asyncHandler(async (req, res) => {
  // auth
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

  const b = req.body || {};
  const { external_source, external_id, event_id, event_type, payload, proposed_journal, triggered_by_emp_id, invoices } = b;
  const triggeredEmpId = triggered_by_emp_id || (payload && payload.triggered_by_emp_id) || null;

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

  // idempotency
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

  // N7：resolve posting mode per source per event_type
  const mode = resolvePostingMode(req.book, external_source, event_type);

  if (mode === 'manual') {
    const body = { error: 'book in manual mode for this source/event, auto posting disabled' };
    await logWebhookInbound(req, req.book.id, hmacValid, 422, body);
    return res.status(422).json(body);
  }

  if (mode === 'auto') {
    const result = await withTransaction(async (client) => {
      const webhookLogId = await logWebhookInbound(req, req.book.id, hmacValid, 0, { in_progress: true });

      const pj = await client.query(
        `INSERT INTO pending_journals (book_id, external_source, external_id, event_id, payload, proposed_journal, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'auto_posted') RETURNING id`,
        [req.book.id, external_source, external_id, event_id || null,
         JSON.stringify(payload || {}), JSON.stringify(proposed_journal)]
      );

      const inserted = await insertJournalFromProposed(
        client, req.book.id, proposed_journal,
        external_source, external_id, SYSTEM_BOT_USER_ID, true, triggeredEmpId, webhookLogId
      );

      await client.query(
        `UPDATE pending_journals SET resulting_journal_id = $1, reviewed_at = NOW() WHERE id = $2`,
        [inserted.journal.id, pj.rows[0].id]
      );

      // D25: write invoices if any
      if (Array.isArray(invoices) && invoices.length > 0) {
        await writeInvoices(client, req.book.id, inserted.journal.id, invoices);
      } else if (payload && Array.isArray(payload.invoices) && payload.invoices.length > 0) {
        await writeInvoices(client, req.book.id, inserted.journal.id, payload.invoices);
      }

      return { journal: inserted.journal, balance_gap: inserted.balance_gap, webhookLogId };
    });

    const body = {
      status: 'posted',
      mode: 'auto',
      journal_id: result.journal.id,
      balance_gap: result.balance_gap,
      balance_gap_warning: result.balance_gap !== null && Math.abs(result.balance_gap) > 0.005,
    };
    return res.status(201).json(body);
  }

  // review mode
  const pendingRes = await query(
    `INSERT INTO pending_journals (book_id, external_source, external_id, event_id, payload, proposed_journal, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'pending') RETURNING *`,
    [req.book.id, external_source, external_id, event_id || null,
     JSON.stringify(payload || {}), JSON.stringify(proposed_journal)]
  );
  const body = { mode: 'review', status: 'pending', pending_journal: pendingRes.rows[0] };
  await logWebhookInbound(req, req.book.id, hmacValid, 202, { pending_id: pendingRes.rows[0].id, mode: 'review' });
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
  if (req.query.external_source) {
    where.push(`external_source = $${params.length + 1}`);
    params.push(req.query.external_source);
  }
  const result = await query(
    `SELECT pj.*,
            au.name AS approved_by_name,
            ru.name AS rejected_by_name
       FROM pending_journals pj
       LEFT JOIN users au ON au.id = pj.approved_by_user_id
       LEFT JOIN users ru ON ru.id = pj.rejected_by_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY pj.created_at DESC LIMIT 200`,
    params
  );
  res.json({ pending_journals: result.rows, count: result.rows.length });
}));

router.get('/B/:bookCode/pending-journals/:id', requireAuth, loadAuth, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  const result = await query(
    `SELECT pj.*,
            au.name AS approved_by_name,
            ru.name AS rejected_by_name
       FROM pending_journals pj
       LEFT JOIN users au ON au.id = pj.approved_by_user_id
       LEFT JOIN users ru ON ru.id = pj.rejected_by_user_id
      WHERE pj.id = $1 AND pj.book_id = $2`,
    [id, req.book.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'pending journal not found' });
  res.json({ pending_journal: result.rows[0] });
}));

// ============================================================================
// POST approve / reject (S7 audit trail)
// ============================================================================
router.post(
  '/B/:bookCode/pending-journals/:id/approve',
  requireAuth, loadAuth, requireRole('owner', 'admin', 'editor'),
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
      if (pj.status !== 'pending') throw Object.assign(new Error(`status is ${pj.status}, cannot approve`), { status: 409 });

      const proposed = pj.proposed_journal;
      const vErr = validateProposedJournal(proposed);
      if (vErr) throw Object.assign(new Error(`proposed journal invalid: ${vErr}`), { status: 400 });

      const triggeredEmpId = pj.payload?.triggered_by_emp_id || null;
      const inserted = await insertJournalFromProposed(
        client, req.book.id, proposed,
        pj.external_source, pj.external_id, req.user.id, true, triggeredEmpId, null
      );
      await client.query(
        `UPDATE pending_journals
            SET status = 'approved',
                reviewed_by = $1, reviewed_at = NOW(),
                approved_by_user_id = $1, approved_at = NOW(),
                review_note = $2, resulting_journal_id = $3, updated_at = NOW()
          WHERE id = $4`,
        [req.user.id, req.body.review_note || null, inserted.journal.id, id]
      );

      // invoices from payload
      const invs = pj.payload?.invoices;
      if (Array.isArray(invs) && invs.length > 0) {
        await writeInvoices(client, req.book.id, inserted.journal.id, invs);
      }

      return { pending_id: id, journal: inserted.journal, balance_gap: inserted.balance_gap };
    });

    res.json({ ok: true, ...result });
  })
);

router.post(
  '/B/:bookCode/pending-journals/:id/reject',
  requireAuth, loadAuth, requireRole('owner', 'admin', 'editor'),
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
    const reason = req.body?.rejected_reason || req.body?.review_note || null;
    await query(
      `UPDATE pending_journals
          SET status = 'rejected',
              reviewed_by = $1, reviewed_at = NOW(),
              rejected_by_user_id = $1, rejected_at = NOW(),
              rejected_reason = $2,
              review_note = $2,
              updated_at = NOW()
        WHERE id = $3`,
      [req.user.id, reason, id]
    );
    res.json({ ok: true, pending_id: id, status: 'rejected' });
  })
);

router.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
});

// Export helpers for journals.js (reverse path reuses these)
module.exports = router;
module.exports.helpers = {
  insertJournalFromProposed,
  insertCompositeJournal,
  insertLegacyJournal,
  resolveSubjectId,
  resolveAccountId,
  writeInvoices,
  SYSTEM_BOT_USER_ID,
};
