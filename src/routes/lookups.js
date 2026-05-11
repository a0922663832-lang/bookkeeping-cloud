// src/routes/lookups.js
// 列出帳本內的 subjects / ag_accounts / counterparties (M1 階段 1a 只支援 list).
// CRUD 留 M1 階段 1b.

'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const bookCode = require('../utils/bookCode');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.use(requireAuth);

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

const loadBook = asyncHandler(loadBookMiddleware);

// ── GET /B/:bookCode/subjects ─────────────────────────────────────────
router.get('/B/:bookCode/subjects', loadBook, asyncHandler(async (req, res) => {
  const { parent_type, include_inactive } = req.query;
  const where = ['book_id = $1'];
  const params = [req.book.id];
  if (parent_type) {
    where.push(`parent_type = $${params.length + 1}`);
    params.push(parent_type);
  }
  if (!include_inactive) {
    where.push('is_active = TRUE');
  }
  const result = await query(
    `SELECT id, code, name, parent_type, parent_id, display_order, is_active, created_at
       FROM subjects
      WHERE ${where.join(' AND ')}
      ORDER BY parent_type, display_order, code, name`,
    params
  );
  res.json({ subjects: result.rows });
}));

// ── GET /B/:bookCode/accounts ─────────────────────────────────────────
router.get('/B/:bookCode/accounts', loadBook, asyncHandler(async (req, res) => {
  const { type, include_inactive } = req.query;
  const where = ['book_id = $1'];
  const params = [req.book.id];
  if (type) {
    where.push(`type = $${params.length + 1}`);
    params.push(type);
  }
  if (!include_inactive) {
    where.push('is_active = TRUE');
  }
  const result = await query(
    `SELECT id, name, type, linked_counterparty_id, display_order,
            initial_balance, current_balance, note, is_active, created_at
       FROM ag_accounts
      WHERE ${where.join(' AND ')}
      ORDER BY display_order, name`,
    params
  );
  res.json({ accounts: result.rows });
}));

// ── GET /B/:bookCode/counterparties ───────────────────────────────────
router.get('/B/:bookCode/counterparties', loadBook, asyncHandler(async (req, res) => {
  const { type, category, is_temporary, include_inactive } = req.query;
  const where = ['book_id = $1'];
  const params = [req.book.id];
  if (type) {
    where.push(`type = $${params.length + 1}`);
    params.push(type);
  }
  if (category) {
    where.push(`category = $${params.length + 1}`);
    params.push(category);
  }
  if (is_temporary !== undefined) {
    where.push(`is_temporary = $${params.length + 1}`);
    params.push(is_temporary === 'true' || is_temporary === '1');
  }
  if (!include_inactive) {
    where.push('is_active = TRUE');
  }
  const result = await query(
    `SELECT id, name, name_normalized, type, category, tax_id, contact,
            display_order, is_active, is_temporary, promote_count,
            auto_promote_threshold, promoted_at, created_at
       FROM counterparties
      WHERE ${where.join(' AND ')}
      ORDER BY display_order, name`,
    params
  );
  res.json({ counterparties: result.rows });
}));

module.exports = router;
