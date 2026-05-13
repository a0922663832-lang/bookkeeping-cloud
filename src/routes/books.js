// src/routes/books.js
// Book CRUD + members.
//
// URL 結構依規格書 §2.3 多租戶設計:
//   GET    /books                          列我能進的所有 book
//   POST   /books                          建新帳本
//   GET    /B/:bookCode                    帳本詳情
//   PATCH  /B/:bookCode                    改帳本資料
//   GET    /B/:bookCode/members            列成員
//   POST   /B/:bookCode/members            加成員
//   PATCH  /B/:bookCode/members/:userId    改成員角色
//   DELETE /B/:bookCode/members/:userId    移除成員

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

// ── helper: load book by code + check membership ─────────────────────
async function loadBookMiddleware(req, res, next) {
  const code = (req.params.bookCode || '').toUpperCase();
  if (!bookCode.isValidFormat(code)) {
    return res.status(400).json({ error: 'invalid book code format' });
  }
  const result = await query(
    `SELECT b.*, bm.role AS my_role
       FROM books b
       JOIN book_members bm ON bm.book_id = b.id
      WHERE b.code = $1 AND bm.user_id = $2 AND b.is_active = TRUE`,
    [code, req.user.id]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'book not found or no access' });
  }
  const row = result.rows[0];
  req.book = row;
  req.bookMember = { role: row.my_role };
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

// ── GET /books ───────────────────────────────────────────────────────
router.get('/books', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT b.id, b.code, b.name, b.company_name, b.currency, b.subscription_type,
            bm.role, bm.joined_at, b.created_at
       FROM books b
       JOIN book_members bm ON bm.book_id = b.id
      WHERE bm.user_id = $1 AND b.is_active = TRUE
      ORDER BY b.created_at DESC`,
    [req.user.id]
  );
  res.json({ books: result.rows });
}));

// ── POST /books ──────────────────────────────────────────────────────
router.post('/books', asyncHandler(async (req, res) => {
  const { name, company_name, tax_id, currency, fiscal_year_start_month } = req.body || {};
  if (!name || name.length < 1 || name.length > 50) {
    return res.status(400).json({ error: 'name required (1-50 chars)' });
  }
  if (tax_id && !/^\d{8}$/.test(tax_id)) {
    return res.status(400).json({ error: 'tax_id must be 8 digits' });
  }
  const month = fiscal_year_start_month == null ? 1 : parseInt(fiscal_year_start_month, 10);
  if (!(month >= 1 && month <= 12)) {
    return res.status(400).json({ error: 'fiscal_year_start_month must be 1-12' });
  }

  // 產生 unique bookCode (重試最多 10 次)
  let code = null;
  for (let i = 0; i < 10; i++) {
    const candidate = bookCode.generate();
    const exists = await query('SELECT 1 FROM books WHERE code = $1', [candidate]);
    if (exists.rows.length === 0) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    return res.status(500).json({ error: 'failed to generate unique book code' });
  }

  const book = await withTransaction(async (client) => {
    const bookRes = await client.query(
      `INSERT INTO books
         (code, name, company_name, tax_id, currency, fiscal_year_start_month, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        code,
        name,
        company_name || null,
        tax_id || null,
        currency || 'TWD',
        month,
        req.user.id,
      ]
    );
    const b = bookRes.rows[0];
    await client.query(
      `INSERT INTO book_members (book_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [b.id, req.user.id]
    );
    return b;
  });

  res.status(201).json({ book });
}));

// ── GET /B/:bookCode ─────────────────────────────────────────────────
router.get('/B/:bookCode', loadBook, (req, res) => {
  const { my_role, ...book } = req.book;
  res.json({ book, my_role });
});

// ── PATCH /B/:bookCode ───────────────────────────────────────────────
router.patch(
  '/B/:bookCode',
  loadBook,
  requireBookRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const updates = [];
    const params = [];
    const allowed = ['name', 'company_name', 'tax_id', 'currency', 'fiscal_year_start_month', 'posting_mode'];
    for (const field of allowed) {
      if (req.body[field] === undefined) continue;
      if (field === 'posting_mode' && !['auto', 'review', 'manual'].includes(req.body[field])) {
        return res.status(400).json({ error: 'posting_mode must be auto / review / manual' });
      }
      updates.push(`${field} = $${params.length + 1}`);
      params.push(req.body[field]);
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'no updatable fields' });
    }
    updates.push(`updated_at = NOW()`);
    params.push(req.book.id);
    const result = await query(
      `UPDATE books SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    res.json({ book: result.rows[0] });
  })
);

// ── GET /B/:bookCode/members ─────────────────────────────────────────
router.get('/B/:bookCode/members', loadBook, asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT bm.id, bm.role, bm.joined_at,
            u.id AS user_id, u.email, u.name
       FROM book_members bm
       JOIN users u ON u.id = bm.user_id
      WHERE bm.book_id = $1
      ORDER BY
        CASE bm.role
          WHEN 'owner' THEN 1
          WHEN 'admin' THEN 2
          WHEN 'editor' THEN 3
          WHEN 'viewer' THEN 4
        END,
        bm.joined_at`,
    [req.book.id]
  );
  res.json({ members: result.rows });
}));

// ─── 成員管理 endpoints 410 Gone (2026-05-13, HR SSO plan) ────────────
// 成員加 / 改 / 踢全部由 LEO HR /attendance 的「記帳雲權限」dropdown 控制，
// login 時自動同步到 book_members。這裡保留路由但回 410 警示。

const MEMBERS_GONE_MSG = {
  error: '成員管理已搬到 LEO HR 系統 /attendance 頁 — 用「記帳雲權限」dropdown 設定',
  moved_to: `${process.env.HR_BASE_URL || 'http://10.0.1.168:3000'}/attendance`,
};

router.post('/B/:bookCode/members', (_req, res) => res.status(410).json(MEMBERS_GONE_MSG));
router.patch('/B/:bookCode/members/:userId', (_req, res) => res.status(410).json(MEMBERS_GONE_MSG));
router.delete('/B/:bookCode/members/:userId', (_req, res) => res.status(410).json(MEMBERS_GONE_MSG));

module.exports = router;
