// src/routes/journals.js
// 記帳記錄 CRUD (M1 階段 1a).
// 規格書 §3.2.7. 支援 4 種 type: expense / income / transfer / reclassify.
// reclassify 1:N 映射 (訂金抵菜色+服務費) 是 v1.7 待補項,本階段先支援 1:1.

'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth } = require('../auth');
const bookCode = require('../utils/bookCode');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// auth required EXCEPT /internal/* (webhook endpoints use X-Posting-Token instead)
router.use((req, res, next) => {
  if (req.url.includes('/internal/')) return next();
  return requireAuth(req, res, next);
});

async function loadBookMiddleware(req, res, next) {
  const code = (req.params.bookCode || '').toUpperCase();
  if (!bookCode.isValidFormat(code)) {
    return res.status(400).json({ error: 'invalid book code format' });
  }
  const result = await query(
    `SELECT b.id, b.code, bm.role
       FROM books b
       JOIN book_members bm ON bm.book_id = b.id
      WHERE b.code = $1 AND bm.user_id = $2 AND b.is_active = TRUE`,
    [code, req.user.id]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'book not found or no access' });
  }
  req.book = { id: result.rows[0].id, code: result.rows[0].code };
  req.bookMember = { role: result.rows[0].role };
  next();
}

function requireBookRole(...roles) {
  return (req, res, next) => {
    if (!req.bookMember || !roles.includes(req.bookMember.role)) {
      return res.status(403).json({ error: `forbidden, requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

const loadBook = asyncHandler(loadBookMiddleware);

const SELECT_JOURNAL_WITH_JOINS = `
  SELECT j.*,
         s.name AS subject_name, s.code AS subject_code, s.parent_type AS subject_parent_type,
         sf.name AS reclassify_from_subject_name, sf.code AS reclassify_from_subject_code,
         cp.name AS counterparty_name,
         ao.name AS transfer_out_account_name,
         ai.name AS transfer_in_account_name
    FROM journal_logs j
    LEFT JOIN subjects s ON s.id = j.subject_id
    LEFT JOIN subjects sf ON sf.id = j.reclassify_from_subject_id
    LEFT JOIN counterparties cp ON cp.id = j.counterparty_id
    LEFT JOIN ag_accounts ao ON ao.id = j.transfer_out_account_id
    LEFT JOIN ag_accounts ai ON ai.id = j.transfer_in_account_id
`;

// ── POST /B/:bookCode/journals ─────────────────────────────────────────
// body: {
//   date,                            // YYYY-MM-DD
//   type,                            // expense / income / transfer / reclassify
//   amount,                          // > 0
//   subject_id,                      // (reclassify 時是 target)
//   reclassify_from_subject_id?,     // reclassify 必填
//   transfer_out_account_id?,        // expense / transfer 必填
//   transfer_in_account_id?,         // income / transfer 必填
//   counterparty_id?,
//   summary?, note?
// }
router.post(
  '/B/:bookCode/journals',
  loadBook,
  requireBookRole('owner', 'admin', 'editor'),
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const date = b.date;
    const type = b.type;
    const amount = Number(b.amount);
    const subjectId = b.subject_id;
    const reclassifyFromSubjectId = b.reclassify_from_subject_id || null;
    const outAccountId = b.transfer_out_account_id || null;
    const inAccountId = b.transfer_in_account_id || null;
    const counterpartyId = b.counterparty_id || null;

    // ── 基本驗證 ────────────────────────────────────────────────
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    }
    if (!['expense', 'income', 'transfer', 'reclassify'].includes(type)) {
      return res.status(400).json({ error: 'type must be expense / income / transfer / reclassify' });
    }
    if (!(amount > 0)) {
      return res.status(400).json({ error: 'amount must be > 0' });
    }
    if (!subjectId) {
      return res.status(400).json({ error: 'subject_id required' });
    }

    // ── type-specific 驗證 (DB CHECK constraint 也會擋,先在應用層擋 user friendly 訊息) ──
    if (type === 'expense') {
      if (!outAccountId) return res.status(400).json({ error: 'transfer_out_account_id required for expense' });
      if (inAccountId) return res.status(400).json({ error: 'transfer_in_account_id must be null for expense' });
      if (reclassifyFromSubjectId) return res.status(400).json({ error: 'reclassify_from_subject_id must be null for expense' });
    } else if (type === 'income') {
      if (!inAccountId) return res.status(400).json({ error: 'transfer_in_account_id required for income' });
      if (outAccountId) return res.status(400).json({ error: 'transfer_out_account_id must be null for income' });
      if (reclassifyFromSubjectId) return res.status(400).json({ error: 'reclassify_from_subject_id must be null for income' });
    } else if (type === 'transfer') {
      if (!outAccountId || !inAccountId) return res.status(400).json({ error: 'transfer_out_account_id and transfer_in_account_id both required for transfer' });
      if (outAccountId === inAccountId) return res.status(400).json({ error: 'transfer accounts must differ' });
      if (reclassifyFromSubjectId) return res.status(400).json({ error: 'reclassify_from_subject_id must be null for transfer' });
    } else if (type === 'reclassify') {
      if (outAccountId || inAccountId) return res.status(400).json({ error: 'transfer accounts must be null for reclassify' });
      if (!reclassifyFromSubjectId) return res.status(400).json({ error: 'reclassify_from_subject_id required for reclassify' });
      if (Number(reclassifyFromSubjectId) === Number(subjectId)) {
        return res.status(400).json({ error: 'reclassify_from_subject_id must differ from subject_id' });
      }
    }

    // ── 在 transaction 內 INSERT + 更新帳戶餘額 ──────────────────
    const result = await withTransaction(async (client) => {
      // 先驗 FK 都在同一 book (避免跨 book 引用).
      // 用 EXISTS + ::bigint cast 避免 pg "could not determine data type" 對 NULL parameter.
      const fkCheck = await client.query(
        `SELECT
           EXISTS (SELECT 1 FROM subjects WHERE id = $1::bigint AND book_id = $6::bigint) AS s_ok,
           ($2::bigint IS NULL OR EXISTS (SELECT 1 FROM subjects WHERE id = $2::bigint AND book_id = $6::bigint)) AS sf_ok,
           ($3::bigint IS NULL OR EXISTS (SELECT 1 FROM ag_accounts WHERE id = $3::bigint AND book_id = $6::bigint)) AS ao_ok,
           ($4::bigint IS NULL OR EXISTS (SELECT 1 FROM ag_accounts WHERE id = $4::bigint AND book_id = $6::bigint)) AS ai_ok,
           ($5::bigint IS NULL OR EXISTS (SELECT 1 FROM counterparties WHERE id = $5::bigint AND book_id = $6::bigint)) AS cp_ok`,
        [subjectId, reclassifyFromSubjectId, outAccountId, inAccountId, counterpartyId, req.book.id]
      );
      const fk = fkCheck.rows[0];
      if (!fk.s_ok) throw Object.assign(new Error('subject_id not in this book'), { status: 400 });
      if (!fk.sf_ok) throw Object.assign(new Error('reclassify_from_subject_id not in this book'), { status: 400 });
      if (!fk.ao_ok) throw Object.assign(new Error('transfer_out_account_id not in this book'), { status: 400 });
      if (!fk.ai_ok) throw Object.assign(new Error('transfer_in_account_id not in this book'), { status: 400 });
      if (!fk.cp_ok) throw Object.assign(new Error('counterparty_id not in this book'), { status: 400 });

      const insertRes = await client.query(
        `INSERT INTO journal_logs (
           book_id, date, type, amount,
           subject_id, reclassify_from_subject_id,
           transfer_out_account_id, transfer_in_account_id,
           counterparty_id, summary, note,
           created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
         RETURNING *`,
        [
          req.book.id, date, type, amount,
          subjectId, reclassifyFromSubjectId,
          outAccountId, inAccountId,
          counterpartyId, b.summary || null, b.note || null,
          req.user.id,
        ]
      );
      const journal = insertRes.rows[0];

      // 更新帳戶餘額 (reclassify 不動)
      if (type === 'expense' || type === 'transfer') {
        await client.query(
          `UPDATE ag_accounts SET current_balance = current_balance - $1, updated_at = NOW()
             WHERE id = $2 AND book_id = $3`,
          [amount, outAccountId, req.book.id]
        );
      }
      if (type === 'income' || type === 'transfer') {
        await client.query(
          `UPDATE ag_accounts SET current_balance = current_balance + $1, updated_at = NOW()
             WHERE id = $2 AND book_id = $3`,
          [amount, inAccountId, req.book.id]
        );
      }

      // counterparty promote_count + 1
      if (counterpartyId) {
        await client.query(
          `UPDATE counterparties SET promote_count = promote_count + 1, updated_at = NOW()
             WHERE id = $1 AND book_id = $2`,
          [counterpartyId, req.book.id]
        );
      }

      return journal;
    });

    res.status(201).json({ journal: result });
  })
);

// ── GET /B/:bookCode/journals?from=&to=&type=&subject_id=&counterparty_id=&account_id=&limit= ──
router.get('/B/:bookCode/journals', loadBook, asyncHandler(async (req, res) => {
  const { from, to, type, subject_id, counterparty_id, account_id } = req.query;
  const where = ['j.book_id = $1'];
  const params = [req.book.id];

  if (from) { where.push(`j.date >= $${params.length + 1}`); params.push(from); }
  if (to) { where.push(`j.date <= $${params.length + 1}`); params.push(to); }
  if (type) {
    if (!['expense', 'income', 'transfer', 'reclassify'].includes(type)) {
      return res.status(400).json({ error: 'invalid type filter' });
    }
    where.push(`j.type = $${params.length + 1}`);
    params.push(type);
  }
  if (subject_id) {
    where.push(`(j.subject_id = $${params.length + 1} OR j.reclassify_from_subject_id = $${params.length + 1})`);
    params.push(Number(subject_id));
  }
  if (counterparty_id) {
    where.push(`j.counterparty_id = $${params.length + 1}`);
    params.push(Number(counterparty_id));
  }
  if (account_id) {
    where.push(`(j.transfer_out_account_id = $${params.length + 1} OR j.transfer_in_account_id = $${params.length + 1})`);
    params.push(Number(account_id));
  }

  const lim = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);

  const result = await query(
    `${SELECT_JOURNAL_WITH_JOINS}
      WHERE ${where.join(' AND ')}
      ORDER BY j.date DESC, j.id DESC
      LIMIT ${lim}`,
    params
  );
  res.json({ journals: result.rows, count: result.rows.length });
}));

// ── GET /B/:bookCode/journals/:id ─────────────────────────────────────
router.get('/B/:bookCode/journals/:id', loadBook, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const result = await query(
    `${SELECT_JOURNAL_WITH_JOINS}
      WHERE j.book_id = $1 AND j.id = $2`,
    [req.book.id, id]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'journal not found' });
  }
  res.json({ journal: result.rows[0] });
}));

module.exports = router;

// 統一錯誤導向 (status 從 error.status 拿)
router.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
});
