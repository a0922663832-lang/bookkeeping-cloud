// src/dailyReviewCron.js
// D24：每日 23:55 (Asia/Taipei) 為每本 book 建一筆 daily_review_log，
// 聚合當日所有 auto-posted journal_logs 給主管事後 ack。
//
// 7 天未 ack 自動升 escalated。

'use strict';

const { query } = require('./db');
const VERSION = '1';

async function runDailyReview() {
  console.log('[daily-review] cron 啟動');
  try {
    // 取所有 active books
    const booksRes = await query(`SELECT id, code FROM books WHERE is_active = TRUE`);
    for (const b of booksRes.rows) {
      await aggregateForBook(b);
    }
    await escalateStale();
    console.log('[daily-review] cron 完成');
  } catch (e) {
    console.error('[daily-review] cron 失敗:', e.message);
  }
}

async function aggregateForBook(book) {
  // 用台北時區當日（database tz 已設 Asia/Taipei via migration 014）
  // 取今日 (CURRENT_DATE 在 Asia/Taipei tz 下) 所有 auto-posted journal
  const today = await query(`SELECT CURRENT_DATE AS today`);
  const reviewDate = today.rows[0].today;

  // pending_journals 含 status='auto_posted' 且 reviewed_at 為今日
  const jRes = await query(
    `SELECT j.id, j.amount
       FROM journal_logs j
       JOIN pending_journals pj ON pj.resulting_journal_id = j.id
      WHERE j.book_id = $1
        AND pj.status = 'auto_posted'
        AND DATE(pj.reviewed_at AT TIME ZONE 'Asia/Taipei') = $2::date
        AND j.reversed_by_id IS NULL`,
    [book.id, reviewDate]
  );

  if (jRes.rows.length === 0) {
    console.log(`[daily-review] ${book.code} ${reviewDate}: 無 auto-posted，跳過`);
    return;
  }

  const ids = jRes.rows.map(r => r.id);
  const total = jRes.rows.reduce((s, r) => s + Number(r.amount), 0);

  // upsert daily_review_log
  const upRes = await query(
    `INSERT INTO daily_review_log (book_id, review_date, journal_log_ids, total_amount, status)
     VALUES ($1, $2::date, $3::jsonb, $4, 'pending')
     ON CONFLICT (book_id, review_date) DO UPDATE
       SET journal_log_ids = EXCLUDED.journal_log_ids,
           total_amount = EXCLUDED.total_amount
     RETURNING id, status`,
    [book.id, reviewDate, JSON.stringify(ids), total]
  );

  console.log(`[daily-review] ${book.code} ${reviewDate}: ${ids.length} 筆 / $${total} (status=${upRes.rows[0].status})`);

  // alertService 通知（cloud 端 alertService 走 LINE Notify；簡化版直接 console.warn）
  if (upRes.rows[0].status === 'pending') {
    console.warn(`[ALERT] daily_review_pending book=${book.code} date=${reviewDate} count=${ids.length} total=$${total}`);
    // 若 cloud 有 alertService 模組可以接：
    try {
      const alert = require('./alertService');
      if (alert && alert.warn) {
        alert.warn('daily_review_pending', {
          bookCode: book.code, review_date: reviewDate, count: ids.length, total_amount: total,
          dedup_key: `${book.code}-${reviewDate}`,
        });
      }
    } catch (_) { /* alertService not built yet, fall back to console */ }
  }
}

async function escalateStale() {
  // 7 天未 ack → status='escalated'
  const r = await query(
    `UPDATE daily_review_log
        SET status = 'escalated', escalated_at = NOW()
      WHERE status = 'pending'
        AND review_date < CURRENT_DATE - INTERVAL '7 days'
      RETURNING id, book_id, review_date`
  );
  if (r.rows.length > 0) {
    console.error(`[daily-review] 升級 ${r.rows.length} 筆 escalated`);
    for (const row of r.rows) {
      try {
        const alert = require('./alertService');
        if (alert && alert.error) {
          alert.error('daily_review_escalated', { daily_review_id: row.id, book_id: row.book_id, review_date: row.review_date });
        }
      } catch (_) {}
    }
  }
}

function startCron() {
  // node-cron 或內建 setInterval。本系統未引入 node-cron 套件，
  // 用 setTimeout-based scheduler：每分鐘檢查是否到 23:55
  const TARGET_HH = 23;
  const TARGET_MM = 55;

  function tick() {
    const now = new Date();
    // 用台北時區（process.env.TZ 應已設 Asia/Taipei via D26）
    if (now.getHours() === TARGET_HH && now.getMinutes() === TARGET_MM) {
      runDailyReview();
    }
  }

  // 每分鐘 tick
  setInterval(tick, 60 * 1000);
  console.log('[daily-review] cron scheduler 已啟用 (每 23:55 台北時間)');
}

module.exports = { runDailyReview, startCron };
