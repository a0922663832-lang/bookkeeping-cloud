// src/routes/reports.js
// M2 報表 / 儀表板.
// 規格書 §1.3 v1 範圍: 儀表板 KPI、損益圖、利潤分析、年度損益表、年度分類占比.

'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const bookCode = require('../utils/bookCode');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// auth required EXCEPT /internal/* (webhook endpoints use X-Posting-Token instead)
router.use((req, res, next) => {
  if (req.url.includes('/internal/')) return next();
  return requireAuth(req, res, next);
});

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
  next();
}

const loadBook = asyncHandler(loadBookMiddleware);

// ── Helpers ────────────────────────────────────────────────────────

function monthRange(year, month) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  if (!(y >= 1900 && y <= 2999)) throw Object.assign(new Error('invalid year'), { status: 400 });
  if (!(m >= 1 && m <= 12)) throw Object.assign(new Error('invalid month'), { status: 400 });
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const to = `${y}-${String(m).padStart(2, '0')}-31`;
  return { from, to, year: y, month: m };
}

function monthLabel(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function num(v) {
  return parseFloat(v || 0);
}

function f2(v) {
  return num(v).toFixed(2);
}

/**
 * 期間內各 subject 的淨金額 (考慮 reclassify 1:1 + 1:N).
 * 規格書 §3.2.7 + M1 階段 1d (2026-05-13) reclassify 語意:
 *   - target subject(s) 視為 +amount
 *     - N=1 legacy: target = journal_logs.subject_id, amount = journal_logs.amount
 *     - N>=2: 每個 target 從 journal_reclassify_targets.amount 拿,
 *             journal_logs.subject_id 不重複計入(由 NOT EXISTS 防 double-count)
 *   - origin subject (reclassify_from_subject_id) 視為 -journal_logs.amount
 *   - income / expense 直接記到 subject_id 為 +amount
 */
async function getSubjectNetAmounts(bookId, fromDate, toDate) {
  const result = await query(`
    WITH subject_amounts AS (
      -- income / expense → subject_id +amount
      SELECT subject_id, SUM(amount) AS amt
        FROM journal_logs
       WHERE book_id = $1 AND date BETWEEN $2::date AND $3::date
         AND type IN ('income', 'expense')
       GROUP BY subject_id
      UNION ALL
      -- reclassify N>=2: targets 從 child table 拿
      SELECT jrt.target_subject_id AS subject_id, SUM(jrt.amount) AS amt
        FROM journal_reclassify_targets jrt
        JOIN journal_logs j ON j.id = jrt.journal_id
       WHERE j.book_id = $1 AND j.date BETWEEN $2::date AND $3::date
         AND j.type = 'reclassify'
       GROUP BY jrt.target_subject_id
      UNION ALL
      -- reclassify N=1 legacy: 沒 child row 的 journal 從 journal_logs 自己拿
      SELECT j.subject_id, SUM(j.amount) AS amt
        FROM journal_logs j
       WHERE j.book_id = $1 AND j.date BETWEEN $2::date AND $3::date
         AND j.type = 'reclassify'
         AND NOT EXISTS (
           SELECT 1 FROM journal_reclassify_targets jrt WHERE jrt.journal_id = j.id
         )
       GROUP BY j.subject_id
      UNION ALL
      -- reclassify origin: 統一 -SUM(journal_logs.amount) by from_subject
      SELECT reclassify_from_subject_id AS subject_id, -SUM(amount) AS amt
        FROM journal_logs
       WHERE book_id = $1 AND date BETWEEN $2::date AND $3::date
         AND type = 'reclassify'
       GROUP BY reclassify_from_subject_id
    )
    SELECT s.id AS subject_id, s.code, s.name, s.parent_type, s.display_order,
           COALESCE(SUM(sa.amt), 0)::numeric(15,2) AS amount
      FROM subjects s
      LEFT JOIN subject_amounts sa ON sa.subject_id = s.id
     WHERE s.book_id = $1
     GROUP BY s.id, s.code, s.name, s.parent_type, s.display_order
     HAVING COALESCE(SUM(sa.amt), 0) != 0
     ORDER BY s.parent_type, s.display_order, s.code
  `, [bookId, fromDate, toDate]);
  return result.rows;
}

/**
 * 期間內所有月份的收 / 支 SUM (簡化,只看 income/expense type,不細到 subject).
 * 缺空月份 — 由 caller fill 預設 0.
 */
async function getMonthlyTotals(bookId, fromDate, toDate) {
  const result = await query(`
    SELECT
      TO_CHAR(DATE_TRUNC('month', date), 'YYYY-MM') AS month_label,
      COALESCE(SUM(CASE WHEN type='income' THEN amount END), 0)::numeric(15,2) AS income,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount END), 0)::numeric(15,2) AS expense
      FROM journal_logs
     WHERE book_id = $1 AND date BETWEEN $2::date AND $3::date
     GROUP BY DATE_TRUNC('month', date)
     ORDER BY DATE_TRUNC('month', date)
  `, [bookId, fromDate, toDate]);
  const map = new Map();
  for (const r of result.rows) {
    map.set(r.month_label, { income: r.income, expense: r.expense });
  }
  return map;
}

// ── GET /B/:bookCode/reports/dashboard ─────────────────────────────────
// 本月概覽 + 近 6 月趨勢 + 帳戶餘額.
router.get('/B/:bookCode/reports/dashboard', loadBook, asyncHandler(async (req, res) => {
  const now = new Date();
  const thisYear = now.getFullYear();
  const thisMonth = now.getMonth() + 1;

  // 計算 6 月窗口
  let startY = thisYear; let startM = thisMonth - 5;
  while (startM <= 0) { startY--; startM += 12; }
  const startFrom = `${startY}-${String(startM).padStart(2, '0')}-01`;
  const { to: endTo } = monthRange(thisYear, thisMonth);

  // 一次拿 6 個月資料
  const monthlyMap = await getMonthlyTotals(req.book.id, startFrom, endTo);

  // 6 月 array (空月份 fill 0)
  const trend = [];
  for (let i = 0; i < 6; i++) {
    let y = startY; let m = startM + i;
    while (m > 12) { y++; m -= 12; }
    const label = monthLabel(y, m);
    const data = monthlyMap.get(label) || { income: '0.00', expense: '0.00' };
    trend.push({
      month: label,
      income: data.income,
      expense: data.expense,
      profit: f2(num(data.income) - num(data.expense)),
    });
  }

  // 本月 (= trend 最後一筆)
  const thisMonthData = trend[trend.length - 1];

  // 本月交易數
  const { from: tmFrom, to: tmTo } = monthRange(thisYear, thisMonth);
  const cntRes = await query(`
    SELECT COUNT(*)::int AS cnt FROM journal_logs
     WHERE book_id = $1 AND date BETWEEN $2::date AND $3::date
  `, [req.book.id, tmFrom, tmTo]);

  // 各帳戶餘額 + 全帳戶總和
  const accRes = await query(`
    SELECT id, name, type, current_balance::numeric(15,2) AS current_balance
      FROM ag_accounts
     WHERE book_id = $1 AND is_active = TRUE
     ORDER BY display_order, name
  `, [req.book.id]);
  const totalBalance = accRes.rows.reduce((s, a) => s + num(a.current_balance), 0);

  res.json({
    month: monthLabel(thisYear, thisMonth),
    this_month: {
      income: thisMonthData.income,
      expense: thisMonthData.expense,
      profit: thisMonthData.profit,
      transaction_count: cntRes.rows[0].cnt,
    },
    trend_6m: trend,
    accounts: accRes.rows,
    total_balance: f2(totalBalance),
  });
}));

// ── GET /B/:bookCode/reports/monthly?year=&month= ──────────────────────
// 某月詳細: 收入 / 成本 / 費用 各 subject 細項 + 月損益.
router.get('/B/:bookCode/reports/monthly', loadBook, asyncHandler(async (req, res) => {
  const range = monthRange(req.query.year, req.query.month);

  const breakdown = await getSubjectNetAmounts(req.book.id, range.from, range.to);

  const t1 = breakdown.filter(r => r.parent_type === 't1');
  const t2 = breakdown.filter(r => r.parent_type === 't2');
  const t3 = breakdown.filter(r => r.parent_type === 't3');

  const sumAmt = arr => arr.reduce((s, r) => s + num(r.amount), 0);
  const incomeTotal = sumAmt(t1);
  const costTotal = sumAmt(t2);
  const expenseTotal = sumAmt(t3);
  const profit = incomeTotal - costTotal - expenseTotal;

  const cntRes = await query(`
    SELECT COUNT(*)::int AS cnt FROM journal_logs
     WHERE book_id = $1 AND date BETWEEN $2::date AND $3::date
  `, [req.book.id, range.from, range.to]);

  res.json({
    year: range.year, month: range.month,
    from: range.from, to: range.to,
    income: { total: f2(incomeTotal), by_subject: t1 },
    cost: { total: f2(costTotal), by_subject: t2 },
    expense: { total: f2(expenseTotal), by_subject: t3 },
    profit: f2(profit),
    transaction_count: cntRes.rows[0].cnt,
  });
}));

// ── GET /B/:bookCode/reports/yearly?year= ──────────────────────────────
// 年度損益表 + 12 月趨勢 + 分類占比.
router.get('/B/:bookCode/reports/yearly', loadBook, asyncHandler(async (req, res) => {
  const y = parseInt(req.query.year, 10);
  if (!(y >= 1900 && y <= 2999)) return res.status(400).json({ error: 'invalid year' });

  const yearFrom = `${y}-01-01`;
  const yearTo = `${y}-12-31`;
  const monthlyMap = await getMonthlyTotals(req.book.id, yearFrom, yearTo);

  // 12 月 array
  const monthly = [];
  for (let m = 1; m <= 12; m++) {
    const label = monthLabel(y, m);
    const data = monthlyMap.get(label) || { income: '0.00', expense: '0.00' };
    monthly.push({
      month: m,
      income: data.income,
      expense: data.expense,
      profit: f2(num(data.income) - num(data.expense)),
    });
  }

  // 全年分類占比
  const breakdown = await getSubjectNetAmounts(req.book.id, yearFrom, yearTo);
  const t1 = breakdown.filter(r => r.parent_type === 't1');
  const t2 = breakdown.filter(r => r.parent_type === 't2');
  const t3 = breakdown.filter(r => r.parent_type === 't3');

  const sumAmt = arr => arr.reduce((s, r) => s + num(r.amount), 0);
  const totalIncome = sumAmt(t1);
  const totalCost = sumAmt(t2);
  const totalExpense = sumAmt(t3);
  const totalProfit = totalIncome - totalCost - totalExpense;

  const withPercent = (arr, denom) => arr.map(r => ({
    ...r,
    percent: denom > 0 ? +((num(r.amount) / denom) * 100).toFixed(2) : 0,
  }));

  res.json({
    year: y,
    monthly,
    summary: {
      total_income: f2(totalIncome),
      total_cost: f2(totalCost),
      total_expense: f2(totalExpense),
      total_profit: f2(totalProfit),
    },
    income_breakdown: withPercent(t1, totalIncome),
    cost_breakdown: withPercent(t2, totalCost),
    expense_breakdown: withPercent(t3, totalExpense),
  });
}));

// ── GET /B/:bookCode/reports/counterparties?from=&to= ──────────────────
// 期間內各 counterparty 累計收 / 支金額.
router.get('/B/:bookCode/reports/counterparties', loadBook, asyncHandler(async (req, res) => {
  const from = req.query.from;
  const to = req.query.to;
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'from and to required (YYYY-MM-DD)' });
  }
  const result = await query(`
    SELECT cp.id, cp.name, cp.type, cp.category, cp.is_temporary,
           COALESCE(SUM(CASE WHEN j.type = 'income' THEN j.amount END), 0)::numeric(15,2) AS income_total,
           COALESCE(SUM(CASE WHEN j.type = 'expense' THEN j.amount END), 0)::numeric(15,2) AS expense_total,
           COUNT(j.id)::int AS transaction_count
      FROM counterparties cp
      LEFT JOIN journal_logs j ON j.counterparty_id = cp.id
        AND j.date BETWEEN $2::date AND $3::date
     WHERE cp.book_id = $1 AND cp.is_active = TRUE
     GROUP BY cp.id, cp.name, cp.type, cp.category, cp.is_temporary
     HAVING COUNT(j.id) > 0
     ORDER BY (COALESCE(SUM(CASE WHEN j.type = 'expense' THEN j.amount END), 0)
             + COALESCE(SUM(CASE WHEN j.type = 'income' THEN j.amount END), 0)) DESC
  `, [req.book.id, from, to]);
  res.json({ from, to, counterparties: result.rows });
}));

// error handler for status-tagged errors
router.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
});

module.exports = router;
