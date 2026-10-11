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
  // 沒設密鑰:只有本機開發明確開 HMAC_ALLOW_UNSIGNED=1 才放行(同 verifyRequest;主 repo 包 16 B1)
  if (!hmac.isConfigured()) {
    return hmac.allowUnsigned() ? { valid: true } : { valid: false, reason: hmac.NOT_CONFIGURED_REASON };
  }
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

// 補推被領走(picked)超過這麼久還沒回報 → 當作現場沒做成,放回佇列讓人能再按(Y34)
const PICKED_TIMEOUT_MINUTES = 30;

async function releaseStalePicked() {
  await query(
    `UPDATE repush_requests SET status = 'requested', picked_at = NULL
      WHERE status = 'picked' AND picked_at < NOW() - ($1::int * INTERVAL '1 minute')`,
    [PICKED_TIMEOUT_MINUTES]
  );
}

// 對帳只接現場系統那一本帳(Y35)
function isReconBook(code) {
  const hrBook = String(process.env.HR_DEFAULT_BOOK_CODE || 'NEST0001').toUpperCase();
  return code === hrBook || code === String(recon.RECON_BOOK_CODE || '').toUpperCase();
}

router.get('/B/:bookCode/reconciliation', requireAuth, loadAuth, asyncHandler(async (req, res) => {
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '請給日期（年-月-日）' });
  const includeStale = req.query.include_stale === '1' || req.query.include_stale === 'true';

  await releaseStalePicked();

  const r = await query(
    `SELECT external_source, external_id, event_type, leo_amount, leo_status,
            cloud_status, bucket, detail, run_at
       FROM recon_results
      WHERE book_id = $1 AND recon_date = $2::date AND external_source <> '_run'
        AND ($3::boolean OR cloud_status <> 'stale')
      ORDER BY bucket, external_source, external_id`,
    [req.book.id, date, includeStale]
  );

  // 補推請求現況（讓 UI 顯示「補推中」）
  const open = await query(
    `SELECT external_id, status, requested_at, picked_at FROM repush_requests
      WHERE book_id = $1 AND status IN ('requested', 'picked')`,
    [req.book.id]
  );
  const openIds = new Set(open.rows.map(o => o.external_id));

  const grouped = { settled: [], in_transit: [], diff: [] };
  let lastRunAt = null;
  let staleCount = 0;
  for (const row of r.rows) {
    if (row.cloud_status === 'stale') { staleCount++; }
    // can_repush:真的是「現場已送出但帳本沒有 / 推送失敗」才給補送,而且沒有進行中的補送
    row.can_repush = !openIds.has(row.external_id) && row.cloud_status !== 'stale'
      && typeof row.detail === 'string' && row.detail.includes('可補推');
    grouped[row.bucket].push(row);
    if (!lastRunAt || row.run_at > lastRunAt) lastRunAt = row.run_at;
  }

  // 這天有沒有真的跑過(Y32):有結果列、或有「跑成」紀錄 → ran;只有「沒跑成」紀錄 → 沒跑
  const runRow = await query(
    `SELECT cloud_status, detail, run_at FROM recon_results
      WHERE book_id = $1 AND recon_date = $2::date AND external_source = '_run' AND external_id = 'daily'`,
    [req.book.id, date]
  );
  const lastRun = runRow.rows[0] || null;
  const ran = r.rows.length > 0 || (lastRun !== null && lastRun.cloud_status === 'ok');
  if (lastRun && (!lastRunAt || lastRun.run_at > lastRunAt)) lastRunAt = lastRun.run_at;
  const failed = lastRun !== null && lastRun.cloud_status === 'failed';

  res.json({
    date,
    ran: failed ? false : ran,
    run_error: failed ? '對帳沒跑成，會在下一次自動重試（也可以按「立刻重新對帳」）' : null,
    last_run_at: lastRunAt,
    counts: { settled: grouped.settled.length - staleCount, in_transit: grouped.in_transit.length, diff: grouped.diff.length },
    results: grouped,
    open_repush: open.rows.map(o => ({ ...o, can_repush: false })),
  });
}));

router.post('/B/:bookCode/reconciliation/run',
  requireAuth, loadAuth, requireRole('owner', 'admin', 'editor'),
  asyncHandler(async (req, res) => {
    const date = String((req.body || {}).date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '請給日期（年-月-日）' });
    if (!isReconBook(req.book.code)) {
      return res.status(400).json({ error: '這個帳本沒有接現場系統' });
    }
    try {
      const counts = await recon.runFor(req.book.code, date);
      res.json({ ok: true, ran: true, date, counts });
    } catch (e) {
      console.error('[recon] manual run failed:', e.message);
      res.status(502).json({ ran: false, error: '對帳沒跑成，會在下一次自動重試（現場系統可能連不上）' });
    }
  }));

router.post('/B/:bookCode/reconciliation/repush',
  requireAuth, loadAuth, requireRole('owner', 'admin', 'editor'),
  asyncHandler(async (req, res) => {
    const { external_source, external_id } = req.body || {};
    if (!external_source || !external_id) {
      return res.status(400).json({ error: '缺少要補送的單據資料' });
    }
    try {
      const r = await query(
        `INSERT INTO repush_requests (book_id, external_source, external_id, requested_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [req.book.id, external_source, external_id, req.user.id]
      );
      res.json({ ok: true, repush_id: r.rows[0].id, note: '現場系統每 5 分鐘領取執行' });
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

  await releaseStalePicked();   // 領走超過 30 分鐘沒回報的,先放回佇列,這次一起重新領
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

// Phase 2 (R3 + 狀態機補完)：LEO 端輪詢詢問一批 external_id 的最終狀態
// 回 posted（含雲端最終科目，老闆若審核後改過科目以雲端為準）/ pending / rejected（含原因）
// / reversed（已沖銷）/ missing
router.post('/internal/v1/status-check', asyncHandler(async (req, res) => {
  const v = hmac.verifyRequest(req.headers, req.rawBody || '', req.method, req.path);
  if (!v.valid) return res.status(401).json({ error: v.reason });

  const { book, external_source, external_ids } = req.body || {};
  if (!book || !external_source || !Array.isArray(external_ids) || external_ids.length === 0) {
    return res.status(400).json({ error: 'book, external_source, external_ids[] required' });
  }
  if (external_ids.length > 100) {
    return res.status(400).json({ error: 'max 100 external_ids per call' });
  }
  const bookRes = await query(
    `SELECT id FROM books WHERE code = $1 AND is_active = TRUE`,
    [String(book).toUpperCase()]
  );
  if (bookRes.rows.length === 0) return res.status(404).json({ error: 'book not found' });
  const bookId = bookRes.rows[0].id;

  const results = [];
  for (const extId of external_ids) {
    const j = await query(
      `SELECT j.id, j.reversed_by_id, j.created_at, s.code AS subject_code
         FROM journal_logs j
         LEFT JOIN subjects s ON s.id = j.subject_id
        WHERE j.book_id = $1 AND j.external_source = $2 AND j.external_id = $3`,
      [bookId, external_source, extId]
    );
    if (j.rows.length > 0) {
      const row = j.rows[0];
      results.push({
        external_id: extId,
        status: row.reversed_by_id ? 'reversed' : 'posted',
        journal_id: row.id,
        subject_code: row.subject_code || null,
        posted_at: row.created_at,
      });
      continue;
    }
    const pj = await query(
      `SELECT id, status, review_note FROM pending_journals
        WHERE book_id = $1 AND external_source = $2 AND external_id = $3
        ORDER BY id DESC LIMIT 1`,
      [bookId, external_source, extId]
    );
    if (pj.rows.length > 0) {
      const row = pj.rows[0];
      results.push({
        external_id: extId,
        status: row.status === 'rejected' ? 'rejected' : 'pending',
        reject_reason: row.status === 'rejected' ? (row.review_note || null) : null,
      });
      continue;
    }
    results.push({ external_id: extId, status: 'missing' });
  }
  res.json({ results });
}));

router.post('/internal/v1/repush-ack', asyncHandler(async (req, res) => {
  const v = hmac.verifyRequest(req.headers, req.rawBody || '', req.method, req.path);
  if (!v.valid) return res.status(401).json({ error: v.reason });

  const { id, ok, note } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const r = await query(
    `UPDATE repush_requests
        SET status = $1, done_at = NOW(), result_note = $2
      WHERE id = $3 AND status = 'picked'
      RETURNING id, book_id, external_source, external_id`,
    [ok ? 'done' : 'failed', String(note || '').slice(0, 500), id]
  );
  if (r.rows.length === 0) return res.status(404).json({ error: 'repush request not found or not picked' });

  res.json({ ok: true });

  // 補推成功 → 回完 ack 之後,立刻在背景把這一筆重驗,不用等明天的排程。
  // 重驗失敗只記 log,不影響 ack(現場端是在等這個回應)。
  if (ok) {
    const row = r.rows[0];
    recon.reverifyEvent(row.book_id, row.external_source, row.external_id)
      .catch((e) => console.warn(`[recon] 補推後重驗失敗 ${row.external_id}:`, e.message));
  }
}));

module.exports = router;
