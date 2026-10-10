// scripts/smoke_golden.js
// 記帳雲 0.15.0 黃金案例 A–G + 止血(409 / 批次核准)端到端測試。**只打 NEST0099 測試帳本**,跑完自清(沖掉測試單)。
// 施工計畫 docs/記帳雲_施工計畫_2026-10-10.md §4.1 / §4.2 / §5.3 第 4 步。
//
// 在雲端 app 容器裡跑(容器裡有簽章密鑰,這支腳本只拿來簽,不印出來):
//   ssh nester@10.0.1.168 "docker exec -i -e SMOKE_EMP=<員工編號> -e SMOKE_PIN=<PIN> bookkeeping-cloud-app node -" < scripts/smoke_golden.js
// 帳號要是 NEST0099 的 owner / admin(沖銷要)。PIN 由 LEO 自己打,不要寫進檔案。
// 可選:SMOKE_VIEWER_TOKEN=<editor 或 viewer 的登入憑證> → 多驗「記帳員不能沖銷」「覆核 ack 權限」。
//
// 判讀:staging 可能有別的資料,報表一律用「跟基準的差值」判斷。

'use strict';

const crypto = require('crypto');

const BASE = process.env.SMOKE_BASE || 'http://localhost:3001';
const BOOK = 'NEST0099';
const B = `/B/${BOOK}`;
const SECRET = process.env.WEBHOOK_HMAC_SECRET || '';
const TS = Date.now();

let pass = 0, fail = 0;
const lines = [];
const ok = (name) => { pass++; lines.push(`  ✓ ${name}`); };
const ng = (name, why) => { fail++; lines.push(`  ✗ ${name} — ${typeof why === 'string' ? why : JSON.stringify(why).slice(0, 300)}`); };
const check = (cond, name, why) => (cond ? ok(name) : ng(name, why));

let TOKEN = '';
const cleanup = [];          // 要沖掉的 journal id

async function call(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  let raw;
  if (body !== undefined) raw = JSON.stringify(body);
  if (opts.signed) {
    const t = String(Date.now());
    headers['X-Timestamp'] = t;
    headers['X-Signature'] = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${t}.${raw || ''}`).digest('hex');
  }
  const r = await fetch(BASE + path, { method, headers, body: raw });
  let data = null;
  try { data = await r.json(); } catch (_) { /* 非 JSON */ }
  return { status: r.status, data: data || {} };
}

const n = (v) => Number(v || 0);
const monthly = (y, m) => call('GET', `${B}/reports/monthly?year=${y}&month=${m}`);
const subjAmt = (rep, code) => {
  for (const k of ['income', 'cost', 'expense']) {
    const hit = (rep.data[k] && rep.data[k].by_subject || []).find((s) => s.code === code);
    if (hit) return n(hit.amount);
  }
  return 0;
};

async function main() {
  if (!SECRET) { console.log('容器裡沒有簽章密鑰,推送類案例會全部失敗 —— 中止'); process.exit(2); }

  // ── 登入 ──
  const login = await call('POST', '/auth/login', { emp_id: process.env.SMOKE_EMP, pin: process.env.SMOKE_PIN }, { token: '' });
  TOKEN = login.data.token || '';
  if (!TOKEN) { console.log('登入失敗:', login.status, login.data.error); process.exit(2); }
  ok('登入');

  const book = await call('GET', B);
  check(book.status === 200 && ['owner', 'admin'].includes(book.data.my_role), `${BOOK} 角色 = owner/admin`, book.data);
  const mode = (book.data.book || {}).posting_mode;

  // ── 主檔 id ──
  const subs = (await call('GET', `${B}/subjects`)).data.subjects || [];
  const accs = (await call('GET', `${B}/accounts`)).data.accounts || [];
  const S = Object.fromEntries(subs.map((s) => [s.code, s.id]));
  const CASH = (accs.find((a) => a.name === '現金袋') || {}).id;
  for (const c of ['6901', '4101', '4109', '4191', '4197', '4408', '5197', '6801', '6802']) {
    if (!S[c]) ng(`科目 ${c} 存在`, '找不到');
  }
  if (!CASH) { ng('帳戶 現金袋 存在', '找不到'); return; }

  // ── G:月底 ──
  for (const [y, m, to] of [[2026, 9, '2026-09-30'], [2026, 11, '2026-11-30'], [2028, 2, '2028-02-29'], [2026, 2, '2026-02-28']]) {
    const r = await monthly(y, m);
    check(r.status === 200 && r.data.to === to, `G 月報 ${y}-${m} → 200,月底 ${to}`, r);
  }
  const dash = await call('GET', `${B}/reports/dashboard`);
  check(dash.status === 200, 'G 儀表板 200', dash);

  const base = await monthly(2026, 9);
  const baseYear = await call('GET', `${B}/reports/yearly?year=2026`);
  const baseProfit = n(base.data.profit);
  check(n((baseYear.data.monthly || [])[8] && baseYear.data.monthly[8].profit) === baseProfit, 'G 基準:月報利潤 = 年報 9 月利潤',
    { monthly: baseProfit, yearly: (baseYear.data.monthly || [])[8] });

  const post = (body) => call('POST', `${B}/journals`, body);
  const reverse = (id, reason, token) => call('POST', `${B}/journals/${id}/reverse`, reason === undefined ? {} : { reason }, { token });

  // ── A:支出 500 → 沖銷 → 歸零 ──
  const a1 = await post({ date: '2026-09-15', type: 'expense', amount: 500, subject_id: S['6901'], transfer_out_account_id: CASH, summary: `smoke A ${TS}` });
  const JA = a1.data.journal && a1.data.journal.id;
  check(a1.status === 201 && JA, 'A1 記支出 500', a1);
  const a2 = await monthly(2026, 9);
  check(n(a2.data.expense.total) - n(base.data.expense.total) === 500, 'A2 月報費用 +500', a2.data.expense);
  if (process.env.SMOKE_VIEWER_TOKEN) {
    const a8 = await reverse(JA, 'x', process.env.SMOKE_VIEWER_TOKEN);
    check(a8.status === 403, 'A8 記帳員 / 唯讀不能沖銷 → 403', a8);
  }
  const a9 = await reverse(JA);
  check(a9.status === 400, 'A9 沒寫原因 → 400', a9);
  const a3 = await reverse(JA, 'smoke A 沖銷');
  const RA = a3.data.reversal && a3.data.reversal.id;
  check(a3.status === 200 && RA && a3.data.original && a3.data.original.reversed_by_id === RA, 'A3 沖銷 → {reversal, original}', a3);
  const a4 = await monthly(2026, 9);
  check(n(a4.data.expense.total) === n(base.data.expense.total) && n(a4.data.profit) === baseProfit, 'A4 沖銷後費用、利潤回到基準', a4.data);
  const a5 = await call('GET', `${B}/reports/yearly?year=2026`);
  check(n(a5.data.monthly[8].profit) === n(a4.data.profit), 'A5 年報 9 月利潤 = 月報', a5.data.monthly[8]);
  check((await reverse(JA, 'x')).status === 409, 'A6 再沖一次 → 409');
  check((await reverse(RA, 'x')).status === 409, 'A7 沖銷單本身不能再沖 → 409');

  // ── B:收入 1000 → 舊入口 DELETE ──
  const b1 = await post({ date: '2026-09-15', type: 'income', amount: 1000, subject_id: S['4101'], transfer_in_account_id: CASH, summary: `smoke B ${TS}` });
  const JB = b1.data.journal && b1.data.journal.id;
  check(b1.status === 201 && JB, 'B1 記收入 1000', b1);
  const b2 = await call('DELETE', `${B}/journals/${JB}`);
  check(b2.status === 200 && b2.data.reversal, 'B2 舊入口 DELETE 走沖銷', b2);
  const b3 = await monthly(2026, 9);
  check(n(b3.data.income.total) === n(base.data.income.total), 'B3 收入回到基準', b3.data.income);

  // ── C:4197 銷貨退回(支出) → 收入 −200 ──
  const c1 = await post({ date: '2026-09-16', type: 'expense', amount: 200, subject_id: S['4197'], transfer_out_account_id: CASH, summary: `smoke C ${TS}` });
  const JC = c1.data.journal && c1.data.journal.id; if (JC) cleanup.push(JC);
  const c2 = await monthly(2026, 9);
  check(n(c2.data.income.total) - n(base.data.income.total) === -200, 'C 4197 銷貨退回 → 收入 −200', c2.data.income);

  // ── D:5197 進貨退回(收入) → 成本 −300 ──
  const d1 = await post({ date: '2026-09-16', type: 'income', amount: 300, subject_id: S['5197'], transfer_in_account_id: CASH, summary: `smoke D ${TS}` });
  const JD = d1.data.journal && d1.data.journal.id; if (JD) cleanup.push(JD);
  const d2 = await monthly(2026, 9);
  check(n(d2.data.cost.total) - n(base.data.cost.total) === -300, 'D 5197 進貨退回 → 成本 −300', d2.data.cost);

  // ── E:薪資複式單 ──
  const payroll = (legs, tag) => ({
    external_source: 'smoke', external_id: `smoke:E:${tag}:${TS}`, event_type: 'payroll_closed',
    payload: { smoke: true },
    proposed_journal: { date: '2026-09-30', type: 'composite', summary: `smoke E 薪資 ${tag}`, legs },
    ensure_accounts: [{ name: '應付勞健保', type: 'liability' }],
  });
  const goodLegs = [
    { kind: 'subject', subject_code: '6801', amount: 30000 },
    { kind: 'subject', subject_code: '6802', amount: 3000 },
    { kind: 'account', account_ref: '玉山銀行', amount: -25000 },
    { kind: 'account', account_ref: '現金袋', amount: -3000 },
    { kind: 'account', account_ref: '應付勞健保', amount: -5000 },
  ];
  const e1 = await call('POST', `${B}/internal/posting`, payroll(goodLegs, 'ok'), { signed: true, token: '' });
  let JE = null;
  if (e1.status === 201) {
    JE = e1.data.journal_id;
    check(e1.data.balance_gap === 0 && e1.data.balance_gap_warning === undefined, 'E1 薪資複式單直接入帳,不平衡差額 0', e1.data);
  } else if (e1.status === 202) {
    const pid = e1.data.pending_journal && e1.data.pending_journal.id;
    const ap = await call('POST', `${B}/pending-journals/${pid}/approve`, { note: 'smoke' });
    JE = ap.data.journal_id || (ap.data.journal && ap.data.journal.id);
    check(ap.status === 200 && JE, 'E1 薪資複式單進待審 → 核准入帳', ap);
    const pj = await call('GET', `${B}/pending-journals/${pid}`);
    const legs = ((pj.data.pending_journal || {}).proposed_journal || {}).legs || [];
    check(legs.filter((l) => l.kind === 'subject').every((l) => l.subject_parent_type === 't3'), 'E1 待審明細帶科目大類', legs);
  } else {
    ng('E1 薪資複式單推送', e1);
  }
  if (JE) {
    cleanup.push(JE);
    const e2 = await call('GET', `${B}/journals/${JE}`);
    check(n(e2.data.journal && e2.data.journal.amount) === 33000, 'E2 單頭金額 = 應發 + 雇主負擔 33,000', e2.data.journal);
    check((e2.data.journal || {}).is_auto_posted === (e1.status === 201), 'E2 自動 / 人工入帳標記正確', e2.data.journal);
    const e3 = await monthly(2026, 9);
    const expDelta = n(e3.data.expense.total) - n(base.data.expense.total);
    check(expDelta === 33000, 'E3 月報費用 +33,000', { expDelta });
    const j1 = await call('PATCH', `${B}/journals/${JE}`, { amount: 1 });
    check(j1.status === 400, 'J1 複式單不能改金額 → 400', j1);
    const j2 = await call('PATCH', `${B}/journals/${JE}`, { summary: `smoke E 改摘要 ${TS}` });
    check(j2.status === 200, 'J2 複式單可改摘要', j2);
    const j3 = await call('GET', `${B}/journals?account_id=${CASH}&from=2026-09-01&to=2026-09-30`);
    check((j3.data.journals || []).some((j) => j.id === JE), 'J3 依帳戶篩選看得到複式單', { count: j3.data.count });
  }
  const bad = goodLegs.map((l) => (l.subject_code === '6802' ? { ...l, amount: 2000 } : l));
  const e4 = await call('POST', `${B}/internal/posting`, payroll(bad, 'gap'), { signed: true, token: '' });
  check(e4.status === 422 && /借貸不平衡/.test(e4.data.error || ''), 'E4 不平衡 → 422 白話', e4);
  const e5 = await call('POST', `${B}/internal/posting`, payroll(goodLegs.map((l, i) => (i === 0 ? { ...l, amount: 1.5 } : l)), 'dec'), { signed: true, token: '' });
  check(e5.status === 422, 'E5 複式腳小數 → 422', e5);
  const e6 = await call('POST', `${B}/internal/posting`, payroll(goodLegs.map((l, i) => (i === 0 ? { ...l, subject_code: '9999' } : l)), 'nosub'), { signed: true, token: '' });
  check(e6.status === 422, 'E6 科目代碼不存在 → 收件就 422', e6);
  const e7 = await call('POST', `${B}/internal/posting`, { ...payroll(goodLegs, 'date'), proposed_journal: { ...payroll(goodLegs, 'date').proposed_journal, date: '2026-02-30' } }, { signed: true, token: '' });
  check(e7.status === 422, 'E7 不存在的日期 → 422', e7);

  // ── F:reclassify 1:N → 沖銷 → 四科目歸零 ──
  const f1 = await post({ date: '2026-09-17', type: 'reclassify', reclassify_from_subject_id: S['4408'],
    targets: [{ subject_id: S['4101'], amount: 300 }, { subject_id: S['4109'], amount: 150 }, { subject_id: S['4191'], amount: 50 }],
    summary: `smoke F ${TS}` });
  const JF = f1.data.journal && f1.data.journal.id;
  check(f1.status === 201 && JF, 'F1 重分類 1:N', f1);
  const f2 = await monthly(2026, 9);
  check(subjAmt(f2, '4101') - subjAmt(base, '4101') === 300 && subjAmt(f2, '4408') - subjAmt(base, '4408') === -500,
    'F2 4101 +300、4408 −500', { a4101: subjAmt(f2, '4101'), a4408: subjAmt(f2, '4408') });
  const f3 = await reverse(JF, 'smoke F');
  check(f3.status === 200 && f3.data.reversal, 'F3 沖銷重分類', f3);
  const f5 = await monthly(2026, 9);
  check(['4101', '4109', '4191', '4408'].every((c) => subjAmt(f5, c) === subjAmt(base, c)), 'F5 四科目回到基準',
    ['4101', '4109', '4191', '4408'].map((c) => [c, subjAmt(f5, c) - subjAmt(base, c)]));

  // ── §4.1:supersede base 還沒到 → 409;base 到了 → 200 ──
  const voidId = `smoke:void:${TS}`;
  const sup = { external_source: 'smoke', base_external_id: voidId, action: 'void', reason: 'smoke' };
  const s1 = await call('POST', `${B}/internal/supersede`, sup, { signed: true, token: '' });
  check(s1.status === 409 && s1.data.code === 'base_not_found', 'S1 原單沒到就作廢 → 409', s1);
  const s2 = await call('POST', `${B}/internal/posting`, {
    external_source: 'smoke', external_id: voidId, event_type: 'expense.created', payload: { smoke: true },
    proposed_journal: { date: '2026-09-18', type: 'expense', amount: 100, subject_code: '6901', transfer_out_account_ref: '現金袋', summary: `smoke S ${TS}` },
  }, { signed: true, token: '' });
  check([201, 202].includes(s2.status), 'S2 原單送到', s2);
  const s3 = await call('POST', `${B}/internal/supersede`, sup, { signed: true, token: '' });
  check(s3.status === 200, 'S3 原單到了再作廢 → 200', s3);

  // ── 批次核准 / 退回加鎖(要 review 模式才有待審) ──
  const p = async (tag) => call('POST', `${B}/internal/posting`, {
    external_source: 'smoke', external_id: `smoke:P:${tag}:${TS}`, event_type: 'expense.created', payload: { smoke: true },
    proposed_journal: { date: '2026-09-19', type: 'expense', amount: 10, subject_code: '6901', transfer_out_account_ref: '現金袋', summary: `smoke P${tag} ${TS}` },
  }, { signed: true, token: '' });
  const p1 = await p('1'); const p2 = await p('2');
  if (p1.status === 202 && p2.status === 202) {
    const P1 = p1.data.pending_journal.id, P2 = p2.data.pending_journal.id;
    const rj = await call('POST', `${B}/pending-journals/${P2}/reject`, { rejected_reason: 'smoke' });
    check(rj.status === 200, 'P1 退回一筆', rj);
    const bt = await call('POST', `${B}/pending-journals/approve-batch`, { ids: [P1, P2], note: 'smoke' });
    const rs = bt.data.results || [];
    const r1 = rs.find((r) => r.id === P1) || {}, r2 = rs.find((r) => r.id === P2) || {};
    check(bt.status === 200 && r1.ok === true && r2.ok === false && r2.error, 'P2 批次核准:一筆成功、一筆說明為什麼沒過', bt.data);
    if (r1.journal_id) {
      cleanup.push(r1.journal_id);
      const pj = await call('GET', `${B}/journals/${r1.journal_id}`);
      check((pj.data.journal || {}).is_auto_posted === false, 'P6 人工核准不標「自動入帳」', pj.data.journal);
    }
    check((await call('POST', `${B}/pending-journals/${P2}/reject`, { rejected_reason: 'x' })).status === 409, 'P4 已處理的再退回 → 409');
  } else {
    ok(`P 批次核准略過(${BOOK} 是 ${mode} 模式,推送直接入帳)`);
    for (const r of [p1, p2]) if (r.data.journal_id) cleanup.push(r.data.journal_id);
  }
  for (const body of [{ ids: [] }, { ids: Array.from({ length: 101 }, (_, i) => i + 1) }, { ids: ['abc'] }]) {
    const r = await call('POST', `${B}/pending-journals/approve-batch`, body);
    check(r.status === 400, `P3 批次核准不合理的勾選 → 400(${JSON.stringify(body).slice(0, 20)}…)`, r);
  }
  const pl = await call('GET', `${B}/pending-journals?limit=1&offset=0`);
  check(pl.status === 200 && typeof pl.data.total === 'number' && pl.data.count <= 1, 'P5 待審分頁回 total', pl.data);
  if (process.env.SMOKE_VIEWER_TOKEN) {
    const r1 = await call('POST', `${B}/daily-review/2026-09-01/ack`, {}, { token: process.env.SMOKE_VIEWER_TOKEN });
    check(r1.status === 403 || r1.status === 401, 'R1 唯讀不能確認每日覆核', r1);
  }

  // ── 收尾:三表一致 ──
  const fin = await monthly(2026, 9);
  const finY = await call('GET', `${B}/reports/yearly?year=2026`);
  check(n(fin.data.profit) === n(finY.data.monthly[8].profit), 'G 結束時月報利潤 = 年報 9 月利潤', { m: fin.data.profit, y: finY.data.monthly[8].profit });
}

async function selfClean() {
  for (const id of cleanup) {
    const r = await call('POST', `${B}/journals/${id}/reverse`, { reason: 'smoke 自清' });
    if (r.status !== 200 && r.status !== 409) lines.push(`  ! 自清 #${id} 失敗:${r.status} ${r.data.error || ''}`);
  }
  // 作廢測試原單(S2)若還在 → supersede 已處理;待審的 smoke 單會留在「已退回 / 已核准」
}

main()
  .catch((e) => ng('腳本例外', e.stack || String(e)))
  .then(selfClean)
  .finally(() => {
    console.log('==========================================');
    console.log(` 記帳雲黃金案例 ${BOOK} @ ${BASE}`);
    console.log('==========================================');
    console.log(lines.join('\n'));
    console.log('==========================================');
    console.log(` PASS: ${pass}    FAIL: ${fail}`);
    process.exitCode = fail === 0 ? 0 : 1;
  });
