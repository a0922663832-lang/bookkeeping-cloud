// src/reconcileCron.js
// 對帳中心 v1（記帳雲總計畫 Phase 0 / 紙測 F2/F10）
//
// 每日 04:10 (Asia/Taipei) 拉 LEO 端 /api/integrations/recon-summary?date=<昨天>，
// 逐事件比對自己的帳本（journal_logs / pending_journals），分三類寫進 recon_results：
//   settled    = 對平（已入帳；含已退回 — 有人工交代過）
//   in_transit = 在途（LEO outbox 排隊中 / 雲端待審）→ 不告警（F10：在途不是差異）
//   diff       = 真差異（LEO 漏排入 / 已推但雲端沒有 / 推送 dead）→ ntfy 告警
//
// 也可由 routes/reconciliation.js 手動觸發 runFor(bookCode, date)。
//
// 認證：對 LEO 的 GET 用 HMAC 簽名，訊息 = "<ts>.<path+query>"（與 LEO 端驗證對齊），
// secret 同 WEBHOOK_HMAC_SECRET（兩邊本來就同一把）。

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { query } = require('./db');
const hmac = require('./utils/hmac');

const LEO_BASE_URL = process.env.LEO_BASE_URL || 'http://10.0.1.168:3000';
const RECON_BOOK_CODE = process.env.RECON_BOOK_CODE || 'NEST0001';
const NTFY_URL = process.env.NTFY_URL || ''; // 例: https://ntfy.sh/<topic>；不設則只記 log

function signedGetJson(fullUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(fullUrl);
    const pathWithQuery = u.pathname + u.search;
    const ts = Date.now();
    const sig = hmac.computeSignature(ts, pathWithQuery);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: pathWithQuery,
      method: 'GET',
      headers: { 'X-Timestamp': ts.toString(), 'X-Signature': `sha256=${sig}` },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        } else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function notify(title, message) {
  if (!NTFY_URL) {
    console.warn(`[recon][ALERT] ${title}: ${message}`);
    return;
  }
  try {
    const u = new URL(NTFY_URL);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: { Title: encodeURIComponent(title), Priority: 'high', Tags: 'warning' },
      timeout: 8000,
    });
    req.on('error', (e) => console.warn('[recon] ntfy failed:', e.message));
    req.on('timeout', () => req.destroy());
    req.write(message);
    req.end();
  } catch (e) {
    console.warn('[recon] ntfy failed:', e.message);
  }
}

// 單一事件分類（紙測 F10：在途與真差異分流）
function classify(ev, cloudStatus, isDead) {
  if (isDead) return { bucket: 'diff', detail: '推送失敗 5 次（dead）— 可補推' };
  switch (cloudStatus) {
    case 'posted':
      return { bucket: 'settled', detail: null };
    case 'rejected':
      return { bucket: 'settled', detail: '已人工退回（有交代）' };
    case 'pending_review':
      return { bucket: 'in_transit', detail: '雲端待審' };
    case 'missing':
    default:
      if (!ev.leo_status) return { bucket: 'diff', detail: 'LEO 端未排入推送 — 需手動重新觸發' };
      if (ev.leo_status === 'pending' || ev.leo_status === 'sending') {
        return { bucket: 'in_transit', detail: '推送佇列中' };
      }
      return { bucket: 'diff', detail: `LEO 已推（${ev.leo_status}）但雲端無此帳 — 可補推` };
  }
}

async function cloudStatusOf(bookId, ev) {
  const j = await query(
    `SELECT id FROM journal_logs
      WHERE book_id = $1 AND external_source = $2 AND external_id = $3`,
    [bookId, ev.external_source, ev.external_id]
  );
  if (j.rows.length > 0) return 'posted';
  const pj = await query(
    `SELECT status FROM pending_journals
      WHERE book_id = $1 AND external_source = $2 AND external_id = $3
      ORDER BY id DESC LIMIT 1`,
    [bookId, ev.external_source, ev.external_id]
  );
  if (pj.rows.length === 0) return 'missing';
  const s = pj.rows[0].status;
  if (s === 'pending') return 'pending_review';
  if (s === 'rejected') return 'rejected';
  return 'posted'; // approved / auto_posted（resulting journal 已在 journal_logs，保險 fallback）
}

async function runFor(bookCodeStr, dateStr) {
  const bookRes = await query(
    `SELECT id, code FROM books WHERE code = $1 AND is_active = TRUE`,
    [bookCodeStr]
  );
  if (bookRes.rows.length === 0) throw new Error(`book ${bookCodeStr} not found`);
  const book = bookRes.rows[0];

  const summary = await signedGetJson(
    `${LEO_BASE_URL}/api/integrations/recon-summary?date=${dateStr}`
  );

  const deadIds = new Set(
    (summary.outbox && summary.outbox.dead || []).map(d => d.external_id).filter(Boolean)
  );

  const counts = { settled: 0, in_transit: 0, diff: 0 };
  for (const ev of summary.events || []) {
    const cloudStatus = await cloudStatusOf(book.id, ev);
    const { bucket, detail } = classify(ev, cloudStatus, deadIds.has(ev.external_id));
    counts[bucket]++;
    await query(
      `INSERT INTO recon_results
         (book_id, recon_date, external_source, external_id, event_type,
          leo_amount, leo_status, cloud_status, bucket, detail, run_at)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (book_id, recon_date, external_source, external_id) DO UPDATE
         SET leo_amount = EXCLUDED.leo_amount, leo_status = EXCLUDED.leo_status,
             cloud_status = EXCLUDED.cloud_status, bucket = EXCLUDED.bucket,
             detail = EXCLUDED.detail, run_at = NOW()`,
      [book.id, dateStr, ev.external_source, ev.external_id, ev.event_type,
       ev.amount, ev.leo_status, cloudStatus, bucket, detail]
    );
  }

  console.log(`[recon] ${book.code} ${dateStr}: 對平=${counts.settled} 在途=${counts.in_transit} 差異=${counts.diff}`);

  if (counts.diff > 0) {
    notify(
      `對帳發現 ${counts.diff} 筆差異`,
      `${dateStr} 帳本 ${book.code}：${counts.diff} 筆真差異，請開 對帳中心 處理（在途 ${counts.in_transit} 筆不算差異）`
    );
  }
  return counts;
}

async function runDaily() {
  // 昨天（容器 TZ = Asia/Taipei）
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  try {
    await runFor(RECON_BOOK_CODE, dateStr);
  } catch (e) {
    console.error(`[recon] daily run failed (${dateStr}):`, e.message);
    notify('對帳排程失敗', `${dateStr}：${e.message}（LEO 端可能離線，明天會重試；也可在對帳中心手動補跑）`);
  }
}

function startCron() {
  function tick() {
    const now = new Date();
    if (now.getHours() === 4 && now.getMinutes() === 10) runDaily();
  }
  setInterval(tick, 60 * 1000);
  console.log('[recon] cron scheduler 已啟用 (每日 04:10 台北時間, 對前一日逐事件對帳)');
}

module.exports = { runFor, runDaily, startCron };
