// src/routes/reconciliation.js
// 對帳中心 v1 API（記帳雲總計畫 Phase 0 / 紙測 F2/F3/F10）
//
// 使用者端（JWT）:
//   GET  /B/:bookCode/reconciliation?date=        — 三色結果（settled / in_transit / diff）
//   POST /B/:bookCode/reconciliation/run          — 手動補跑某日對帳 { date }
//   POST /B/:bookCode/reconciliation/repush       — 排補推 { external_source, external_id }
//
// LEO 端機器對機器（HMAC，免 JWT）:
//   GET  /internal/v1/repush-queue?book=          — 領取補推請求（requested → picked）
//   POST /internal/v1/repush-ack                  — 回報結果 { id, ok, note }

'use strict';

const crypto = require('crypto');
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const bookCode = require('../utils/bookCode');
const asyncHandler = require('../utils/asyncHandler');
const hmac = require('../utils/hmac');
const recon = require('../reconcileCron');

const router = express.Router();

// ── auth helpers（同 posting.js 模式）────────────────────────────────
async function loadBookAuth(req, res, next) {
  const code = (req.params.bookCode || '').toUpperCase();
  if (!bookCode.isValidFormat(code)) return res.status(400).json({ error: 'invalid book code format' });
  const result = await query(
    `SELECT b.id, b.code, bm.role
       FROM books b JOIN book_members bm ON bm.book_id = b.id
      WHERE b.code = $1 AND bm.user_id = $2 AND b.is_active = TRUE`,
    [code, req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'book not found or no access' });
  req.book = { id: result.rows[0].id, code: result.rows[0].code };
  req.bookMember = { role: result.rows[0].role };
  next();
}
const loadAuth = asyncHandler(loadBookAuth);

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.bookMember || !roles.includes(req.bookMember.role)) {
      return res.status(403).json({ error: `forbidden, requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

// GET 的 HMAC 驗證：簽名訊息 = "<ts>.<path+query>"（LEO 端 signedGet 對齊）
function verifySignedGet(req) {
  if (!hmac.isConfigured()) return { valid: true }; // dev mode bypass（同 verifyRequest 行為）
  const ts = req.headers['x-timestamp'];
  const sig = String(req.headers['x-signature'] || '').replace(/^sha256=/, '');
  if (!ts || !sig) return { valid: false, reason: 'missing signature headers' };
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > 5 * 60 * 1000) {
    return { valid: false, reason: 'timestamp out of window' };
  }
  const expected = hmac.computeSignature(ts, req.originalUrl);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'signature mismatch' };
  }
  return { valid: true };
}

// ── 使用者端 ─────────────────────────────────────────────────────────

router.get('/B/:bookCode/reconciliation', requireAuth, loadAuth, asyncHandler(async (req, res) => {
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

  const r = await query(
    `SELECT external_source, external_id, event_type, leo_amount, leo_status,
            cloud_status, bucket, detail, run_at
       FROM recon_results
      WHERE book_id = $1 AND recon_date = $2::date
      ORDER BY bucket, external_source, external_id`,
    [req.book.id, date]
  );

  const grouped = { settled: [], in_transit: [], diff: [] };
  let lastRunAt = null;
  for (const row of r.rows) {
    grouped[row.bucket].push(row);
    if (!lastRunAt || row.run_at > lastRunAt) lastRunAt = row.run_at;
  }

  // 補推請求現況（讓 UI 顯示「補推中」）
  const open = await query(
    `SELECT external_id, status FROM repush_requests
      WHERE book_id = $1 AND status IN ('requested', 'picked')`,
    [req.book.id]
  );

  res.json({
    date,
    last_run_at: lastRunAt,
    counts: { settled: grouped.settled.length, in_transit: grouped.in_transit.length, diff: grouped.diff.length },
    results: grouped,
    open_repush: open.rows,
  });
}));

router.post('/B/:bookCode/reconciliation/run',
  requireAuth, loadAuth, requireRole('owner', 'admin', 'editor'),
  asyncHandler(async (req, res) => {
    const date = String((req.body || {}).date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    try {
      const counts = await recon.runFor(req.book.code, date);
      res.json({ ok: true, date, counts });
    } catch (e) {
      res.status(502).json({ error: `對帳失敗：${e.message}（LEO 端可能離線）` });
    }
  }));

router.post('/B/:bookCode/reconciliation/repush',
  requireAuth, loadAuth, requireRole('owner', 'admin', 'editor'),
  asyncHandler(async (req, res) => {
    const { external_source, external_id } = req.body || {};
    if (!external_source || !external_id) {
      return res.status(400).json({ error: 'external_source and external_id required' });
    }
    try {
      const r = await query(
        `INSERT INTO repush_requests (book_id, external_source, external_id, requested_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [req.book.id, external_source, external_id, req.user.id]
      );
      res.json({ ok: true, repush_id: r.rows[0].id, note: 'LEO 端每 5 分鐘領取執行' });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: '這筆已經在補推佇列中了' });
      throw e;
    }
  }));

// ── LEO 端機器對機器（HMAC，免 JWT）──────────────────────────────────

router.get('/internal/v1/repush-queue', asyncHandler(async (req, res) => {
  const v = verifySignedGet(req);
  if (!v.valid) return res.status(401).json({ error: v.reason });

  const code = String(req.query.book || '').toUpperCase();
  const bookRes = await query(`SELECT id FROM books WHERE code = $1 AND is_active = TRUE`, [code]);
  if (bookRes.rows.length === 0) return res.status(404).json({ error: 'book not found' });

  const picked = await query(
    `UPDATE repush_requests SET status = 'picked', picked_at = NOW()
      WHERE id IN (
        SELECT id FROM repush_requests
         WHERE book_id = $1 AND status = 'requested'
         ORDER BY requested_at LIMIT 20)
      RETURNING id, external_source, external_id`,
    [bookRes.rows[0].id]
  );
  res.json({ items: picked.rows });
}));

router.post('/internal/v1/repush-ack', asyncHandler(async (req, res) => {
  const v = hmac.verifyRequest(req.headers, req.rawBody);
  if (!v.valid) return res.status(401).json({ error: v.reason });

  const { id, ok, note } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const r = await query(
    `UPDATE repush_requests
        SET status = $1, done_at = NOW(), result_note = $2
      WHERE id = $3 AND status = 'picked'
      RETURNING id`,
    [ok ? 'done' : 'failed', String(note || '').slice(0, 500), id]
  );
  if (r.rows.length === 0) return res.status(404).json({ error: 'repush request not found or not picked' });
  res.json({ ok: true });
}));

module.exports = router;
