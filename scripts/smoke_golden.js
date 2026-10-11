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
//
// 第二輪(docs/記帳雲_施工計畫_第二輪_2026-10-11.md §4.1–§4.8)案例在 round2():
//   會暫時把 NEST0099 的記帳模式改成「進待審」、暫時關帳到 2026-09-30,跑完(含中途出錯)一律改回原本的值。
//   測試帳戶(smoke 開頭)跑完會停用;測試單沖掉或退回。
//   「v1 簽章有 warn」要另外看容器 log:docker logs bookkeeping-cloud-app 2>&1 | grep '收到 v1 簽章'。
//   斷言一律寫「預期的 4xx」或「預期的 2xx」,500 一定算失敗(分得出「擋了」跟「壞了」)。

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
    if (opts.signed === 'v1') {
      // 舊格式(過渡期還收,雲端會 warn)
      headers['X-Signature'] = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${t}.${raw || ''}`).digest('hex');
    } else {
      // v2(第二輪 §4.1):"v2." + ts + "." + METHOD + "." + path + "." + rawBody;path 不含 query
      // opts.signPath:故意簽別的網址(驗「改網址就 401」)
      const signPath = opts.signPath || path.split('?')[0];
      headers['X-Signature-Version'] = '2';
      headers['X-Signature'] = 'sha256=' + crypto.createHmac('sha256', SECRET)
        .update(`v2.${t}.${method.toUpperCase()}.${signPath}.${raw || ''}`).digest('hex');
    }
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

// ============================================================================
// 第二輪 §4.1–§4.8
// ============================================================================
const ymdTaipei = (v) => {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return String(v);
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
};
const todayTaipei = () => ymdTaipei(new Date());
const pushPosting = (body, opts = {}) => call('POST', `${B}/internal/posting`, body, { signed: true, token: '', ...opts });
const pushSupersede = (body) => call('POST', `${B}/internal/supersede`, body, { signed: true, token: '' });
const expensePush = (extId, date, amount, accountRef) => ({
  external_source: 'smoke', external_id: extId, event_type: 'expense.created', payload: { smoke: true },
  proposed_journal: { date, type: 'expense', amount, subject_code: '6901', transfer_out_account_ref: accountRef || '現金袋', summary: `smoke R2 ${extId}` },
});
const pendingIdOf = (r) => (r.data && r.data.pending_journal && r.data.pending_journal.id) || null;
const journalIdOf = (r) => (r.data && (r.data.journal_id || (r.data.journal && r.data.journal.id))) || null;

async function round2() {
  const book0 = await call('GET', B);
  const b0 = book0.data.book || {};
  const role = book0.data.my_role;
  const origMode = b0.posting_mode;
  const origClosed = b0.closed_through === undefined ? null : b0.closed_through;
  check(book0.status === 200 && Object.prototype.hasOwnProperty.call(b0, 'closed_through'), 'K0 帳本詳情回關帳日欄位(migration 018 有跑)', b0);
  if ((b0.posting_mode_per_source || {}).smoke !== undefined) {
    ng('第二輪前提', `${BOOK} 對來源 smoke 有個別記帳模式,這支腳本不動那個設定 → 第二輪略過`);
    return;
  }
  if (origClosed) {
    ng('第二輪前提', `${BOOK} 本來就關帳到 ${origClosed},會擋到 9 月測試單 → 第二輪略過(請老闆先解鎖再跑)`);
    return;
  }

  const subs = (await call('GET', `${B}/subjects`)).data.subjects || [];
  const accs = (await call('GET', `${B}/accounts`)).data.accounts || [];
  const S6901 = (subs.find((s) => s.code === '6901') || {}).id;
  const CASH = (accs.find((a) => a.name === '現金袋') || {}).id;
  const postJ = (body) => call('POST', `${B}/journals`, body);
  const accountsNamed = async (name) => ((await call('GET', `${B}/accounts?include_inactive=1`)).data.accounts || []).filter((a) => a.name === name);

  const pendingsToReject = [];
  const acctsToDisable = [];
  let modeChanged = false;
  let closedChanged = false;
  try {
    // 進待審模式(來源 smoke 沒有個別設定 → 跟著帳本預設)。只用現有的 PATCH /B/:code,不直接改資料庫。
    if (origMode !== 'review') {
      const pm = await call('PATCH', B, { posting_mode: 'review' });
      check(pm.status === 200 && pm.data.book && pm.data.book.posting_mode === 'review', 'R2 暫切「進待審」', pm);
      modeChanged = pm.status === 200;
    }

    // ── §4.1 簽章含網址 ──
    const h1 = await pushPosting(expensePush(`smoke:H1:${TS}`, '2026-09-23', 11));
    check(h1.status === 202, 'H1 v2 簽章 → 收件(202 進待審)', h1);
    if (pendingIdOf(h1)) pendingsToReject.push(pendingIdOf(h1));
    const h2 = await pushPosting(expensePush(`smoke:H2:${TS}`, '2026-09-23', 11), { signPath: '/B/NEST0001/internal/posting' });
    check(h2.status === 401, 'H2 v2 簽的是 NEST0001、送到 NEST0099 → 401', h2);
    const h3 = await pushPosting(expensePush(`smoke:H3:${TS}`, '2026-09-23', 11), { signed: 'v1' });
    check(h3.status === 202, 'H3 v1 舊簽章 → 仍收件(容器 log 要看到「收到 v1 簽章」)', h3);
    if (pendingIdOf(h3)) pendingsToReject.push(pendingIdOf(h3));
    const h4 = await call('POST', '/internal/v1/status-check',
      { book: BOOK, external_source: 'smoke', external_ids: [`smoke:H1:${TS}`] }, { signed: true, token: '' });
    check(h4.status === 200 && ((h4.data.results || [])[0] || {}).status === 'pending', 'H4 對帳狀態查詢 v2 → 200 且查到待審', h4);
    const h5 = await call('POST', '/internal/v1/repush-ack', { id: -1, ok: false, note: 'smoke' }, { signed: true, token: '' });
    check(h5.status === 404, 'H5 補推回報 v2 → 過簽章(假編號回 404,不是 401)', h5);
    const h6 = await call('POST', '/internal/v1/status-check',
      { book: BOOK, external_source: 'smoke', external_ids: ['x'] }, { signed: true, token: '', signPath: '/internal/v1/repush-ack' });
    check(h6.status === 401, 'H6 拿別的入口的簽章來查狀態 → 401', h6);

    // ── §4.6 報表帶待審 ──
    const w0 = await monthly(2026, 9);
    check(w0.status === 200 && w0.data.pending && Number.isInteger(w0.data.pending.count) && Number.isInteger(w0.data.pending.total),
      'W0 月報有待審欄位(整數筆數 / 整數元)', w0.data.pending);
    const w1 = await pushPosting(expensePush(`smoke:W:${TS}`, '2026-09-21', 500));
    check(w1.status === 202, 'W1 推一張 $500 支出進待審', w1);
    const w2 = await monthly(2026, 9);
    const wp0 = w0.data.pending || {}, wp2 = w2.data.pending || {};
    check(w2.status === 200 && wp2.count - wp0.count === 1 && wp2.total - wp0.total === 500, 'W2 月報待審 +1 筆、+$500', { before: wp0, after: wp2 });
    check(n(w2.data.expense && w2.data.expense.total) === n(w0.data.expense && w0.data.expense.total), 'W3 費用合計沒算進待審那筆',
      { before: w0.data.expense, after: w2.data.expense });
    const wy = await call('GET', `${B}/reports/yearly?year=2026`);
    check(wy.status === 200 && wy.data.pending && Number.isInteger(wy.data.pending.count), 'W4 年報有待審欄位', wy.data.pending);
    const wd = await call('GET', `${B}/reports/dashboard`);
    check(wd.status === 200 && wd.data.pending && Number.isInteger(wd.data.pending.count), 'W5 儀表板有待審欄位', wd.data.pending);
    if (pendingIdOf(w1)) {
      const wa = await call('POST', `${B}/pending-journals/${pendingIdOf(w1)}/approve`, { note: 'smoke' });
      check(wa.status === 200 && journalIdOf(wa), 'W6 核准', wa);
      if (journalIdOf(wa)) cleanup.push(journalIdOf(wa));
      const w3 = await monthly(2026, 9);
      check((w3.data.pending || {}).count === wp0.count && n(w3.data.expense.total) - n(w0.data.expense.total) === 500,
        'W7 核准後待審回到基準、費用 +500', { pending: w3.data.pending, expense: w3.data.expense });
    }

    // ── §4.7 手動記帳冪等 ──
    if (S6901 && CASH) {
      const tag = `smoke I ${TS}`;
      const crid = `smoke-${TS}-idem`;
      const ib = { date: '2026-09-22', type: 'expense', amount: 37, subject_id: S6901, transfer_out_account_id: CASH, summary: tag, client_request_id: crid };
      const i1 = await postJ(ib);
      const i2 = await postJ(ib);
      const I1 = i1.data.journal && i1.data.journal.id;
      if (I1) cleanup.push(I1);
      check(i1.status === 201 && I1 && !i1.data.idempotent, 'I1 第一次送出 → 201', i1);
      check(i2.status === 200 && i2.data.idempotent === true && i2.data.journal && i2.data.journal.id === I1, 'I2 同一張表單重送 → 200、同一筆、idempotent', i2);
      const il = await call('GET', `${B}/journals?from=2026-09-22&to=2026-09-22&limit=500`);
      check(il.status === 200 && (il.data.journals || []).filter((j) => j.summary === tag).length === 1, 'I3 帳上只多 1 筆', { count: (il.data.journals || []).filter((j) => j.summary === tag).length });
      const i4 = await postJ({ ...ib, client_request_id: `${crid}-2` });
      const I4 = i4.data.journal && i4.data.journal.id;
      if (I4) cleanup.push(I4);
      check(i4.status === 201 && I4 && I4 !== I1, 'I4 換一張表單 → 多 1 筆', i4);
      const i5 = await postJ({ ...ib, client_request_id: 'x'.repeat(65) });
      check(i5.status === 400 && i5.data.error, 'I5 識別碼太長 → 400 白話', i5);
    } else {
      ng('I 手動記帳冪等', '找不到科目 6901 或帳戶 現金袋');
    }

    // ── §4.4 停用帳戶 → 422 ──
    const offName = `smoke停用${TS}`.slice(0, 50);
    const a1 = await pushPosting({ ...expensePush(`smoke:A1:${TS}`, '2026-09-24', 12, offName), ensure_accounts: [{ name: offName, type: 'cash' }] });
    check(a1.status === 202, 'A1 推送帶新帳戶 → 自動建、收件', a1);
    if (pendingIdOf(a1)) pendingsToReject.push(pendingIdOf(a1));
    const offAcc = (await accountsNamed(offName))[0];
    if (!offAcc) {
      ng('A 停用帳戶', '帳戶沒建出來');
    } else {
      acctsToDisable.push(offAcc.id);
      const off = await call('PATCH', `${B}/accounts/${offAcc.id}`, { is_active: false });
      check(off.status === 200, 'A2 停用帳戶', off);
      const a3 = await pushPosting({ ...expensePush(`smoke:A3:${TS}`, '2026-09-24', 12, offName), ensure_accounts: [{ name: offName, type: 'cash' }] });
      check(a3.status === 422 && (a3.data.error || '').includes(offName) && /已停用/.test(a3.data.error || ''), 'A3 用停用帳戶推送 → 422、文案含帳戶名', a3);
      check((await accountsNamed(offName)).every((a) => a.is_active === false), 'A4 推送沒有把停用的帳戶自動啟用');
      const on = await call('PATCH', `${B}/accounts/${offAcc.id}`, { is_active: true });
      check(on.status === 200, 'A5 重新啟用', on);
      const a6 = await pushPosting(expensePush(`smoke:A6:${TS}`, '2026-09-24', 12, offName));
      check(a6.status === 202, 'A6 啟用後重推 → 收件', a6);
      if (pendingIdOf(a6)) pendingsToReject.push(pendingIdOf(a6));
    }

    // ── §4.3 supersede 補建帳戶 ──
    const newAcc = `smoke應付${TS}`.slice(0, 50);
    const ub = await pushPosting(expensePush(`smoke:U:${TS}`, '2026-09-25', 13));
    check(ub.status === 202, 'U0 原單進待審', ub);
    const uRep = (base, ver) => pushSupersede({
      external_source: 'smoke', base_external_id: base, action: 'replace', reason: 'smoke 4.3', new_external_id: `smoke:U:${TS}@v${ver}`,
      proposed_journal: { date: '2026-09-25', type: 'expense', amount: 13, subject_code: '6901', transfer_out_account_ref: newAcc, summary: `smoke U v${ver}` },
      ensure_accounts: [{ name: newAcc, type: 'liability' }],
    });
    const u1 = await uRep(`smoke:U:${TS}`, 2);
    check(u1.status === 200 && u1.data.new_pending_id, 'U1 改單用到沒有的負債帳戶 → 200(自動建)', u1);
    const nA = await accountsNamed(newAcc);
    check(nA.length === 1 && nA[0].type === 'liability', 'U2 帳戶建出來、類型是負債', nA);
    if (nA[0]) acctsToDisable.push(nA[0].id);
    const u3 = await uRep(`smoke:U:${TS}@v2`, 3);
    check(u3.status === 200 && u3.data.new_pending_id, 'U3 同名再送一次 → 200', u3);
    check((await accountsNamed(newAcc)).length === 1, 'U4 沒有重複建');
    if (u3.data.new_pending_id) pendingsToReject.push(u3.data.new_pending_id);

    // ── §4.2 發票三處 + §4.5 supersede 稽核 ──
    const vLegs = [{ kind: 'subject', subject_code: '4101', amount: 1000 }, { kind: 'account', account_ref: '現金袋', amount: 1000 }];
    const inv = (k) => [
      { external_order_id: `smoke-${TS}-${k}a`, invoice_number: null, invoice_period: null, amount: 600, is_void: false },
      { external_order_id: `smoke-${TS}-${k}b`, invoice_number: null, invoice_period: null, amount: 400, is_void: false },
    ];
    const invOf = async (k) => ((await call('GET', `${B}/invoices/by-period?yyyymm=202609`)).data.invoices || [])
      .filter((i) => String(i.external_order_id || '').startsWith(`smoke-${TS}-${k}`));
    const approveId = async (pid, name) => {
      const r = await call('POST', `${B}/pending-journals/${pid}/approve`, { note: 'smoke' });
      check(r.status === 200 && journalIdOf(r), name, r);
      return journalIdOf(r);
    };
    const v1 = await pushPosting({
      external_source: 'smoke', external_id: `smoke:V:${TS}`, event_type: 'pos_shift_settled', payload: { smoke: true },
      invoices: inv('v1'),
      proposed_journal: { date: '2026-09-26', type: 'composite', summary: `smoke V ${TS} v1`, legs: vLegs },
    });
    check(v1.status === 202, 'V1 待審模式推一張帶 2 張發票的收班', v1);
    const JV1 = pendingIdOf(v1) ? await approveId(pendingIdOf(v1), 'V2 核准') : null;
    const iv1 = await invOf('v1');
    check(JV1 && iv1.length === 2 && iv1.every((i) => i.is_void === false && String(i.journal_log_id) === String(JV1)),
      'V3 核准後發票 2 張、掛在這筆分錄上(以前待審模式會整批不見)', iv1);
    const v4 = await pushSupersede({
      external_source: 'smoke', base_external_id: `smoke:V:${TS}`, action: 'replace', reason: 'smoke 改單',
      new_external_id: `smoke:V:${TS}@v2`, payload: { smoke: true, invoices: inv('v2') },
      proposed_journal: { date: '2026-09-26', type: 'composite', summary: `smoke V ${TS} v2`, legs: vLegs },
    });
    check(v4.status === 200 && v4.data.reversed_journal_id && v4.data.new_pending_id, 'V4 改單 → 沖掉舊版、新版進待審', v4);
    const iv1b = await invOf('v1');
    check(iv1b.length === 2 && iv1b.every((i) => i.is_void === true), 'V5 舊版 2 張發票標作廢', iv1b);
    if (JV1) {
      const hist = await call('GET', `${B}/journals/${JV1}/history`);
      check(hist.status === 200 && (hist.data.events || []).some((e) => e.type === 'reversed' && /自動沖銷/.test(e.reason || '')),
        'V6 改單自動沖銷有寫歷史(原因含「自動沖銷」)', hist.data.events);
    }
    const JV2 = v4.data.new_pending_id ? await approveId(v4.data.new_pending_id, 'V7 新版核准') : null;
    const iv2 = await invOf('v2');
    check(JV2 && iv2.length === 2 && iv2.every((i) => i.is_void === false && String(i.journal_log_id) === String(JV2)), 'V8 新版核准後 2 張新發票', iv2);
    const v9 = await pushSupersede({ external_source: 'smoke', base_external_id: `smoke:V:${TS}@v2`, action: 'void', reason: 'smoke 作廢' });
    check(v9.status === 200 && v9.data.reversed_journal_id, 'V9 作廢 → 200', v9);
    const iv2b = await invOf('v2');
    check(iv2b.length === 2 && iv2b.every((i) => i.is_void === true), 'V10 作廢後發票標作廢', iv2b);
    check((await invOf('v3')).length === 0, 'V11 作廢沒有產生新發票');
    if (JV2) {
      const hist2 = await call('GET', `${B}/journals/${JV2}/history`);
      check(hist2.status === 200 && (hist2.data.events || []).some((e) => e.type === 'reversed' && /自動沖銷/.test(e.reason || '')),
        'V12 作廢自動沖銷有寫歷史', hist2.data.events);
    }

    // ── §4.8 關帳 ──
    if (role !== 'owner') {
      ng('K 關帳', '登入帳號要是 NEST0099 的老闆才能設關帳(管理員不行),關帳案例沒跑');
    } else if (!S6901 || !CASH) {
      ng('K 關帳', '找不到科目 6901 或帳戶 現金袋');
    } else {
      const kj = await postJ({ date: '2026-09-10', type: 'expense', amount: 70, subject_id: S6901, transfer_out_account_id: CASH, summary: `smoke K ${TS}` });
      const KJ = kj.data.journal && kj.data.journal.id;
      check(kj.status === 201 && KJ, 'K1 關帳前先記一張 9/10 的單', kj);
      const kp = await pushPosting(expensePush(`smoke:KP:${TS}`, '2026-09-20', 15));
      check(kp.status === 202, 'K2 關帳前先推一張 9/20 的待審', kp);
      const KP = pendingIdOf(kp);
      if (KP) pendingsToReject.push(KP);

      const tmr = new Date(Date.now() + 36 * 3600 * 1000);
      const kf = await call('PATCH', B, { closed_through: ymdTaipei(tmr) });
      check(kf.status === 400 && kf.data.error, 'K3 關帳日設在未來 → 400', kf);
      const kl = await call('PATCH', B, { closed_through: '2026-09-30' });
      closedChanged = kl.status === 200;
      check(kl.status === 200 && kl.data.book && kl.data.book.closed_through === '2026-09-30', 'K4 老闆關帳到 2026-09-30', kl);
      const kg = await call('GET', B);
      check(kg.data.book && kg.data.book.closed_through === '2026-09-30', 'K5 帳本詳情回 2026-09-30', kg.data.book);
      if (process.env.SMOKE_VIEWER_TOKEN) {
        const kv = await call('PATCH', B, { closed_through: null }, { token: process.env.SMOKE_VIEWER_TOKEN });
        check(kv.status === 403, 'K6 記帳員 / 唯讀改關帳日 → 403', kv);
      }

      const k7 = await postJ({ date: '2026-09-30', type: 'expense', amount: 5, subject_id: S6901, transfer_out_account_id: CASH, summary: `smoke K7 ${TS}` });
      check(k7.status === 409 && /已經關帳/.test(k7.data.error || ''), 'K7 手動記 9/30 → 409 白話', k7);
      if (k7.data.journal) cleanup.push(k7.data.journal.id);
      const k8 = await postJ({ date: '2026-10-01', type: 'expense', amount: 5, subject_id: S6901, transfer_out_account_id: CASH, summary: `smoke K8 ${TS}` });
      const K8 = k8.data.journal && k8.data.journal.id;
      if (K8) cleanup.push(K8);
      check(k8.status === 201 && K8, 'K8 手動記 10/1 → 201', k8);
      if (K8) {
        const k9 = await call('PATCH', `${B}/journals/${K8}`, { date: '2026-09-29' });
        check(k9.status === 409 && /已經關帳/.test(k9.data.error || ''), 'K9 把 10/1 的單改成 9/29 → 409', k9);
      }
      if (KJ) {
        const k10 = await call('PATCH', `${B}/journals/${KJ}`, { summary: 'x' });
        check(k10.status === 409, 'K10 改關帳期間的單 → 409', k10);
      }
      const k11 = await pushPosting(expensePush(`smoke:K11:${TS}`, '2026-09-15', 16));
      check(k11.status === 422 && k11.data.code === 'book_closed' && /補推/.test(k11.data.error || ''), 'K11 推 9/15 的單 → 422(請老闆解鎖後補推)', k11);
      if (KP) {
        const k12 = await call('POST', `${B}/pending-journals/${KP}/approve`, { note: 'smoke' });
        check(k12.status === 409 && /已經關帳/.test(k12.data.error || ''), 'K12 核准 9/20 的待審 → 409', k12);
        if (journalIdOf(k12)) cleanup.push(journalIdOf(k12));
        const k13 = await pushSupersede({
          external_source: 'smoke', base_external_id: `smoke:KP:${TS}`, action: 'replace', reason: 'smoke 關帳',
          new_external_id: `smoke:KP:${TS}@v2`,
          proposed_journal: { date: '2026-09-16', type: 'expense', amount: 15, subject_code: '6901', transfer_out_account_ref: '現金袋', summary: 'smoke K13' },
        });
        check(k13.status === 422 && k13.data.code === 'book_closed', 'K13 改單新版日期在關帳期間 → 422', k13);
      }
      if (KJ) {
        const today = todayTaipei();
        const [ty, tm] = today.split('-').map(Number);
        const sepBefore = await monthly(2026, 9);
        const curBefore = await monthly(ty, tm);
        const k14 = await reverse2(KJ, 'smoke 關帳後沖銷');
        const rv = k14.data.reversal || {};
        check(k14.status === 200 && ymdTaipei(rv.original_date) === today && ymdTaipei(rv.date) === today,
          'K14 沖 9/10 的單 → 200,沖銷單記在今天(不回溯進關帳月)', { status: k14.status, date: rv.date, original_date: rv.original_date, today });
        check(String(rv.summary || '').startsWith('[沖銷 2026-09-10 的單]'), 'K15 沖銷單摘要標「[沖銷 2026-09-10 的單]」', rv.summary);
        const sepAfter = await monthly(2026, 9);
        const curAfter = await monthly(ty, tm);
        check(n(sepAfter.data.expense.total) === n(sepBefore.data.expense.total) && n(sepAfter.data.profit) === n(sepBefore.data.profit),
          'K16 9 月月報不變', { before: sepBefore.data.expense, after: sepAfter.data.expense });
        check(n(curAfter.data.expense.total) - n(curBefore.data.expense.total) === -70, 'K17 本月多一筆反向(費用 −70)',
          { before: curBefore.data.expense, after: curAfter.data.expense });
        check(sepAfter.data.closed === true && curAfter.data.closed === false, 'K18 月報標「已關帳」:9 月是、本月不是',
          { sep: sepAfter.data.closed, cur: curAfter.data.closed });
      }

      const ku = await call('PATCH', B, { closed_through: null });
      check(ku.status === 200 && ku.data.book && ku.data.book.closed_through === null, 'K19 老闆解鎖(清空)', ku);
      if (ku.status === 200) closedChanged = false;
      const k20 = await postJ({ date: '2026-09-30', type: 'expense', amount: 5, subject_id: S6901, transfer_out_account_id: CASH, summary: `smoke K20 ${TS}` });
      const K20 = k20.data.journal && k20.data.journal.id;
      if (K20) cleanup.push(K20);
      check(k20.status === 201 && K20, 'K20 解鎖後記 9/30 → 201', k20);
    }
  } finally {
    // 一律改回原本的設定(中途出錯也要)
    if (closedChanged) {
      const r = await call('PATCH', B, { closed_through: origClosed });
      if (r.status !== 200) lines.push(`  ! 關帳日改回失敗:${r.status} ${r.data.error || ''} —— 請老闆到設定頁手動清掉 ${BOOK} 的關帳日`);
    }
    if (modeChanged) {
      const r = await call('PATCH', B, { posting_mode: origMode });
      if (r.status !== 200) lines.push(`  ! 記帳模式改回 ${origMode} 失敗:${r.status} ${r.data.error || ''}`);
    }
    for (const pid of pendingsToReject) {
      const r = await call('POST', `${B}/pending-journals/${pid}/reject`, { rejected_reason: 'smoke 自清' });
      if (r.status !== 200 && r.status !== 409) lines.push(`  ! 退回待審 #${pid} 失敗:${r.status} ${r.data.error || ''}`);
    }
    for (const aid of acctsToDisable) {
      const r = await call('PATCH', `${B}/accounts/${aid}`, { is_active: false });
      if (r.status !== 200) lines.push(`  ! 停用測試帳戶 #${aid} 失敗:${r.status} ${r.data.error || ''}`);
    }
  }
}

const reverse2 = (id, reason) => call('POST', `${B}/journals/${id}/reverse`, { reason });

async function selfClean() {
  for (const id of cleanup) {
    const r = await call('POST', `${B}/journals/${id}/reverse`, { reason: 'smoke 自清' });
    if (r.status !== 200 && r.status !== 409) lines.push(`  ! 自清 #${id} 失敗:${r.status} ${r.data.error || ''}`);
  }
  // 作廢測試原單(S2)若還在 → supersede 已處理;待審的 smoke 單會留在「已退回 / 已核准」
}

main()
  .catch((e) => ng('腳本例外', e.stack || String(e)))
  .then(() => (TOKEN ? round2() : null))
  .catch((e) => ng('第二輪腳本例外', e.stack || String(e)))
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
