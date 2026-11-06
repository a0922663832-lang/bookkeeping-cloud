// scripts/test_reports_smooth.js
// 月報 smooth=1(兩個月一期的費用平均顯示)的純函式單測 + 「沒帶 smooth 回傳不變」的假 db 路由測試。
// 不需要 PostgreSQL / express / bcrypt:載入 reports.js 時把這幾個模組換成空殼。
//   node scripts/test_reports_smooth.js        全過 exit 0,有紅 exit 1

'use strict';

const Module = require('module');

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`); }
}
function eq(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), name, { actual, expected });
}

// ── 載入 reports.js 用的空殼(Router 會記下 get 的 handler,後面直接呼叫月報) ──
const routes = {};
const fakeRouter = new Proxy({}, {
  get: (t, k) => {
    if (k === 'get') return (p, ...h) => { routes['GET ' + p] = h; };
    if (k in t) return t[k];
    return () => undefined;
  },
});
const queries = [];
let queryImpl = async () => ({ rows: [] });
const stubs = {
  express: Object.assign(() => ({}), { Router: () => fakeRouter }),
  bcrypt: {},
  jsonwebtoken: {},
  pg: { Pool: function Pool() {} },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  const from = (parent && parent.filename) || '';
  if (/(^|[\\/])db(\.js)?$/.test(request) && /[\\/]src[\\/]/.test(from)) {
    return { query: (sql, params) => { queries.push({ sql, params }); return queryImpl(sql, params); }, withTransaction: async () => ({}) };
  }
  if (/(^|[\\/])auth(\.js)?$/.test(request) && /[\\/]src[\\/]/.test(from)) {
    return { requireAuth: (req, res, next) => next && next() };
  }
  return realLoad.apply(this, arguments);
};

const reports = require('../src/routes/reports.js');
const { allocateByDays, estimateForSeries, smoothMonthly } = reports.pure;

const sumCents = (segs) => segs.reduce((s, x) => s + x.cents, 0);

console.log('\n── 攤分 allocateByDays');
{
  const segs = allocateByDays(853200, '2026-09-10', '2026-11-09');   // 8,532 元 = 853200 分
  eq(segs.map(s => [s.ym, s.days]), [['2026-09', 21], ['2026-10', 31], ['2026-11', 9]], '9/10~11/9:21 / 31 / 9 天(共 61 天)');
  ok(segs.every(s => s.cents % 100 === 0), '各月都是整數元', segs);
  eq(sumCents(segs), 853200, '三個月加總 = 8,532');
  eq(segs.map(s => s.cents / 100), [2937, 4336, 1259], '9 月 2,937 / 10 月 4,336 / 11 月(餘數)1,259');
  const one = allocateByDays(100000, '2026-09-01', '2026-09-30');
  eq(one, [{ ym: '2026-09', days: 30, cents: 100000 }], '跨單月(9/1~9/30)全在 9 月');
  const day = allocateByDays(5000, '2026-09-15', '2026-09-15');
  eq(day, [{ ym: '2026-09', days: 1, cents: 5000 }], '起訖同一天也對');
  const yr = allocateByDays(1200000, '2026-12-15', '2027-01-14');
  eq(yr.map(s => s.ym), ['2026-12', '2027-01'], '跨年');
  eq(sumCents(yr), 1200000, '跨年加總不變');
  eq(allocateByDays(100, '2026-09-30', '2026-09-01'), null, '起訖顛倒 → null');
  eq(allocateByDays(100, '2026-02-30', '2026-03-01'), null, '不存在的日期 → null');
  eq(allocateByDays(0, '2026-09-01', '2026-09-30'), null, '金額 0 → null');
  // 隨機:加總恆等於原額
  let allSum = true;
  for (let i = 0; i < 200; i++) {
    const cents = (1 + Math.floor(Math.random() * 99999)) * 100;
    const len = 1 + Math.floor(Math.random() * 120);
    const a = new Date(Date.UTC(2026, 0, 1) + Math.floor(Math.random() * 300) * 86400000);
    const b = new Date(a.getTime() + (len - 1) * 86400000);
    const s = allocateByDays(cents, a.toISOString().slice(0, 10), b.toISOString().slice(0, 10));
    if (!s || sumCents(s) !== cents) { allSum = false; break; }
  }
  ok(allSum, '隨機 200 組:各月加總恆 = 原額');
}

console.log('\n── 估算 estimateForSeries');
{
  const hist12 = {};
  for (let i = 1; i <= 12; i++) hist12[`2026-${String(i).padStart(2, '0')}`] = 100000 + i * 1000 * 100;   // 1,100 ~ 2,200 元
  // 本月 2027-01,過去 12 個月 = 2026-01 ~ 2026-12
  const avg = Math.round(Object.values(hist12).reduce((a, b) => a + b, 0) / 12 / 100) * 100;
  eq(estimateForSeries(hist12, '2027-01', '2027-01'), avg, '12 個月歷史 → 平均');
  eq(estimateForSeries({ '2026-10': 300000, '2026-11': 400000, '2026-12': 350000 }, '2027-01', '2027-01'), 350000, '只有 3 個月歷史也算');
  eq(estimateForSeries({}, '2027-01', '2027-01'), 0, '沒歷史不估');
  eq(estimateForSeries({ '2026-12': 400000, '2027-01': 100 }, '2027-01', '2027-01'), 0, '本月有攤到就不估');
  eq(estimateForSeries(hist12, '2027-03', '2027-02'), 0, '未來月份不估');
  eq(estimateForSeries({ '2025-11': 500000 }, '2027-01', '2027-01'), 0, '超過 12 個月前的不算歷史');
  eq(estimateForSeries({ '2026-12': 100050 }, '2027-01', '2027-01'), 100100, '平均四捨五入到整數元');
}

console.log('\n── smoothMonthly 組合');
{
  const note = (acct, s, e, extra) => JSON.stringify(Object.assign({ fixed_cost: { bill_id: 1, account_no: acct }, period: { start: s, end: e }, source: 'fixed_cost' }, extra || {}));
  const mk = (id, sid, code, amount, eff, n, summary) => ({ id, subject_id: sid, code, name: code === '6201' ? '水電瓦斯' : '電信網路', display_order: code === '6201' ? 220 : 225, amount, summary: summary || '台電', note: n, eff_date: eff });
  // 電費:9/10~11/9 共 8,532,11/20 入帳(有效日期 11 月);前一期 7/10~9/9 共 6,100,9/20 入帳
  const rows = [
    mk(1, 10, '6201', '8532.00', '2026-11-20', note('0123', '2026-09-10', '2026-11-09')),
    mk(2, 10, '6201', '6100.00', '2026-09-20', note('0123', '2026-07-10', '2026-09-09')),
    mk(3, 10, '6201', '999.00', '2026-10-05', 'not json {'),
    mk(4, 10, '6201', '50.00', '2026-10-06', '純文字備註'),
    mk(5, 10, '6201', '70.00', '2026-10-07', JSON.stringify({ foo: 1 })),
  ];
  const base11 = [{ subject_id: 10, code: '6201', name: '水電瓦斯', parent_type: 't3', display_order: 220, amount: '8532.00' }];
  const r11 = smoothMonthly(base11, rows, 2026, 11, '2026-11');
  eq(r11.by_subject[0].amount, '1259.00', '11 月:原 8,532(11/20 入帳)換成攤到本月的 1,259');
  eq(r11.smoothing.bills.map(b => [b.journal_id, b.allocated_this_month]), [[1, '1259.00']], '明細只列與本月有關的那一張');
  eq(r11.smoothing.estimates, [], '11 月有攤到 → 不估');
  eq(r11.deltaCents, -853200 + 125900, 'deltaCents');

  // 10 月:沒有任何單的有效日期在 10 月(3/4/5 非 period),但 #1 攤到 4,336,#2 攤到 0
  const r10 = smoothMonthly([], rows, 2026, 10, '2026-11');
  eq(r10.by_subject.map(r => [r.code, r.amount]), [['6201', '4336.00']], '10 月:原本沒有水電列 → 新增,金額 4,336');
  eq(r10.smoothing.estimates, [], '10 月有攤到 → 不估');

  // 12 月(今天 = 12 月):沒攤到、歷史有 → 估算
  const r12 = smoothMonthly([], rows, 2026, 12, '2026-12');
  ok(r12.smoothing.estimates.length === 1 && r12.smoothing.estimates[0].basis === 'avg12' && r12.smoothing.estimates[0].account_no === '0123', '12 月:本月帳單還沒到 → 估算', r12.smoothing);
  const hist = smoothMonthly([], rows, 2026, 12, '2026-12').smoothing.estimates[0].amount;
  ok(/^\d+\.00$/.test(hist), '估算是整數元字串', hist);
  eq(r12.by_subject[0].amount, hist, '估算加進科目金額');
  // 12 月但今天還在 11 月 → 未來月份不估
  eq(smoothMonthly([], rows, 2026, 12, '2026-11').smoothing.estimates, [], '本月 > 今天所在月份 → 不估');
  // 沒 account_no 的單不形成估算系列
  const noAcc = [mk(9, 10, '6201', '1000.00', '2026-10-20', JSON.stringify({ period: { start: '2026-09-01', end: '2026-10-31' } }))];
  eq(smoothMonthly([], noAcc, 2026, 12, '2026-12').smoothing.estimates, [], '沒電號的單不估');
  // 主系統真實格式:支出單自己的 note 是 JSON 字串,被包在 noteObj.note 裡(buildExpenseJournal)
  const nested = JSON.stringify({ note: JSON.stringify({ fixed_cost: { bill_id: 7, account_no: '0777' } }), period: { start: '2026-09-10', end: '2026-11-09' }, source: 'fixed_cost' });
  const nestRows = [mk(11, 10, '6201', '8532.00', '2026-11-20', nested)];
  const rn = smoothMonthly([], nestRows, 2026, 12, '2026-12');
  ok(rn.smoothing.estimates.length === 1 && rn.smoothing.estimates[0].account_no === '0777', '主系統包兩層的 note 也認得出電號 → 會估算', rn.smoothing);
  // 不同電號各自一個系列
  const two = [
    mk(11, 10, '6201', '1000.00', '2026-10-20', note('A1', '2026-09-01', '2026-10-31')),
    mk(12, 10, '6201', '3000.00', '2026-10-20', note('B2', '2026-09-01', '2026-10-31')),
  ];
  eq(smoothMonthly([], two, 2026, 11, '2026-11').smoothing.estimates.map(e => [e.account_no, e.amount]), [['A1', '500.00'], ['B2', '1500.00']], '兩個電號各估各的');
  // 金額守恆:三個月顯示總額 = 帳單總額
  const t = [9, 10, 11].reduce((s, m) => s + parseFloat(smoothMonthly(m === 11 ? base11 : [], [rows[0]], 2026, m, '2026-11').by_subject.find(r => r.code === '6201').amount), 0);
  eq(t, 8532, '9+10+11 月顯示加總 = 8,532');
}

console.log('\n── 沒帶 smooth:回傳不變、不進攤分邏輯');
(async () => {
  const handlers = routes['GET /B/:bookCode/reports/monthly'];
  ok(!!handlers, '找到月報 route');
  const handler = handlers[handlers.length - 1];
  const t3row = { subject_id: 10, code: '6201', name: '水電瓦斯', parent_type: 't3', display_order: 220, amount: '300.00' };
  queryImpl = async (sql) => {
    if (/WITH\s+\n?\s*base AS/.test(sql) || /signed_rows/.test(sql)) return { rows: [t3row, { subject_id: 1, code: '4101', name: '菜', parent_type: 't1', display_order: 10, amount: '1000.00' }] };
    if (/COUNT\(\*\)::int AS cnt/.test(sql)) return { rows: [{ cnt: 3 }] };
    return { rows: [] };
  };
  async function call(query) {
    queries.length = 0;
    let out = null;
    const req = { book: { id: 1, code: 'NEST0001' }, query, params: {}, user: { id: 1 } };
    const res = { json: (b) => { out = b; }, status() { return res; } };
    await handler(req, res, (e) => { if (e) throw e; });
    return out;
  }
  const noSmooth = await call({ year: '2026', month: '11' });
  ok(!('smoothing' in noSmooth), '沒 smooth:回傳沒有 smoothing key', Object.keys(noSmooth));
  ok(!queries.some(q => /note ~/.test(q.sql)), '沒 smooth:沒有撈費用單 note 的查詢(沒進攤分邏輯)');
  eq(noSmooth.expense, { total: '300.00', by_subject: [t3row] }, '沒 smooth:費用與原本一樣');
  eq(noSmooth.profit, '700.00', '沒 smooth:損益 = 1000 − 300');
  eq(Object.keys(noSmooth), ['year', 'month', 'from', 'to', 'pending', 'closed', 'closed_through', 'income', 'cost', 'expense', 'profit', 'transaction_count'], '沒 smooth:欄位與順序跟改前一致');
  const s0 = await call({ year: '2026', month: '11', smooth: '0' });
  ok(!('smoothing' in s0), 'smooth=0 也不進來');

  const withSmooth = await call({ year: '2026', month: '11', smooth: '1' });
  ok(queries.some(q => /note ~/.test(q.sql)) && queries.some(q => /reversed_by_id IS NULL/.test(q.sql) && /reverses_id IS NULL/.test(q.sql)), 'smooth=1:有撈、且排除沖銷單與被沖銷單');
  ok(withSmooth.smoothing && withSmooth.smoothing.applied === true && Array.isArray(withSmooth.smoothing.bills) && Array.isArray(withSmooth.smoothing.estimates), 'smooth=1:有 smoothing{applied,bills,estimates}');
  eq(withSmooth.expense.total, '300.00', 'smooth=1 但沒有符合的單:費用不變');

  console.log('\n══════════════════════════════');
  console.log(`PASS ${pass}   FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('測試本身出錯:', e); process.exit(2); });
