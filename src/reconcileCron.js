// src/reconcileCron.js
// 對帳中心 v1（記帳雲總計畫 Phase 0 / 紙測 F2/F10;2026-10-10 施工計畫 §4.7 重寫）
//
// 每日 04:10 (Asia/Taipei) 拉現場系統 /api/integrations/recon-summary?date=<昨天>，
// 逐事件比對自己的帳本（journal_logs / pending_journals），分三類寫進 recon_results：
//   settled    = 對平（已入帳且金額一致；含已退回 — 有人工交代過）
//   in_transit = 在途（現場 outbox 排隊中 / 雲端待審）→ 不告警（F10：在途不是差異）…
//                但超過 3 天還在途就算差異（LEO 2026-10-10 拍板 6）
//   diff       = 真差異（現場漏排入 / 已推但雲端沒有 / 推送 dead / 金額不符 / 現場沒有這筆）→ 告警
//
// 2026-10-10 起:
//   R7  比金額:現場給的 amount 和帳本單頭金額不一樣 → diff
//   R8  改單後雲端是 <單號>@v2…:找最新版,舊版被沖銷不算入帳
//   R9  不只驗昨天:每天回驗最近 8 天(昨天 + 往前 7 天),在途超過 3 天升級成差異 + ntfy
//   Y30 雲端已入帳優先於「推送 dead」
//   Y31 反方向:帳本有、現場清單沒有 → diff;現場清單不再列出的舊列 → stale(頁面預設隱藏)
//   Y32 沒跑成會記一列 external_source='_run'(cloud_status='failed'),頁面看得出「沒跑」≠「沒差異」;下次排程 / 啟動補跑
//   Y33 node-cron 排程(10 4 * * * Asia/Taipei)+ 啟動時檢查昨天有沒有跑成,沒有就補
//
// 也可由 routes/reconciliation.js 手動觸發 runFor(bookCode, date)。
//
// 認證：對現場的 GET 用 HMAC 簽名，訊息 = "<ts>.<path+query>"（與現場端驗證對齊），
// secret 同 WEBHOOK_HMAC_SECRET（兩邊本來就同一把）。

'use strict';

const http = require('http');
const { URL } = require('url');
const { query } = require('./db');
const hmac = require('./utils/hmac');
const alertService = require('./alertService');

const LEO_BASE_URL = process.env.LEO_BASE_URL || 'http://10.0.1.168:3000';
const RECON_BOOK_CODE = process.env.RECON_BOOK_CODE || 'NEST0001';

const RECON_SCHEDULE = '10 4 * * *';     // 每天 04:10 台北時間
const TIMEZONE = 'Asia/Taipei';
const REVERIFY_DAYS = 7;                 // 昨天之外,再往前回驗幾天
const TRANSIT_MAX_DAYS = 3;              // 在途超過幾天算差異(LEO 拍板 6)
const AMOUNT_TOLERANCE = 0.5;            // 金額一律整數元;留 0.5 容許小數尾差
// 這些事件雲端單頭金額不等於現場金額(訂金抵用 = 4408 −X / 4101 +X,科目腳合計為 0),不比金額
const SKIP_AMOUNT_EVENTS = new Set(['pos_deposit_offset']);

// ── 日期(固定 UTC+8,台灣沒有日光節約;不依賴容器 TZ)─────────────────
const TPE_OFFSET_MS = 8 * 3600 * 1000;
const pad2 = (n) => String(n).padStart(2, '0');

function ymdTaipei(d) {
  const t = new Date(d.getTime() + TPE_OFFSET_MS);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}
function daysBetween(fromStr, toStr) {
  const a = fromStr.split('-').map(Number);
  const b = toStr.split('-').map(Number);
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
}
function minutesOfDayTaipei(d) {
  const t = new Date(d.getTime() + TPE_OFFSET_MS);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}

function money(n) {
  return '$' + Math.round(Number(n)).toLocaleString('en-US');
}

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

// ── 版本號:<單號> = v1,<單號>@v2 = v2 ─────────────────────────────────
function versionOf(externalId) {
  const m = /@v(\d+)$/.exec(String(externalId || ''));
  return m ? Number(m[1]) : 1;
}
function baseOf(externalId) {
  return String(externalId || '').replace(/@v\d+$/, '');
}

/**
 * 這筆事件在雲端帳本現在長怎樣。回 { status, amount, external_id }
 *   status:posted(已入帳,amount = 帳本單頭金額,可能 null)/ reversed(已沖銷且沒有新版)/
 *          pending_review(雲端待審)/ rejected(已退回)/ missing
 * 改單(R8):現場可能還拿舊單號來問,雲端實際在 <單號>@v2…;取版本最高的那一筆判斷。
 */
async function cloudStatusOf(bookId, ev) {
  const evVersion = versionOf(ev.external_id);
  const base = baseOf(ev.external_id);
  const params = [bookId, ev.external_source, ev.external_id, `${base}@v`];

  const j = await query(
    `SELECT id, external_id, amount, reversed_by_id FROM journal_logs
      WHERE book_id = $1 AND external_source = $2
        AND (external_id = $3 OR starts_with(external_id, $4))
      ORDER BY id DESC`,
    params
  );
  const pj = await query(
    `SELECT id, external_id, status FROM pending_journals
      WHERE book_id = $1 AND external_source = $2
        AND (external_id = $3 OR starts_with(external_id, $4))
      ORDER BY id DESC`,
    params
  );

  const cands = [];
  for (const r of j.rows) cands.push({ kind: 'journal', v: versionOf(r.external_id), row: r });
  for (const r of pj.rows) cands.push({ kind: 'pending', v: versionOf(r.external_id), row: r });
  // 比現場問的版本還舊的不算(現場說 @v2,雲端只有 v1 = v2 還沒到)
  const live = cands.filter(c => c.v >= evVersion);
  if (live.length === 0) return { status: 'missing', amount: null, external_id: null };

  const top = Math.max(...live.map(c => c.v));
  const atTop = live.filter(c => c.v === top);
  const journal = atTop.find(c => c.kind === 'journal');
  if (journal) {
    const r = journal.row;
    if (r.reversed_by_id) return { status: 'reversed', amount: null, external_id: r.external_id };
    return {
      status: 'posted',
      amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
      external_id: r.external_id,
    };
  }
  const p = atTop.find(c => c.kind === 'pending').row;
  if (p.status === 'pending') return { status: 'pending_review', amount: null, external_id: p.external_id };
  if (p.status === 'rejected') return { status: 'rejected', amount: null, external_id: p.external_id };
  // approved / auto_posted(resulting journal 已在 journal_logs,上面會先找到;這裡是保險 fallback)
  return { status: 'posted', amount: null, external_id: p.external_id };
}

// 單一事件分類（紙測 F10：在途與真差異分流）
function classify(ev, cloud, isDead, reconDate, now) {
  const status = typeof cloud === 'string' ? cloud : cloud.status;
  const cloudAmount = typeof cloud === 'string' ? null : cloud.amount;
  let out;

  if (status === 'posted') {
    // Y30:雲端已經入帳就是入帳,不管現場 outbox 還留著舊的 dead
    const leoAmt = ev.amount === null || ev.amount === undefined ? null : Number(ev.amount);
    if (leoAmt !== null && Number.isFinite(leoAmt) && cloudAmount !== null && cloudAmount !== undefined
        && !SKIP_AMOUNT_EVENTS.has(ev.event_type)
        && Math.abs(leoAmt - cloudAmount) > AMOUNT_TOLERANCE) {
      out = { bucket: 'diff', detail: `金額不符：現場 ${money(leoAmt)}、帳本 ${money(cloudAmount)}` };
    } else {
      out = { bucket: 'settled', detail: null };
    }
  } else if (isDead) {
    out = { bucket: 'diff', detail: '現場連續推送失敗 5 次 — 可補推' };
  } else {
    switch (status) {
      case 'rejected':
        out = { bucket: 'settled', detail: '已人工退回（有交代）' };
        break;
      case 'reversed':
        out = { bucket: 'diff', detail: '帳本裡這筆已被沖銷，也沒有新版本，請到記帳雲確認' };
        break;
      case 'pending_review':
        out = { bucket: 'in_transit', detail: '雲端待審' };
        break;
      case 'missing':
      default:
        if (!ev.leo_status) out = { bucket: 'diff', detail: '現場沒有排入推送，要回原系統重新觸發' };
        else if (ev.leo_status === 'pending' || ev.leo_status === 'sending') {
          out = { bucket: 'in_transit', detail: '推送佇列中' };
        } else {
          out = { bucket: 'diff', detail: '現場顯示已送出，但帳本裡沒有這筆 — 可補推' };
        }
    }
  }

  // R9 / 拍板 6:在途超過 3 天就不是在途了
  if (out.bucket === 'in_transit' && reconDate && now) {
    if (daysBetween(reconDate, ymdTaipei(now)) > TRANSIT_MAX_DAYS) {
      out = { bucket: 'diff', detail: `在途超過 ${TRANSIT_MAX_DAYS} 天（${out.detail}）` };
    }
  }
  return out;
}

async function evaluateEvent(bookId, ev, { isDead = false, reconDate = null, now = new Date() } = {}) {
  const cloud = await cloudStatusOf(bookId, ev);
  const { bucket, detail } = classify(ev, cloud, isDead, reconDate, now);
  return { cloud_status: cloud.status, bucket, detail };
}

const UPSERT_SQL = `
  INSERT INTO recon_results
    (book_id, recon_date, external_source, external_id, event_type,
     leo_amount, leo_status, cloud_status, bucket, detail, run_at)
  VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
  ON CONFLICT (book_id, recon_date, external_source, external_id) DO UPDATE
    SET event_type = EXCLUDED.event_type, leo_amount = EXCLUDED.leo_amount,
        leo_status = EXCLUDED.leo_status, cloud_status = EXCLUDED.cloud_status,
        bucket = EXCLUDED.bucket, detail = EXCLUDED.detail, run_at = NOW()`;

/** 記「這天有沒有跑成」(Y32)。用 recon_results 的 '_run' 列,不另建表(建表 = schema 異動) */
async function recordRun(bookId, dateStr, ok, detail) {
  await query(UPSERT_SQL, [
    bookId, dateStr, '_run', 'daily', 'run', null, null,
    ok ? 'ok' : 'failed', ok ? 'settled' : 'diff', detail || null,
  ]);
}

async function loadBook(bookCodeStr) {
  const bookRes = await query(
    `SELECT id, code FROM books WHERE code = $1 AND is_active = TRUE`,
    [bookCodeStr]
  );
  if (bookRes.rows.length === 0) throw new Error(`找不到帳本 ${bookCodeStr}`);
  return bookRes.rows[0];
}

/**
 * 對一個帳本的一天做完整對帳。回 { counts, newDiffs }(newDiffs = 這次新變成差異的說明,供合併告警)。
 * opts.onlyId:只重驗這一個 external_id(補推 ack 之後用),不做反方向 / stale。
 */
async function runOne(book, dateStr, opts = {}) {
  const now = opts.now || new Date();
  const counts = { settled: 0, in_transit: 0, diff: 0 };
  const newDiffs = [];
  try {
    const summary = await signedGetJson(
      `${LEO_BASE_URL}/api/integrations/recon-summary?date=${dateStr}`
    );
    const events = summary.events || [];
    const deadIds = new Set(
      (summary.outbox && summary.outbox.dead || []).map(d => d.external_id).filter(Boolean)
    );

    // 上一次的結果:判斷「這次才變成差異」才告警,同一筆舊差異不天天吵
    const priorRes = await query(
      `SELECT external_source, external_id, bucket FROM recon_results
        WHERE book_id = $1 AND recon_date = $2::date AND external_source <> '_run'`,
      [book.id, dateStr]
    );
    const prior = new Map(priorRes.rows.map(r => [`${r.external_source}|${r.external_id}`, r.bucket]));
    const seen = [];

    for (const ev of events) {
      if (opts.onlyId && ev.external_id !== opts.onlyId) continue;
      const r = await evaluateEvent(book.id, ev, {
        isDead: deadIds.has(ev.external_id), reconDate: dateStr, now,
      });
      counts[r.bucket]++;
      const key = `${ev.external_source}|${ev.external_id}`;
      seen.push(key);
      await query(UPSERT_SQL, [
        book.id, dateStr, ev.external_source, ev.external_id, ev.event_type,
        ev.amount, ev.leo_status, r.cloud_status, r.bucket, r.detail,
      ]);
      if (r.bucket === 'diff' && prior.get(key) !== 'diff') newDiffs.push(r.detail);
    }

    if (!opts.onlyId) {
      // Y31 反方向:帳本這天有、現場清單沒有
      const known = new Set();
      for (const ev of events) { known.add(ev.external_id); known.add(baseOf(ev.external_id)); }
      const cloudRows = await query(
        `SELECT external_source, external_id, amount FROM journal_logs
          WHERE book_id = $1 AND date = $2::date
            AND external_source IS NOT NULL AND external_source <> ''
            AND reversed_by_id IS NULL AND reverses_id IS NULL`,
        [book.id, dateStr]
      );
      for (const row of cloudRows.rows) {
        if (known.has(row.external_id) || known.has(baseOf(row.external_id))) continue;
        // 現場把它列在別天(例:薪資、進貨的歸日算法和帳本日期不同)→ 不算「現場沒有」
        const elsewhere = await query(
          `SELECT 1 FROM recon_results
            WHERE book_id = $1 AND external_source = $2 AND external_id = ANY($3::text[])
              AND recon_date <> $4::date AND cloud_status <> 'stale' LIMIT 1`,
          [book.id, row.external_source, [row.external_id, baseOf(row.external_id)], dateStr]
        );
        if (elsewhere.rows.length > 0) continue;
        const detail = `現場沒有這筆（帳本有 ${money(row.amount)}）`;
        const key = `${row.external_source}|${row.external_id}`;
        seen.push(key);
        counts.diff++;
        await query(UPSERT_SQL, [
          book.id, dateStr, row.external_source, row.external_id, 'cloud_only',
          null, null, 'posted', 'diff', detail,
        ]);
        if (prior.get(key) !== 'diff') newDiffs.push(detail);
      }

      // 現場清單不再列出的舊列 → stale(頁面預設隱藏)
      await query(
        `UPDATE recon_results
            SET cloud_status = 'stale', bucket = 'settled',
                detail = '現場清單已不再列出這筆', run_at = NOW()
          WHERE book_id = $1 AND recon_date = $2::date AND external_source <> '_run'
            AND cloud_status <> 'stale'
            AND (external_source || '|' || external_id) <> ALL($3::text[])`,
        [book.id, dateStr, seen]
      );
    }

    if (!opts.onlyId) await recordRun(book.id, dateStr, true, '對帳完成');
    console.log(`[recon] ${book.code} ${dateStr}: 對平=${counts.settled} 在途=${counts.in_transit} 差異=${counts.diff}`);
    return { counts, newDiffs };
  } catch (e) {
    // Y32:記下「這天沒跑成」,頁面才分得出「沒跑」和「沒差異」
    if (!opts.onlyId) {   // 單筆重驗失敗不能蓋掉「這天已經跑成」的紀錄
      try { await recordRun(book.id, dateStr, false, `對帳沒跑成：${e.message}`.slice(0, 300)); } catch (_) { /* 記不了就算了 */ }
    }
    throw e;
  }
}

function alertNewDiffs(book, dateLabel, newDiffs, inTransit) {
  if (newDiffs.length === 0) return;
  const sample = newDiffs.slice(0, 3).join('；');
  const more = newDiffs.length > 3 ? `…等 ${newDiffs.length} 筆` : '';
  return alertService.notify(
    `對帳發現 ${newDiffs.length} 筆新差異`,
    `${dateLabel} 帳本 ${book.code}：${sample}${more}。請開「對帳中心」處理` +
      (inTransit ? `（在途 ${inTransit} 筆不算差異）` : ''),
    'warn'
  );
}

/** 手動 / 單日對帳。回 counts({settled,in_transit,diff});失敗 throw(同時已記一列 '_run' failed) */
async function runFor(bookCodeStr, dateStr, opts = {}) {
  const book = await loadBook(bookCodeStr);
  const r = await runOne(book, dateStr, opts);
  await alertNewDiffs(book, dateStr, r.newDiffs, r.counts.in_transit);
  return r.counts;
}

/** 補推 ack 成功後,立刻把這一筆重驗(不用等明天) */
async function reverifyEvent(bookId, externalSource, externalId) {
  const found = await query(
    `SELECT recon_date::text AS d FROM recon_results
      WHERE book_id = $1 AND external_source = $2 AND external_id = $3 AND cloud_status <> 'stale'
      ORDER BY recon_date DESC LIMIT 1`,
    [bookId, externalSource, externalId]
  );
  if (found.rows.length === 0) return null;
  const bookRes = await query(`SELECT id, code FROM books WHERE id = $1 AND is_active = TRUE`, [bookId]);
  if (bookRes.rows.length === 0) return null;
  const r = await runOne(bookRes.rows[0], found.rows[0].d, { onlyId: externalId });
  return r.counts;
}

let running = false;

/** 每日排程:昨天 + 往前回驗 7 天。回 { ran, dates } 或 { ran:false, ... } —— 不 throw */
async function runDaily(now = new Date()) {
  if (running) return { ran: false, skipped: true };
  running = true;
  try {
    const yesterday = addDays(ymdTaipei(now), -1);
    let book;
    try {
      book = await loadBook(RECON_BOOK_CODE);
    } catch (e) {
      console.error('[recon] daily run failed:', e.message);
      await alertService.notify('對帳排程沒跑成', `${yesterday}：${e.message}`, 'error');
      return { ran: false, error: e.message };
    }
    const dates = [];
    const allNew = [];
    let inTransit = 0;
    for (let i = 0; i <= REVERIFY_DAYS; i++) {
      const d = addDays(yesterday, -i);
      try {
        const r = await runOne(book, d, { now });
        dates.push({ date: d, counts: r.counts });
        allNew.push(...r.newDiffs);
        inTransit += r.counts.in_transit;
      } catch (e) {
        console.error(`[recon] daily run failed (${d}):`, e.message);
        await alertService.notify(
          '對帳沒跑成',
          `${d}：現場系統可能連不上。會在下一次自動重試（每天凌晨 4:10，或系統重開時），也可以到對帳中心手動補跑。`,
          'error'
        );
        return { ran: false, failed_date: d, dates };
      }
    }
    await alertNewDiffs(book, `${addDays(yesterday, -REVERIFY_DAYS)} ~ ${yesterday}`, allNew, inTransit);
    return { ran: true, dates };
  } finally {
    running = false;
  }
}

/** 啟動時:昨天的對帳有沒有跑成?沒有而且已過 04:10 → 補跑(Y33) */
async function catchUp(now = new Date()) {
  if (minutesOfDayTaipei(now) < 4 * 60 + 10) return { skipped: 'before-schedule' };
  const yesterday = addDays(ymdTaipei(now), -1);
  const book = await loadBook(RECON_BOOK_CODE);
  const done = await query(
    `SELECT 1 FROM recon_results
      WHERE book_id = $1 AND recon_date = $2::date
        AND external_source = '_run' AND cloud_status = 'ok' LIMIT 1`,
    [book.id, yesterday]
  );
  if (done.rows.length > 0) return { skipped: 'already-ran' };
  console.log(`[recon] 啟動補跑:${yesterday} 的對帳還沒跑成`);
  return runDaily(now);
}

function loadNodeCron() {
  try { return require('node-cron'); } catch (e) { return null; }
}

function startCron() {
  const cron = loadNodeCron();
  const job = () => { runDaily().catch((e) => console.error('[recon] cron error:', e.message)); };
  if (cron) {
    cron.schedule(RECON_SCHEDULE, job, { timezone: TIMEZONE });
    console.log(`[recon] cron 已啟用 (${RECON_SCHEDULE} ${TIMEZONE}, 昨天 + 回驗前 ${REVERIFY_DAYS} 天)`);
  } else {
    // node-cron 沒裝好時的備援:每分鐘看一次時鐘
    console.warn('[recon] 找不到 node-cron,改用每分鐘檢查的備援排程');
    setInterval(() => {
      const m = minutesOfDayTaipei(new Date());
      if (m === 4 * 60 + 10) job();
    }, 60 * 1000);
  }
  // 啟動後稍等(讓 DB / 路由先就緒)再檢查有沒有漏跑
  const t = setTimeout(() => {
    catchUp().catch((e) => console.error('[recon] 啟動補跑檢查失敗:', e.message));
  }, 20 * 1000);
  if (t.unref) t.unref();
}

module.exports = {
  runFor, runDaily, startCron, catchUp, reverifyEvent,
  // 給 route 與測試用
  RECON_BOOK_CODE, RECON_SCHEDULE, TRANSIT_MAX_DAYS,
  cloudStatusOf, classify, evaluateEvent, ymdTaipei, addDays, daysBetween,
};
