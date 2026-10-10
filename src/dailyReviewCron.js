// src/dailyReviewCron.js
// D24：每日 23:55 (Asia/Taipei) 為每本 book 建一筆 daily_review_log，
// 聚合當日（營業日）所有 auto-posted journal_logs 給主管事後 ack。
//
// 7 天未 ack 自動升 escalated。
//
// 2026-10-10 施工計畫 §4.7(Y33、Y36):
//   - 排程改 node-cron(23:55 Asia/Taipei);啟動時補跑「昨天營業日」的聚合
//   - 「當天」用 5 點營業日切(凌晨 5 點前算前一天),算法同主 repo pages/js/shared/bizday.js
//   - 已 ack 的列不覆寫(以前補跑 / 重跑會把 acked 的 ids、總額蓋掉)
//   - 每本帳本各自 try/catch,一本壞了不影響其他
//   - 告警改走 alertService(有設 NTFY_URL 才真的推)

'use strict';

const { query } = require('./db');
const alertService = require('./alertService');

const REVIEW_SCHEDULE = '55 23 * * *';
const TIMEZONE = 'Asia/Taipei';
const BIZ_CUTOFF_H = 5;                  // 凌晨 5 點前算前一天
const TPE_OFFSET_MS = 8 * 3600 * 1000;   // 台灣固定 UTC+8
const pad2 = (n) => String(n).padStart(2, '0');

/** 營業日(YYYY-MM-DD,台北時間;04:59 還算前一天,05:00 起算當天) */
function bizDate(now) {
  const base = now ? now.getTime() : Date.now();
  const t = new Date(base + TPE_OFFSET_MS - BIZ_CUTOFF_H * 3600 * 1000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

let running = false;

async function runDailyReview(reviewDate, now = new Date()) {
  if (running) return;
  running = true;
  const date = reviewDate || bizDate(now);
  console.log(`[daily-review] cron 啟動 (營業日 ${date})`);
  try {
    const booksRes = await query(`SELECT id, code FROM books WHERE is_active = TRUE`);
    for (const b of booksRes.rows) {
      // 每本帳本各自處理,一本失敗不影響其他本(Y36⑤)
      try {
        await aggregateForBook(b, date);
      } catch (e) {
        console.error(`[daily-review] ${b.code} ${date} 失敗:`, e.message);
        await alertService.notify('每日覆核彙整失敗', `帳本 ${b.code} 營業日 ${date} 彙整失敗，明天排程會再試。`, 'error');
      }
    }
    try {
      await escalateStale(bizDate(now));
    } catch (e) {
      console.error('[daily-review] 升級檢查失敗:', e.message);
    }
    console.log('[daily-review] cron 完成');
  } catch (e) {
    console.error('[daily-review] cron 失敗:', e.message);
    await alertService.notify('每日覆核排程失敗', '無法讀取帳本清單，明天排程會再試。', 'error');
  } finally {
    running = false;
  }
}

async function aggregateForBook(book, reviewDate) {
  // pending_journals 含 status='auto_posted' 且 reviewed_at 落在該營業日(凌晨 5 點切日)
  const jRes = await query(
    `SELECT j.id, j.amount
       FROM journal_logs j
       JOIN pending_journals pj ON pj.resulting_journal_id = j.id
      WHERE j.book_id = $1
        AND pj.status = 'auto_posted'
        AND DATE((pj.reviewed_at AT TIME ZONE 'Asia/Taipei') - INTERVAL '5 hours') = $2::date
        AND j.reversed_by_id IS NULL`,
    [book.id, reviewDate]
  );

  if (jRes.rows.length === 0) {
    console.log(`[daily-review] ${book.code} ${reviewDate}: 無 auto-posted，跳過`);
    return;
  }

  const ids = jRes.rows.map(r => r.id);
  const total = jRes.rows.reduce((s, r) => s + Number(r.amount), 0);

  // upsert daily_review_log —— 已 ack 的不覆寫(WHERE status <> 'acked' → 被略過時 RETURNING 空)
  const upRes = await query(
    `INSERT INTO daily_review_log (book_id, review_date, journal_log_ids, total_amount, status)
     VALUES ($1, $2::date, $3::jsonb, $4, 'pending')
     ON CONFLICT (book_id, review_date) DO UPDATE
       SET journal_log_ids = EXCLUDED.journal_log_ids,
           total_amount = EXCLUDED.total_amount
     WHERE daily_review_log.status <> 'acked'
     RETURNING id, status`,
    [book.id, reviewDate, JSON.stringify(ids), total]
  );

  if (upRes.rows.length === 0) {
    console.log(`[daily-review] ${book.code} ${reviewDate}: 已覆核過，不覆寫`);
    return;
  }

  console.log(`[daily-review] ${book.code} ${reviewDate}: ${ids.length} 筆 / $${total} (status=${upRes.rows[0].status})`);

  if (upRes.rows[0].status === 'pending') {
    await alertService.warn('daily_review_pending', {
      bookCode: book.code, review_date: reviewDate, count: ids.length, total_amount: total,
      dedup_key: `${book.code}-${reviewDate}`,
    });
  }
}

async function escalateStale(today) {
  // 7 天未 ack → status='escalated'(以營業日算,不用 DB 的 CURRENT_DATE)
  const r = await query(
    `UPDATE daily_review_log
        SET status = 'escalated', escalated_at = NOW()
      WHERE status = 'pending'
        AND review_date < $1::date - 7
      RETURNING id, book_id, review_date`,
    [today]
  );
  if (r.rows.length > 0) {
    console.error(`[daily-review] 升級 ${r.rows.length} 筆 escalated`);
    for (const row of r.rows) {
      await alertService.error('daily_review_escalated', {
        daily_review_id: row.id, book_id: row.book_id, review_date: row.review_date,
        dedup_key: `esc-${row.id}`,
      });
    }
  }
}

/** 啟動補跑:昨天營業日如果有 auto-posted 但還沒有覆核紀錄(23:55 那時系統停著)→ 補聚合一次 */
async function catchUp(now = new Date()) {
  const yesterday = addDays(bizDate(now), -1);
  const have = await query(
    `SELECT 1 FROM daily_review_log WHERE review_date = $1::date LIMIT 1`,
    [yesterday]
  );
  if (have.rows.length > 0) return { skipped: 'already-has-log' };
  console.log(`[daily-review] 啟動補跑:營業日 ${yesterday} 還沒有覆核紀錄`);
  await runDailyReview(yesterday, now);
  return { ran: true, date: yesterday };
}

function loadNodeCron() {
  try { return require('node-cron'); } catch (e) { return null; }
}

function startCron() {
  const cron = loadNodeCron();
  const job = () => { runDailyReview().catch((e) => console.error('[daily-review] cron error:', e.message)); };
  if (cron) {
    cron.schedule(REVIEW_SCHEDULE, job, { timezone: TIMEZONE });
    console.log(`[daily-review] cron 已啟用 (${REVIEW_SCHEDULE} ${TIMEZONE})`);
  } else {
    // node-cron 沒裝好時的備援:每分鐘看一次台北時鐘
    console.warn('[daily-review] 找不到 node-cron,改用每分鐘檢查的備援排程');
    setInterval(() => {
      const t = new Date(Date.now() + TPE_OFFSET_MS);
      if (t.getUTCHours() === 23 && t.getUTCMinutes() === 55) job();
    }, 60 * 1000);
  }
  const t = setTimeout(() => {
    catchUp().catch((e) => console.error('[daily-review] 啟動補跑失敗:', e.message));
  }, 30 * 1000);
  if (t.unref) t.unref();
}

module.exports = { runDailyReview, startCron, catchUp, bizDate, REVIEW_SCHEDULE };
