// src/routes/reports.js
// M2 報表 / 儀表板.
// 規格書 §1.3 v1 範圍: 儀表板 KPI、損益圖、利潤分析、年度損益表、年度分類占比.
//
// 雲 2(2026-10-10,LEO 拍板 1 = A):損益一律依規格書 §5.2「單據類型 × 科目大類」決定正負號,
//   月報 / 年報 / 儀表板 / 區間總額共用同一份 SIGNED_ROWS_CTE,三張報表同月份利潤必相等。
//   沖銷單(type 對調、科目不變、original_date = 原單日期)套同一條自然歸零。
//   金額一律元;numeric 加總,不經浮點累加。

'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const bookCode = require('../utils/bookCode');
const asyncHandler = require('../utils/asyncHandler');

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

async function loadBookMiddleware(req, res, next) {
  const code = (req.params.bookCode || '').toUpperCase();
  if (!bookCode.isValidFormat(code)) {
    return res.status(400).json({ error: '帳本代碼格式不對' });
  }
  const result = await query(
    `SELECT b.id, b.code, bm.role
       FROM books b
       JOIN book_members bm ON bm.book_id = b.id
      WHERE b.code = $1 AND bm.user_id = $2 AND b.is_active = TRUE`,
    [code, req.user.id]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: '找不到這個帳本,或你沒有這個帳本的權限' });
  }
  req.book = { id: result.rows[0].id, code: result.rows[0].code };
  req.bookMember = { role: result.rows[0].role };
  next();
}

const loadBook = asyncHandler(loadBookMiddleware);

// Y21:每日覆核 ack / escalate 限 owner / admin / editor
function requireBookRole(...roles) {
  return (req, res, next) => {
    if (!req.bookMember || !roles.includes(req.bookMember.role)) {
      return res.status(403).json({ error: '你的角色不能做這個' });
    }
    next();
  };
}

// ── Helpers ────────────────────────────────────────────────────────

// R2:月底用當月真正最後一天(以前寫死 31,30 天的月份 PG 直接報錯 → 500)
function monthRange(year, month) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  if (!(y >= 1900 && y <= 2999)) throw Object.assign(new Error('年份不正確'), { status: 400 });
  if (!(m >= 1 && m <= 12)) throw Object.assign(new Error('月份不正確'), { status: 400 });
  const lastDay = new Date(y, m, 0).getDate();
  const mm = String(m).padStart(2, '0');
  const from = `${y}-${mm}-01`;
  const to = `${y}-${mm}-${String(lastDay).padStart(2, '0')}`;
  return { from, to, year: y, month: m };
}

// 真日期檢查(2026-02-30 會被擋,不讓它進 SQL 變 500)
function isRealDate(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(d + 'T00:00:00Z');
  if (isNaN(t.getTime())) return false;
  return t.toISOString().slice(0, 10) === d;
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
 * 規格書 §5.2 正負號矩陣(單式單 income / expense):
 *   income  × t1/t5 → +1      expense × t2/t3 → +1
 *   expense × t1/t5 → −1(4197 銷貨退回、股東提款、收入單的沖銷)
 *   income  × t2/t3 → −1(5197 進貨退回、費用退回、支出單的沖銷)
 *   其他(t4 轉帳)→ 0,不進損益
 * 參數:typeExpr / parentTypeExpr 是 SQL 欄位表達式。
 */
function signedCaseSql(typeExpr, parentTypeExpr) {
  return `CASE
           WHEN ${typeExpr} = 'income'  AND ${parentTypeExpr} IN ('t1','t5') THEN 1
           WHEN ${typeExpr} = 'expense' AND ${parentTypeExpr} IN ('t2','t3') THEN 1
           WHEN ${typeExpr} = 'expense' AND ${parentTypeExpr} IN ('t1','t5') THEN -1
           WHEN ${typeExpr} = 'income'  AND ${parentTypeExpr} IN ('t2','t3') THEN -1
           ELSE 0 END`;
}

// JS 版(小測試用,與 SQL 同一張表)
function signFor(type, parentType) {
  const inc = parentType === 't1' || parentType === 't5';
  const exp = parentType === 't2' || parentType === 't3';
  if (type === 'income' && inc) return 1;
  if (type === 'expense' && exp) return 1;
  if (type === 'expense' && inc) return -1;
  if (type === 'income' && exp) return -1;
  return 0;
}

/**
 * 期間內「每個科目的帶正負號金額」—— 全部報表共用的一份 CTE。
 * 參數:$1 = book_id、$2 = from、$3 = to。
 * 輸出 signed_rows(journal_id, subject_id, eff_date, src, amt)
 *   eff_date = COALESCE(original_date, date):沖銷單歸回原單月份
 *   src      = 沖銷單沒有 external_source,繼承原單的(Y5:區間對帳遇到重結班才不會誤報)
 * 分支:
 *   (1) income / expense → subject_id,金額 × §5.2 矩陣
 *   (2) reclassify N>=2 targets → +target 金額
 *   (3) reclassify N=1 → +amount 到 subject_id
 *   (4) reclassify origin → −amount 到 reclassify_from_subject_id
 *   (5) composite 科目腳 → 腳本身已帶正負號(薪資 6801 +、POS 4191 −…)
 *   transfer 不進(t4 不進損益)。
 */
const SIGNED_ROWS_CTE = `
    base AS (
      SELECT j.id, j.type, j.amount, j.subject_id, j.reclassify_from_subject_id, j.is_composite,
             COALESCE(j.original_date, j.date) AS eff_date,
             COALESCE(j.external_source, o.external_source) AS src
        FROM journal_logs j
        LEFT JOIN journal_logs o ON o.id = j.reverses_id
       WHERE j.book_id = $1
         AND COALESCE(j.original_date, j.date) BETWEEN $2::date AND $3::date
    ),
    signed_rows AS (
      -- (1) income / expense:§5.2 矩陣
      SELECT b.id AS journal_id, b.subject_id, b.eff_date, b.src,
             b.amount * ${signedCaseSql('b.type', 's.parent_type')} AS amt
        FROM base b
        JOIN subjects s ON s.id = b.subject_id
       WHERE b.is_composite = FALSE
         AND b.type IN ('income', 'expense')
      UNION ALL
      -- (2) reclassify N>=2: targets 從 child table 拿
      SELECT b.id, jrt.target_subject_id, b.eff_date, b.src, jrt.amount
        FROM base b
        JOIN journal_reclassify_targets jrt ON jrt.journal_id = b.id
       WHERE b.type = 'reclassify'
      UNION ALL
      -- (3) reclassify N=1 legacy
      SELECT b.id, b.subject_id, b.eff_date, b.src, b.amount
        FROM base b
       WHERE b.type = 'reclassify'
         AND NOT EXISTS (SELECT 1 FROM journal_reclassify_targets jrt WHERE jrt.journal_id = b.id)
      UNION ALL
      -- (4) reclassify origin: −amount
      SELECT b.id, b.reclassify_from_subject_id, b.eff_date, b.src, -b.amount
        FROM base b
       WHERE b.type = 'reclassify'
      UNION ALL
      -- (5) composite 科目腳
      SELECT b.id, l.subject_id, b.eff_date, b.src, l.amount
        FROM base b
        JOIN journal_legs l ON l.journal_log_id = b.id
       WHERE b.is_composite = TRUE
         AND l.subject_id IS NOT NULL
    )`;

/**
 * 期間內各 subject 的淨金額(帶正負號)。
 */
async function getSubjectNetAmounts(bookId, fromDate, toDate) {
  const result = await query(`
    WITH ${SIGNED_ROWS_CTE}
    SELECT s.id AS subject_id, s.code, s.name, s.parent_type, s.display_order,
           COALESCE(SUM(sr.amt), 0)::numeric(15,2) AS amount
      FROM subjects s
      LEFT JOIN signed_rows sr ON sr.subject_id = s.id
     WHERE s.book_id = $1
     GROUP BY s.id, s.code, s.name, s.parent_type, s.display_order
     HAVING COALESCE(SUM(sr.amt), 0) != 0
     ORDER BY s.parent_type, s.display_order, s.code
  `, [bookId, fromDate, toDate]);
  return result.rows;
}

/**
 * 期間內各月份收 / 支(儀表板、年報 12 月趨勢)。
 * 收入 = t1 帶號合計;支出 = t2 + t3 帶號合計;t4 / t5 不進(Y25:股東出資不算營收)。
 * 跟月報同一份 CTE → 同一月份利潤必相等。缺空月份由 caller fill 0。
 */
async function getMonthlyTotals(bookId, fromDate, toDate) {
  const result = await query(`
    WITH ${SIGNED_ROWS_CTE}
    SELECT TO_CHAR(DATE_TRUNC('month', sr.eff_date), 'YYYY-MM') AS month_label,
           COALESCE(SUM(CASE WHEN s.parent_type = 't1' THEN sr.amt ELSE 0 END), 0)::numeric(15,2) AS income,
           COALESCE(SUM(CASE WHEN s.parent_type IN ('t2','t3') THEN sr.amt ELSE 0 END), 0)::numeric(15,2) AS expense
      FROM signed_rows sr
      JOIN subjects s ON s.id = sr.subject_id
     GROUP BY TO_CHAR(DATE_TRUNC('month', sr.eff_date), 'YYYY-MM')
     ORDER BY 1
  `, [bookId, fromDate, toDate]);
  const map = new Map();
  for (const r of result.rows) {
    map.set(r.month_label, { income: r.income, expense: r.expense });
  }
  return map;
}

// ── N5: GET /B/:bookCode/reports/range ────────────────────────────
// 給 reconcile cron / 對外查單一科目區間總額用
// Query params:
//   from=YYYY-MM-DD  to=YYYY-MM-DD  (必填)
//   external_source=leo_pos  (可選 filter;沖銷單繼承原單來源)
//   subject_code=4101  (可選 filter)
async function getRangeTotal(bookId, fromDate, toDate, externalSource, subjectCode) {
  const params = [bookId, fromDate, toDate];
  let sourceClause = '';
  let subjectClause = '';

  if (externalSource) {
    params.push(externalSource);
    sourceClause = `AND sr.src = $${params.length}`;
  }
  if (subjectCode) {
    params.push(subjectCode);
    subjectClause = `AND s.code = $${params.length}`;
  }

  const result = await query(`
    WITH ${SIGNED_ROWS_CTE}
    SELECT
      COALESCE(SUM(sr.amt), 0)::numeric(15,2) AS total,
      COUNT(DISTINCT sr.journal_id) AS journal_count
      FROM signed_rows sr
      JOIN subjects s ON s.id = sr.subject_id
     WHERE TRUE
       ${sourceClause}
       ${subjectClause}
  `, params);

  return result.rows[0];
}

// 期間內交易筆數(G22:用有效日期、不算沖銷單本身)
async function countTransactions(bookId, fromDate, toDate) {
  const r = await query(`
    SELECT COUNT(*)::int AS cnt FROM journal_logs
     WHERE book_id = $1
       AND COALESCE(original_date, date) BETWEEN $2::date AND $3::date
       AND reverses_id IS NULL
  `, [bookId, fromDate, toDate]);
  return r.rows[0].cnt;
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
  const { from: tmFrom, to: endTo } = monthRange(thisYear, thisMonth);

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
  const cnt = await countTransactions(req.book.id, tmFrom, endTo);

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
      transaction_count: cnt,
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

  const cnt = await countTransactions(req.book.id, range.from, range.to);

  res.json({
    year: range.year, month: range.month,
    from: range.from, to: range.to,
    income: { total: f2(incomeTotal), by_subject: t1 },
    cost: { total: f2(costTotal), by_subject: t2 },
    expense: { total: f2(expenseTotal), by_subject: t3 },
    profit: f2(profit),
    transaction_count: cnt,
  });
}));

// ── GET /B/:bookCode/reports/yearly?year= ──────────────────────────────
// 年度損益表 + 12 月趨勢 + 分類占比.
router.get('/B/:bookCode/reports/yearly', loadBook, asyncHandler(async (req, res) => {
  const y = parseInt(req.query.year, 10);
  if (!(y >= 1900 && y <= 2999)) return res.status(400).json({ error: '年份不正確' });

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
// 期間內各 counterparty 累計收 / 支金額(Y28):
//   - 套 §5.2 矩陣(沖銷單相抵,不會變成一收一支)
//   - composite 的科目腳也算(composite 的 counterparty 在 journal_logs 主表)
//   - 停用的對象照樣列出,回 is_active 讓前端標灰(以前整個消失,合計會少)
//   - 回 tax_id(CSV 統編欄)
//   - 日期用有效日期 COALESCE(original_date, date);筆數不算沖銷單本身
router.get('/B/:bookCode/reports/counterparties', loadBook, asyncHandler(async (req, res) => {
  const from = req.query.from;
  const to = req.query.to;
  if (!isRealDate(from) || !isRealDate(to)) {
    return res.status(400).json({ error: '請給正確的開始與結束日期' });
  }
  const result = await query(`
    WITH cp_rows AS (
      SELECT j.counterparty_id AS cp_id, j.id AS journal_id, j.reverses_id, s.parent_type,
             j.amount * ${signedCaseSql('j.type', 's.parent_type')} AS amt
        FROM journal_logs j
        JOIN subjects s ON s.id = j.subject_id
       WHERE j.book_id = $1
         AND j.counterparty_id IS NOT NULL
         AND j.is_composite = FALSE
         AND j.type IN ('income', 'expense')
         AND COALESCE(j.original_date, j.date) BETWEEN $2::date AND $3::date
      UNION ALL
      SELECT j.counterparty_id, j.id, j.reverses_id, s.parent_type, l.amount
        FROM journal_logs j
        JOIN journal_legs l ON l.journal_log_id = j.id
        JOIN subjects s ON s.id = l.subject_id
       WHERE j.book_id = $1
         AND j.counterparty_id IS NOT NULL
         AND j.is_composite = TRUE
         AND COALESCE(j.original_date, j.date) BETWEEN $2::date AND $3::date
    ),
    agg AS (
      SELECT cp.id, cp.name, cp.type, cp.category, cp.tax_id, cp.is_temporary, cp.is_active,
             COALESCE(SUM(CASE WHEN r.parent_type IN ('t1','t5') THEN r.amt END), 0)::numeric(15,2) AS income_total,
             COALESCE(SUM(CASE WHEN r.parent_type IN ('t2','t3') THEN r.amt END), 0)::numeric(15,2) AS expense_total,
             (COUNT(DISTINCT r.journal_id) FILTER (WHERE r.reverses_id IS NULL))::int AS transaction_count
        FROM counterparties cp
        JOIN cp_rows r ON r.cp_id = cp.id
       WHERE cp.book_id = $1
       GROUP BY cp.id, cp.name, cp.type, cp.category, cp.tax_id, cp.is_temporary, cp.is_active
    )
    SELECT * FROM agg
     ORDER BY (ABS(expense_total) + ABS(income_total)) DESC, name
  `, [req.book.id, from, to]);
  res.json({ from, to, counterparties: result.rows });
}));

// ── N5: GET /B/:bookCode/reports/range ─────────────────────────────────
router.get('/B/:bookCode/reports/range', loadBook, asyncHandler(async (req, res) => {
  const { from, to, external_source, subject_code } = req.query;
  if (!isRealDate(from) || !isRealDate(to)) {
    return res.status(400).json({ error: '請給正確的開始與結束日期' });
  }
  const r = await getRangeTotal(req.book.id, from, to,
    external_source ? String(external_source) : null,
    subject_code ? String(subject_code) : null);
  res.json({
    from, to,
    external_source: external_source || null,
    subject_code: subject_code || null,
    total: r.total,
    journal_count: r.journal_count,
  });
}));

// ── D25: GET /B/:bookCode/invoices/by-period?yyyymm=202605 ─────────────
router.get('/B/:bookCode/invoices/by-period', loadBook, asyncHandler(async (req, res) => {
  const yyyymm = req.query.yyyymm;
  if (!yyyymm || !/^\d{6}$/.test(yyyymm)) {
    return res.status(400).json({ error: '請給年月(例如 202605)' });
  }
  const yyyy = yyyymm.slice(0, 4);
  const mm = yyyymm.slice(4, 6);
  if (!(Number(mm) >= 1 && Number(mm) <= 12)) {
    return res.status(400).json({ error: '月份不正確' });
  }
  const fromDate = `${yyyy}-${mm}-01`;
  const lastDay = new Date(Number(yyyy), Number(mm), 0).getDate();
  const toDate = `${yyyy}-${mm}-${String(lastDay).padStart(2, '0')}`;

  const result = await query(`
    SELECT i.*, j.date AS journal_date, j.summary AS journal_summary
      FROM invoices i
      LEFT JOIN journal_logs j ON j.id = i.journal_log_id
     WHERE i.book_id = $1
       AND (i.invoice_period = $2
            OR (i.invoice_period IS NULL AND j.date BETWEEN $3::date AND $4::date))
     ORDER BY j.date, i.id
  `, [req.book.id, yyyymm, fromDate, toDate]);

  const totalAmount = result.rows.reduce((s, r) => s + Number(r.amount), 0);
  const withInvoiceNumber = result.rows.filter(r => r.invoice_number).length;

  res.json({
    period: yyyymm,
    from: fromDate, to: toDate,
    invoice_count: result.rows.length,
    invoice_count_with_number: withInvoiceNumber,
    invoice_count_without_number: result.rows.length - withInvoiceNumber,
    total_amount: totalAmount.toFixed(2),
    invoices: result.rows,
  });
}));

// ── D24: Daily Close Review endpoints ──────────────────────────────────
router.get('/B/:bookCode/daily-review', loadBook, asyncHandler(async (req, res) => {
  const status = req.query.status || 'pending';
  if (!['pending', 'acked', 'escalated', 'all'].includes(status)) {
    return res.status(400).json({ error: '篩選條件不正確' });
  }
  const where = ['dr.book_id = $1'];
  const params = [req.book.id];
  if (status !== 'all') {
    where.push(`dr.status = $${params.length + 1}`);
    params.push(status);
  }
  const result = await query(
    `SELECT dr.*, u.name AS reviewed_by_name
       FROM daily_review_log dr
       LEFT JOIN users u ON u.id = dr.reviewed_by_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY dr.review_date DESC LIMIT 90`,
    params
  );
  res.json({ daily_reviews: result.rows, count: result.rows.length });
}));

router.get('/B/:bookCode/daily-review/:date', loadBook, asyncHandler(async (req, res) => {
  const date = req.params.date;
  if (!isRealDate(date)) return res.status(400).json({ error: '日期不正確' });
  const drRes = await query(
    `SELECT dr.*, u.name AS reviewed_by_name
       FROM daily_review_log dr
       LEFT JOIN users u ON u.id = dr.reviewed_by_user_id
      WHERE dr.book_id = $1 AND dr.review_date = $2::date`,
    [req.book.id, date]
  );
  if (drRes.rows.length === 0) return res.status(404).json({ error: '這天沒有覆核紀錄' });
  const dr = drRes.rows[0];
  // 展開 journal_log_ids 詳情
  const ids = Array.isArray(dr.journal_log_ids) ? dr.journal_log_ids : [];
  let journals = [];
  if (ids.length > 0) {
    const jRes = await query(
      `SELECT id, date, type, amount, summary, external_source, external_id, is_composite,
              triggered_by_external_emp_id
         FROM journal_logs WHERE id = ANY($1::bigint[]) AND book_id = $2
         ORDER BY id`,
      [ids, req.book.id]
    );
    journals = jRes.rows;
  }
  res.json({ daily_review: dr, journals });
}));

// Y21:限 owner / admin / editor;Y36②:升級(escalated)後也能確認
router.post('/B/:bookCode/daily-review/:date/ack',
  requireAuth, loadBook, requireBookRole('owner', 'admin', 'editor'),
  asyncHandler(async (req, res) => {
    const date = req.params.date;
    if (!isRealDate(date)) return res.status(400).json({ error: '日期不正確' });
    const rawNote = req.body && req.body.note;
    const note = (typeof rawNote === 'string' && rawNote.trim()) ? rawNote.trim().slice(0, 500) : null;
    const r = await query(
      `UPDATE daily_review_log
          SET status = 'acked',
              reviewed_by_user_id = $1,
              reviewed_at = NOW(),
              ack_note = $2
        WHERE book_id = $3 AND review_date = $4::date AND status IN ('pending', 'escalated')
        RETURNING *`,
      [req.user.id, note, req.book.id, date]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: '這天沒有待確認的覆核(可能已經確認過了)' });
    res.json({ ok: true, daily_review: r.rows[0] });
  }));

router.post('/B/:bookCode/daily-review/:date/escalate',
  requireAuth, loadBook, requireBookRole('owner', 'admin', 'editor'),
  asyncHandler(async (req, res) => {
    const date = req.params.date;
    if (!isRealDate(date)) return res.status(400).json({ error: '日期不正確' });
    const r = await query(
      `UPDATE daily_review_log
          SET status = 'escalated', escalated_at = NOW()
        WHERE book_id = $1 AND review_date = $2::date AND status = 'pending'
        RETURNING *`,
      [req.book.id, date]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: '這天沒有待確認的覆核(可能已經處理過了)' });
    res.json({ ok: true, daily_review: r.rows[0] });
  }));

// error handler for status-tagged errors
router.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
});

module.exports = router;
// 純函式(scratchpad 小測試用)
module.exports.pure = { monthRange, signFor, signedCaseSql, isRealDate };
