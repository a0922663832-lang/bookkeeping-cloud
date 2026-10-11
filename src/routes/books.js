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
const { helpers: postingHelpers } = require('./posting');

const { toYmd, isRealDate, taipeiToday } = postingHelpers;

const router = express.Router();

// auth required EXCEPT /internal/*(webhook / 對帳端點用簽章,不用登入)
// B9:用路徑開頭判斷,不用 req.url.includes(query string 帶 /internal/ 會被當成免登入)。
//   注意對帳的 /internal/v1/* 不在 /B/ 底下,兩種都要放行。
function isInternalPath(p) {
  return typeof p === 'string' && (p.startsWith('/internal/') || /^\/B\/[^/]+\/internal\//.test(p));
}
router.use((req, res, next) => {
  if (isInternalPath(req.path)) return next();
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
    return res.status(404).json({ error: '找不到這本帳,或你沒有權限看' });
  }
  const row = result.rows[0];
  req.book = row;
  req.bookMember = { role: row.my_role };
  next();
}

const ROLE_ZH = { owner: '老闆', admin: '管理員', editor: '記帳員', viewer: '唯讀' };

function requireBookRole(...roles) {
  return (req, res, next) => {
    if (!req.bookMember || !roles.includes(req.bookMember.role)) {
      return res.status(403).json({ error: `你的角色不能做這個(需要${roles.map((r) => ROLE_ZH[r] || r).join(' / ')})` });
    }
    next();
  };
}

const loadBook = asyncHandler(loadBookMiddleware);

// ── 帳本欄位驗證(2026-10-10 記帳雲重掃 G2 / Y45 / Y53)─────────────────────────
// 以前 PATCH 完全沒驗:統編 8 個非數字字元照收、太長回 500 + 資料庫原文;幣別、名稱長度沒驗。
const MAIN_BOOK_CODE = process.env.HR_DEFAULT_BOOK_CODE || 'NEST0001';
const VALID_CURRENCIES = ['TWD', 'USD', 'JPY', 'CNY', 'HKD', 'EUR'];

/** 驗一個欄位;回 { value } 或 { error }(白話) */
function checkBookField(field, v) {
  switch (field) {
    case 'name': {
      if (typeof v !== 'string' || !v.trim()) return { error: '帳本名稱必填' };
      if (v.trim().length > 50) return { error: '帳本名稱最多 50 個字' };
      return { value: v.trim() };
    }
    case 'company_name': {
      if (v === null || v === '') return { value: null };
      if (typeof v !== 'string') return { error: '公司名稱格式不對' };
      if (v.trim().length > 100) return { error: '公司名稱最多 100 個字' };
      return { value: v.trim() || null };
    }
    case 'tax_id': {
      if (v === null || v === '') return { value: null };
      if (typeof v !== 'string' || !/^\d{8}$/.test(v.trim())) return { error: '統一編號要是 8 位數字' };
      return { value: v.trim() };
    }
    case 'currency': {
      if (typeof v !== 'string' || !VALID_CURRENCIES.includes(v.trim().toUpperCase())) {
        return { error: `幣別只能選 ${VALID_CURRENCIES.join(' / ')}` };
      }
      return { value: v.trim().toUpperCase() };
    }
    case 'fiscal_year_start_month': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (!Number.isInteger(n) || n < 1 || n > 12) return { error: '會計年度起始月要是 1 到 12' };
      return { value: n };
    }
    case 'posting_mode': {
      if (!['auto', 'review', 'manual'].includes(v)) return { error: '記帳模式只能是:直接入帳 / 進待審 / 拒收' };
      return { value: v };
    }
    default:
      return { error: '不能改這個欄位' };
  }
}

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
// Y53:以前任何登入的人(含唯讀)都能開新帳本並自動變成 owner,新帳本也沒有預設科目(要等下次重啟才補)。
// 現在只有主帳本(NEST0001)的老闆能開;建完當場補預設科目 / 帳戶。
router.post('/books', asyncHandler(async (req, res) => {
  const ownerCheck = await query(
    `SELECT 1 FROM book_members bm JOIN books b ON b.id = bm.book_id
      WHERE b.code = $1 AND b.is_active = TRUE AND bm.user_id = $2 AND bm.role = 'owner'`,
    [MAIN_BOOK_CODE, req.user.id]
  );
  if (ownerCheck.rows.length === 0) {
    return res.status(403).json({ error: '只有老闆能開新帳本' });
  }

  const b0 = req.body || {};
  const fields = {
    name: b0.name,
    company_name: b0.company_name == null ? null : b0.company_name,
    tax_id: b0.tax_id == null ? null : b0.tax_id,
    currency: b0.currency == null || b0.currency === '' ? 'TWD' : b0.currency,
    fiscal_year_start_month: b0.fiscal_year_start_month == null || b0.fiscal_year_start_month === '' ? 1 : b0.fiscal_year_start_month,
  };
  const clean = {};
  for (const [f, v] of Object.entries(fields)) {
    const c = checkBookField(f, v);
    if (c.error) return res.status(400).json({ error: c.error });
    clean[f] = c.value;
  }
  const { name, company_name, tax_id, currency } = clean;
  const month = clean.fiscal_year_start_month;

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
    return res.status(500).json({ error: '帳本代碼產生失敗,請再按一次' });
  }
  // 預設科目 / 帳戶的種子函式(收尾會從 server.js 搬到 src/seedDefaults.js,匯出 { seedDefaultsForBook(client, bookId) })。
  // 用到時才載入:檔案還沒到位也不會讓整個記帳雲開不了機,只有「開新帳本」這個動作會失敗並說明。
  let seedDefaultsForBook;
  try {
    ({ seedDefaultsForBook } = require('../seedDefaults'));
  } catch (e) {
    console.error('[books] 載入 seedDefaults 失敗:', e.message);
  }
  if (typeof seedDefaultsForBook !== 'function') {
    return res.status(503).json({ error: '開新帳本的功能還沒準備好(缺預設科目),請告訴技術' });
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
        currency,
        month,
        req.user.id,
      ]
    );
    const b = bookRes.rows[0];
    await client.query(
      `INSERT INTO book_members (book_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [b.id, req.user.id]
    );
    await seedDefaultsForBook(client, b.id);   // 同一個 transaction:種子失敗整本不建
    return b;
  });

  res.status(201).json({ book });
}));

// ── 關帳(第二輪 §4.8 / Y26,migration 018 books.closed_through)────────────
// DATE 欄位 pg 會解析成 Date,JSON 出去變成 ISO 時間(台北時區還會倒退一天)→ 一律轉成 'YYYY-MM-DD'。
function bookOut(row) {
  if (!row) return row;
  const out = { ...row };
  if ('closed_through' in out) out.closed_through = toYmd(out.closed_through);
  return out;
}

/** 驗 closed_through:null / '' = 解除關帳;否則要是真日期、不能晚於今天(台北)。回 { value } 或 { error } */
function checkClosedThrough(v) {
  if (v === null || v === '') return { value: null };
  if (typeof v !== 'string' || !isRealDate(v.trim())) return { error: '關帳日期不正確' };
  const d = v.trim();
  if (d > taipeiToday()) return { error: '關帳日不能晚於今天' };
  return { value: d };
}

// ── GET /B/:bookCode ─────────────────────────────────────────────────
router.get('/B/:bookCode', loadBook, (req, res) => {
  const { my_role, ...book } = req.book;
  res.json({ book: bookOut(book), my_role });
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
    const body = req.body || {};
    // 關帳日(§4.8):只有老闆能設、改小(往前解鎖)、清空;管理員也不行
    let closedChange;   // undefined = 沒動;null = 解除;'YYYY-MM-DD'
    if (body.closed_through !== undefined) {
      if (req.bookMember.role !== 'owner') {
        return res.status(403).json({ error: '只有老闆能設定或解除關帳' });
      }
      const c = checkClosedThrough(body.closed_through);
      if (c.error) return res.status(400).json({ error: c.error });
      closedChange = c.value;
    }
    for (const field of allowed) {
      if (body[field] === undefined) continue;
      const c = checkBookField(field, body[field]);
      if (c.error) return res.status(400).json({ error: c.error });
      updates.push(`${field} = $${params.length + 1}`);
      params.push(c.value);
    }
    if (closedChange !== undefined) {
      updates.push(`closed_through = $${params.length + 1}::date`);
      params.push(closedChange);
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: '沒有要改的欄位' });
    }
    updates.push(`updated_at = NOW()`);
    params.push(req.book.id);
    const result = await query(
      `UPDATE books SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (closedChange !== undefined) {
      const before = toYmd(req.book.closed_through);
      console.log(`[books] ${req.book.code} 關帳到 ${closedChange || '(無,已解除)'} by user ${req.user.id}`
        + `(原本 ${before || '沒關帳'})`);
    }
    res.json({ book: bookOut(result.rows[0]) });
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
module.exports._internals = { checkBookField };
