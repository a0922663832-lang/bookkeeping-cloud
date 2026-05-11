// src/routes/lookups.js
// CRUD for subjects / ag_accounts / counterparties.
// M1 階段 1a: GET list. M1 階段 1b: POST + PATCH (含 is_active soft delete).
// 沒做 hard DELETE (用 PATCH is_active=false 達成 soft delete; 已記入 journal 的不能 hard delete).

'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth } = require('../auth');
const bookCode = require('../utils/bookCode');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.use(requireAuth);

const VALID_ACCOUNT_TYPES = [
  'cash', 'bank', 'digital_bank', 'time_deposit', 'investment',
  'income_account', 'liability', 'asset', 'virtual',
];
const VALID_SUBJECT_PARENT_TYPES = ['t1', 't2', 't3', 't4', 't5'];
const VALID_COUNTERPARTY_TYPES = ['income', 'expense', 'both'];

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

// ============================================================================
// SUBJECTS
// ============================================================================

router.get('/B/:bookCode/subjects', loadBook, asyncHandler(async (req, res) => {
  const { parent_type, include_inactive } = req.query;
  const where = ['book_id = $1'];
  const params = [req.book.id];
  if (parent_type) { where.push(`parent_type = $${params.length + 1}`); params.push(parent_type); }
  if (!include_inactive) where.push('is_active = TRUE');
  const result = await query(
    `SELECT id, code, name, parent_type, parent_id, display_order, is_active, created_at, updated_at
       FROM subjects WHERE ${where.join(' AND ')}
      ORDER BY parent_type, display_order, code, name`,
    params
  );
  res.json({ subjects: result.rows });
}));

router.post(
  '/B/:bookCode/subjects',
  loadBook,
  requireBookRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const { code, name, parent_type, parent_id, display_order } = req.body || {};
    if (!name || name.length < 1 || name.length > 50) {
      return res.status(400).json({ error: 'name required (1-50 chars)' });
    }
    if (!VALID_SUBJECT_PARENT_TYPES.includes(parent_type)) {
      return res.status(400).json({ error: `parent_type must be one of ${VALID_SUBJECT_PARENT_TYPES.join('/')}` });
    }
    if (code && (typeof code !== 'string' || code.length > 10)) {
      return res.status(400).json({ error: 'code must be string <= 10 chars' });
    }
    if (parent_id) {
      const p = await query('SELECT book_id FROM subjects WHERE id = $1', [parent_id]);
      if (p.rows.length === 0 || String(p.rows[0].book_id) !== String(req.book.id)) {
        return res.status(400).json({ error: 'parent_id not in this book' });
      }
    }
    const result = await query(
      `INSERT INTO subjects (book_id, code, name, parent_type, parent_id, display_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.book.id, code || null, name, parent_type, parent_id || null, display_order || 0]
    );
    res.status(201).json({ subject: result.rows[0] });
  })
);

router.patch(
  '/B/:bookCode/subjects/:id',
  loadBook,
  requireBookRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const existing = await query('SELECT * FROM subjects WHERE id = $1 AND book_id = $2', [id, req.book.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'subject not found' });

    const updates = [];
    const params = [];
    const allowed = ['code', 'name', 'parent_type', 'parent_id', 'display_order', 'is_active'];
    for (const f of allowed) {
      if (req.body[f] === undefined) continue;
      if (f === 'parent_type' && !VALID_SUBJECT_PARENT_TYPES.includes(req.body[f])) {
        return res.status(400).json({ error: `parent_type must be one of ${VALID_SUBJECT_PARENT_TYPES.join('/')}` });
      }
      if (f === 'parent_id' && req.body[f]) {
        const p = await query('SELECT book_id FROM subjects WHERE id = $1', [req.body[f]]);
        if (p.rows.length === 0 || String(p.rows[0].book_id) !== String(req.book.id)) {
          return res.status(400).json({ error: 'parent_id not in this book' });
        }
        if (Number(req.body[f]) === id) {
          return res.status(400).json({ error: 'parent_id cannot reference self' });
        }
      }
      updates.push(`${f} = $${params.length + 1}`);
      params.push(req.body[f] === '' ? null : req.body[f]);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'no updatable fields' });
    updates.push(`updated_at = NOW()`);
    params.push(id);
    const result = await query(
      `UPDATE subjects SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    res.json({ subject: result.rows[0] });
  })
);

// ============================================================================
// AG_ACCOUNTS
// ============================================================================

router.get('/B/:bookCode/accounts', loadBook, asyncHandler(async (req, res) => {
  const { type, include_inactive } = req.query;
  const where = ['book_id = $1'];
  const params = [req.book.id];
  if (type) { where.push(`type = $${params.length + 1}`); params.push(type); }
  if (!include_inactive) where.push('is_active = TRUE');
  const result = await query(
    `SELECT id, name, type, linked_counterparty_id, display_order,
            initial_balance, current_balance, note, is_active, created_at, updated_at
       FROM ag_accounts WHERE ${where.join(' AND ')}
      ORDER BY display_order, name`,
    params
  );
  res.json({ accounts: result.rows });
}));

router.post(
  '/B/:bookCode/accounts',
  loadBook,
  requireBookRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const { name, type, display_order, initial_balance, note, linked_counterparty_id } = req.body || {};
    if (!name || name.length < 1 || name.length > 50) {
      return res.status(400).json({ error: 'name required (1-50 chars)' });
    }
    if (!VALID_ACCOUNT_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of ${VALID_ACCOUNT_TYPES.join('/')}` });
    }
    if (linked_counterparty_id) {
      const c = await query('SELECT book_id FROM counterparties WHERE id = $1', [linked_counterparty_id]);
      if (c.rows.length === 0 || String(c.rows[0].book_id) !== String(req.book.id)) {
        return res.status(400).json({ error: 'linked_counterparty_id not in this book' });
      }
    }
    const initBal = initial_balance != null ? Number(initial_balance) : 0;
    if (!Number.isFinite(initBal)) {
      return res.status(400).json({ error: 'initial_balance must be a number' });
    }
    const result = await query(
      `INSERT INTO ag_accounts
         (book_id, name, type, linked_counterparty_id, display_order,
          initial_balance, current_balance, note)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7) RETURNING *`,
      [req.book.id, name, type, linked_counterparty_id || null, display_order || 0, initBal, note || null]
    );
    res.status(201).json({ account: result.rows[0] });
  })
);

router.patch(
  '/B/:bookCode/accounts/:id',
  loadBook,
  requireBookRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const existing = await query('SELECT * FROM ag_accounts WHERE id = $1 AND book_id = $2', [id, req.book.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'account not found' });

    // 注意: initial_balance / current_balance 不允許 PATCH (會破壞 journal_logs 累積的一致性)
    const updates = [];
    const params = [];
    const allowed = ['name', 'type', 'linked_counterparty_id', 'display_order', 'note', 'is_active'];
    for (const f of allowed) {
      if (req.body[f] === undefined) continue;
      if (f === 'type' && !VALID_ACCOUNT_TYPES.includes(req.body[f])) {
        return res.status(400).json({ error: `type must be one of ${VALID_ACCOUNT_TYPES.join('/')}` });
      }
      if (f === 'linked_counterparty_id' && req.body[f]) {
        const c = await query('SELECT book_id FROM counterparties WHERE id = $1', [req.body[f]]);
        if (c.rows.length === 0 || String(c.rows[0].book_id) !== String(req.book.id)) {
          return res.status(400).json({ error: 'linked_counterparty_id not in this book' });
        }
      }
      updates.push(`${f} = $${params.length + 1}`);
      params.push(req.body[f] === '' ? null : req.body[f]);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'no updatable fields' });
    updates.push(`updated_at = NOW()`);
    params.push(id);
    const result = await query(
      `UPDATE ag_accounts SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    res.json({ account: result.rows[0] });
  })
);

// ============================================================================
// COUNTERPARTIES
// ============================================================================

router.get('/B/:bookCode/counterparties', loadBook, asyncHandler(async (req, res) => {
  const { type, category, is_temporary, include_inactive } = req.query;
  const where = ['book_id = $1'];
  const params = [req.book.id];
  if (type) { where.push(`type = $${params.length + 1}`); params.push(type); }
  if (category) { where.push(`category = $${params.length + 1}`); params.push(category); }
  if (is_temporary !== undefined) {
    where.push(`is_temporary = $${params.length + 1}`);
    params.push(is_temporary === 'true' || is_temporary === '1');
  }
  if (!include_inactive) where.push('is_active = TRUE');
  const result = await query(
    `SELECT id, name, name_normalized, type, category, tax_id, contact,
            display_order, is_active, is_temporary, promote_count,
            auto_promote_threshold, promoted_at, created_at, updated_at
       FROM counterparties WHERE ${where.join(' AND ')}
      ORDER BY display_order, name`,
    params
  );
  res.json({ counterparties: result.rows });
}));

router.post(
  '/B/:bookCode/counterparties',
  loadBook,
  requireBookRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const { name, type, category, tax_id, contact, display_order, is_temporary, name_normalized } = b;
    if (!name || name.length < 1 || name.length > 100) {
      return res.status(400).json({ error: 'name required (1-100 chars)' });
    }
    if (!VALID_COUNTERPARTY_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of ${VALID_COUNTERPARTY_TYPES.join('/')}` });
    }
    if (tax_id && !/^\d{8}$/.test(tax_id)) {
      return res.status(400).json({ error: 'tax_id must be 8 digits' });
    }
    const result = await query(
      `INSERT INTO counterparties
         (book_id, name, name_normalized, type, category, tax_id, contact,
          display_order, is_temporary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        req.book.id, name, name_normalized || null, type,
        category || null, tax_id || null, contact || null,
        display_order || 0, is_temporary === true,
      ]
    );
    res.status(201).json({ counterparty: result.rows[0] });
  })
);

router.patch(
  '/B/:bookCode/counterparties/:id',
  loadBook,
  requireBookRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const existing = await query('SELECT * FROM counterparties WHERE id = $1 AND book_id = $2', [id, req.book.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'counterparty not found' });

    const updates = [];
    const params = [];
    const allowed = [
      'name', 'name_normalized', 'type', 'category', 'tax_id', 'contact',
      'display_order', 'is_active', 'is_temporary', 'auto_promote_threshold',
    ];
    for (const f of allowed) {
      if (req.body[f] === undefined) continue;
      if (f === 'type' && !VALID_COUNTERPARTY_TYPES.includes(req.body[f])) {
        return res.status(400).json({ error: `type must be one of ${VALID_COUNTERPARTY_TYPES.join('/')}` });
      }
      if (f === 'tax_id' && req.body[f] && !/^\d{8}$/.test(req.body[f])) {
        return res.status(400).json({ error: 'tax_id must be 8 digits' });
      }
      // 升級 (is_temporary: true -> false) 時自動填 promoted_at
      if (f === 'is_temporary' && existing.rows[0].is_temporary && req.body[f] === false) {
        updates.push(`promoted_at = NOW()`);
      }
      updates.push(`${f} = $${params.length + 1}`);
      params.push(req.body[f] === '' ? null : req.body[f]);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'no updatable fields' });
    updates.push(`updated_at = NOW()`);
    params.push(id);
    const result = await query(
      `UPDATE counterparties SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    res.json({ counterparty: result.rows[0] });
  })
);

module.exports = router;
