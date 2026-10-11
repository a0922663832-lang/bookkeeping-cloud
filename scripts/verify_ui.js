#!/usr/bin/env node
/* 記帳雲前端八頁 · 靜態驗收(雲 4,2026-10-10)
 *
 * 不開任何 port、不碰資料庫:用主 repo 的 Playwright,在記憶體裡
 *   - 把 http://cloud.test/ 的頁面檔、/common.js 直接從 public/ 讀出來回給瀏覽器
 *   - 攔 /B/**、/auth/** 回假的 JSON(薪資複式單、沖銷單、needs_confirm 409、401…)
 *   - 把 CDN 上的 bootstrap / chart.js / sortable 換成極小的假件(只驗頁面自己的邏輯)
 * 用法:  node bookkeeping-cloud/scripts/verify_ui.js
 * 突變檢查:  CC_MUTATE=esc node bookkeeping-cloud/scripts/verify_ui.js   (esc 不跳脫,必須變紅)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let chromium;
try {
  ({ chromium } = require('C:/Users/nest/Desktop/AI/node_modules/playwright'));
} catch (_) {
  ({ chromium } = require(path.join(__dirname, '..', '..', 'node_modules', 'playwright')));
}

const PUB = path.join(__dirname, '..', 'public');
const HOST = 'http://cloud.test';
const PAGES = { '/': 'login', '/dashboard': 'dashboard', '/pending': 'pending', '/journals': 'journals', '/reports': 'reports', '/reconcile': 'reconcile', '/setup': 'setup', '/settings': 'settings' };
const NAV_PAGES = ['dashboard', 'pending', 'journals', 'reports', 'reconcile', 'setup', 'settings'];

// ───────────────── 小型斷言框架 ─────────────────
let nPass = 0, nFail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { nPass++; console.log('  PASS  ' + name); }
  else { nFail++; failures.push(name); console.log('  FAIL  ' + name + (detail !== undefined ? '   → ' + JSON.stringify(detail) : '')); }
}
function section(t) { console.log('\n── ' + t); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 台北時間的今天 / 昨天(獨立算一次,不借用 common.js 的函式)
function taipeiDate(offsetDays) {
  const d = new Date(Date.now() + 8 * 3600e3 + (offsetDays || 0) * 86400e3);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function commonSource() {
  let src = fs.readFileSync(path.join(PUB, 'common.js'), 'utf8');
  if (process.env.CC_MUTATE === 'esc') {
    // 突變:esc 什麼都不跳脫
    const before = src;
    src = src.replace(/function esc\(s\) \{[\s\S]*?\n  \}\n/, 'function esc(s) { return s == null ? "" : String(s); }\n');
    if (src === before) throw new Error('突變失敗:找不到 esc 函式');
  }
  return src;
}

// ───────────────── 假後端 ─────────────────
function makeBackend(opts) {
  const sc = Object.assign({
    role: 'owner', pendingTotal: null, pendingBig: false, noChart: false, noBootstrap: false,
    noSortable: false, noCss: false, postConflict409: false, closedThrough: null, monthClosed: undefined, postAbortFirst: 0, guardByName: false, extraAccounts: false,
    rosterFail: 0, loginMode: 'ok', cpFail: false, reconFail: false, reconRan: true,
    accountPatchNeedsConfirm: true, delayCp: 0, unauthorizedOn: null,
  }, opts || {});
  const calls = [];
  const state = { sc, calls };
  // 報表回應有沒有「pending」欄位:opts 有寫 pending 才回(沒寫 = 模擬後端舊版沒這個欄位);可以是 {count,total} 或 null
  const pendingField = opts && 'pending' in opts ? { pending: opts.pending } : {};

  const xssSummary = '<img src=x onerror="window.__xss=1">客人訂金';
  const salary = {
    id: 1, status: 'pending', external_source: 'leo_hr', external_id: 'salary-2026-10', event_id: 'payroll.2026-10.1.v1', payload: {},
    proposed_journal: { type: 'composite', date: '2026-10-05', summary: '十月薪資', legs: [
      { leg_no: 1, kind: 'subject', subject_code: '6801', subject_parent_type: 't3', amount: 30000 },
      { leg_no: 2, kind: 'subject', subject_code: '6802', subject_parent_type: 't3', amount: 3000 },
      { leg_no: 3, kind: 'account', account_ref: '玉山銀行', amount: -25000 },
      { leg_no: 4, kind: 'account', account_ref: '現金袋', amount: -3000 },
      { leg_no: 5, kind: 'account', account_ref: '應付勞健保', amount: -5000 },
    ] },
  };
  const pos = {
    id: 2, status: 'pending', external_source: 'leo_pos', external_id: 'x"><script>window.__xss=2</script>',
    event_id: 'pos_shift.settled.5.1760000000000', payload: { triggered_by_emp_id: '<b>E9</b>' },
    proposed_journal: { type: 'composite', date: '2026-10-09', summary: xssSummary, legs: [
      { leg_no: 1, kind: 'account', account_ref: '現金袋', amount: 1000 },
      { leg_no: 2, kind: 'subject', subject_code: '4101', subject_parent_type: 't1', amount: 1000, note: '<i onclick="window.__xss=4">備註</i>' },
    ] },
  };
  const bad = {
    id: 3, status: 'pending', external_source: 'leo_pos', external_id: 'pos-bad',
    event_id: 'pos_deposit_offset.9.1760000000000', payload: {},
    proposed_journal: { type: 'composite', date: '2026-10-09', summary: '不平衡的單', legs: [
      { leg_no: 1, kind: 'account', account_ref: '現金袋', amount: 500 },
      { leg_no: 2, kind: 'subject', subject_code: '4101', subject_parent_type: 't1', amount: 400 },
    ] },
  };
  const exp = {
    id: 4, status: 'pending', external_source: 'leo_expense', external_id: 'EXP-1',
    event_id: 'expense.created.7.1760000000000', payload: {},
    proposed_journal: { type: 'expense', date: '2026-10-08', amount: 500, summary: '買菜' },
  };
  const done = {
    id: 5, status: 'rejected', external_source: 'leo_expense', external_id: 'EXP-0', payload: {},
    rejected_by_name: '老闆', rejected_at: '2026-10-09T16:30:00.000Z', rejected_reason: '<u>金額錯</u>',
    proposed_journal: { type: 'expense', date: '2026-10-07', amount: 90, summary: '舊單' },
  };
  state.pending = [salary, pos, bad, exp, done];

  state.journals = [
    { id: 1, type: 'expense', date: '2026-10-09T16:00:00.000Z', amount: 500, subject_code: '6901', subject_name: '雜費', summary: '買膠帶', transfer_out_account_name: '現金袋', counterparty_name: '五金行', edit_count: 1 },
    { id: 2, type: 'income', date: '2026-10-01', amount: 1000, subject_code: '4101', subject_name: '菜色收入', summary: '被沖銷的收入', reversed_by_id: 3, transfer_in_account_name: '現金袋' },
    { id: 3, type: 'expense', date: '2026-10-02', amount: 1000, subject_code: '4101', subject_name: '菜色收入', summary: 'Reverse of #2', reverses_id: 2 },
    { id: 4, type: 'composite', is_composite: true, date: '2026-10-05T16:00:00.000Z', amount: 33000, subject_code: '6801', subject_name: '薪資', summary: '十月薪資', external_source: 'leo_hr', external_id: 'salary-2026-10' },
  ];
  state.legs = { 4: [
    { leg_no: 1, kind: 'subject', subject_code: '6801', subject_name: '薪資支出', amount: 30000 },
    { leg_no: 2, kind: 'account', account_name: '玉山銀行', amount: -25000 },
  ] };

  state.subjects = [
    { id: 1, parent_type: 't1', code: '4101', name: '菜色收入', display_order: 10, is_active: true },
    { id: 2, parent_type: 't3', code: '6901', name: '雜費', display_order: 10, is_active: true },
    { id: 3, parent_type: 't2', code: '5101', name: '食材<img src=x onerror=window.__xss=5>', display_order: 10, is_active: true },
  ];
  state.accounts = [
    { id: 5, type: 'cash', name: '現金袋', initial_balance: 0, current_balance: -300, display_order: 10, is_active: true, linked_counterparty_id: 12 },
    { id: 6, type: 'liability', name: '應付帳款-<b>X</b>', initial_balance: 0, current_balance: 800, display_order: 20, is_active: true, linked_counterparty_id: null },
  ];
  // 考勤包 5 新增的三個薪資負債科目(名字要與主 repo PAYROLL_*_REF 一字不差,第三個是全形破折號 U+2014)
  state.guardNames = ['現金袋', '應付代扣稅款', '應付勞退自提', '其他應付款—員工'];
  if (sc.extraAccounts) {
    state.accounts.push(
      { id: 7, type: 'liability', name: '應付代扣稅款', initial_balance: 0, current_balance: 0, display_order: 30, is_active: true, linked_counterparty_id: null },
      { id: 8, type: 'liability', name: '應付勞退自提', initial_balance: 0, current_balance: 0, display_order: 40, is_active: true, linked_counterparty_id: null },
      { id: 9, type: 'liability', name: '其他應付款—員工', initial_balance: 0, current_balance: 0, display_order: 50, is_active: true, linked_counterparty_id: null },
    );
  }
  state.cps = [
    { id: 12, type: 'expense', name: '應付廠商', display_order: 10, is_active: true, is_temporary: false, promote_count: 3 },
    { id: 13, type: 'expense', name: '臨時<s>攤商</s>', display_order: 20, is_active: true, is_temporary: true, promote_count: 5 },
  ];

  state.book = {
    code: 'NEST0001', name: '花現鳥巢', company_name: '花現鳥巢餐廳有限公司', tax_id: '12345678', currency: 'TWD', fiscal_year_start_month: 1,
    posting_mode: 'review',
    closed_through: sc.closedThrough,
    posting_mode_per_source: { leo_pos: { pos_shift_settled: 'auto', pos_deposit_offset: 'review' }, leo_expense: { expense_created: 'auto' }, leo_inline: 'auto' },
  };

  state.recon = {
    last_run_at: '2026-10-09T20:00:00.000Z',
    counts: { settled: 1, in_transit: 1, diff: 3 },
    open_repush: [{ external_id: 'busy-1' }],
    results: {
      diff: [
        { external_source: 'leo_pos', external_id: "x'); window.__xss2=1;//", event_type: 'pos_shift_settled', leo_amount: 1000, detail: '金額不符:現場 $1,000、帳本 $900 <img src=x onerror=window.__xss=6>', can_repush: true },
        { external_source: 'leo_expense', external_id: 'EXP-9', event_type: 'expense_created', leo_amount: 80, detail: '帳本沒收到(可補推)', can_repush: false },
        { external_source: 'leo_pos', external_id: 'busy-1', event_type: 'pos_shift_settled', detail: '補送中', can_repush: true },
      ],
      in_transit: [{ external_source: 'leo_inline', external_id: 'D-1', event_type: 'deposit_paid', detail: '排隊中' }],
      settled: [{ external_source: 'leo_hr', external_id: 'H-1', event_type: 'payroll_finalized', leo_amount: 33000 },
        { external_source: 'leo_expense', external_id: 'expense:OLD-9', event_type: 'expense_created', leo_amount: 50, cloud_status: 'stale', bucket: 'settled', detail: '現場清單已不再列出這筆' }],
    },
  };

  state.handler = async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();
    let body = null;
    try { body = req.postDataJSON(); } catch (_) { body = null; }
    calls.push({ method, path: p, query: Object.fromEntries(url.searchParams), body });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });

    if (method === 'GET' && PAGES[p]) {
      // 外網元件換成假件後過不了 integrity,所以餵頁面時把 integrity / crossorigin 屬性拿掉(真的屬性由第 0 節靜態檢查)
      const html = fs.readFileSync(path.join(PUB, PAGES[p] + '.html'), 'utf8')
        .replace(/\s+integrity="[^"]*"/g, '').replace(/\s+crossorigin="[^"]*"/g, '');
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    if (p === '/common.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: commonSource() });

    if (sc.unauthorizedOn && p.indexOf(sc.unauthorizedOn) >= 0) return json(401, { error: '你的權限已被收回,請聯絡管理員' });

    // ── 登入 ──
    if (p === '/auth/employees-roster') {
      if (sc.rosterFail > 0) { sc.rosterFail--; return json(500, { error: 'upstream exploded' }); }
      return json(200, { employees: [
        { emp_id: 'E001', name: '王<img src=x onerror=window.__xss=3>', dept: '<b>廚房</b>', cloud_access: 'admin' },
        { emp_id: 'E002', name: '李小姐', dept: '外場', cloud_access: 'editor' },
      ] });
    }
    if (p === '/auth/login') {
      if (sc.loginMode === '429') return json(429, { error: 'too many attempts', retry_after_sec: 600 });
      if (sc.loginMode === '401') return json(401, { error: 'invalid credentials' });
      return json(200, { token: 'tok-123', user: { id: 1, name: '王小明' } });
    }

    // ── 帳本 ──
    const B = '/B/NEST0001';
    if (p === B && method === 'GET') return json(200, { book: state.book, my_role: sc.role });
    if (p === B && method === 'PATCH') { Object.assign(state.book, body || {}); return json(200, { book: state.book }); }

    if (p === B + '/reports/dashboard') {
      return json(200, Object.assign({
        month: '2026-10', this_month: { income: 12000, expense: 15000, profit: -3000 }, total_balance: -300,
        accounts: [{ name: '現金袋<img src=x onerror=window.__xss=7>', type: 'cash', current_balance: -300 }, { name: '玉山銀行', type: 'bank', current_balance: 5000 }],
        trend_6m: [{ month: '2026-09', income: 1, expense: 2, profit: -1 }, { month: '2026-10', income: 12000, expense: 15000, profit: -3000 }],
      }, pendingField));
    }
    if (p === B + '/reports/monthly') {
      return json(200, Object.assign({
        year: 2026, month: 10, profit: -300, transaction_count: 7,
        income: { total: 1000, by_subject: [{ code: '4101', name: '=HYPERLINK("http://x","點我")', amount: '1200.00' }, { code: '4197', name: '銷貨退回', amount: '-200.00' }] },
        cost: { total: 0, by_subject: [] },
        expense: { total: 1300, by_subject: [{ code: '6901', name: '雜費<img src=x onerror=window.__xss=8>', amount: '1300.00' }] },
      }, pendingField, sc.monthClosed === undefined ? {} : { closed: sc.monthClosed }));
    }
    if (p === B + '/reports/yearly') {
      return json(200, Object.assign({
        year: 2026, summary: { total_income: 1, total_cost: 0, total_expense: 2, total_profit: -1 },
        monthly: [{ month: 10, income: 1, expense: 2, profit: -1 }],
        income_breakdown: [{ code: '4101', name: '菜色', amount: 1, percent: 100 }], cost_breakdown: [], expense_breakdown: [],
      }, pendingField));
    }
    if (p === B + '/reports/counterparties') {
      if (sc.cpFail) return json(500, { error: 'boom stack trace' });
      return json(200, {
        from: url.searchParams.get('from'), to: url.searchParams.get('to'),
        counterparties: [
          { id: 1, type: 'expense', name: '停用廠商<b>x</b>', tax_id: '12345678', category: '食材', income_total: 0, expense_total: 500, transaction_count: 2, is_active: false },
          { id: 3, type: 'income', name: '退款客戶', tax_id: null, category: '', income_total: -50, expense_total: 0, transaction_count: 1, is_active: true },
          { id: 2, type: 'income', name: '客戶甲', tax_id: null, category: '', income_total: 900, expense_total: 0, transaction_count: 1, is_active: true },
        ],
      });
    }

    // ── 待審 ──
    if (p === B + '/pending-journals/approve-batch' && method === 'POST') {
      return json(200, { results: (body.ids || []).map((id, i) => (i === 0 ? { id, ok: true, journal_id: 100 + id } : { id, ok: false, error: '這筆已經被別人核准了' })) });
    }
    let m = p.match(/^\/B\/NEST0001\/pending-journals\/(\d+)\/(approve|reject)$/);
    if (m && method === 'POST') {
      if (m[2] === 'approve') return json(200, { journal: { id: 900 + Number(m[1]) } });
      return json(200, { ok: true });
    }
    if (p === B + '/pending-journals' && method === 'GET') {
      const status = url.searchParams.get('status') || 'pending';
      const limit = Number(url.searchParams.get('limit') || 200);
      const offset = Number(url.searchParams.get('offset') || 0);
      if (sc.pendingBig) {
        const rows = [];
        for (let i = 0; i < Math.min(limit, 120 - offset); i++) rows.push(Object.assign({}, exp, { id: 1000 + offset + i }));
        return json(200, { pending_journals: rows, count: rows.length, total: 120 });
      }
      let rows = state.pending.filter((x) => status === 'all' || x.status === status);
      const total = sc.pendingTotal != null && status === 'pending' ? sc.pendingTotal : rows.length;
      rows = rows.slice(offset, offset + limit);
      return json(200, { pending_journals: rows, count: rows.length, total });
    }

    // ── 明細 ──
    if (p === B + '/journals' && method === 'GET') return json(200, { journals: state.journals, count: state.journals.length });
    if (p === B + '/journals' && method === 'POST') {
      // 模擬平板網路閃一下:前幾次直接斷線(請求已記在 calls 裡,後端其實沒收到)
      if (sc.postAbortFirst > 0) { sc.postAbortFirst--; return route.abort('failed'); }
      // 上一次其實已經記進去了,這次重送被後端認出來
      if (sc.postConflict409) return json(409, { error: '這張單剛才已經送出成功了,請到明細查看,不會重複記帳。' });
      return json(200, { journal: { id: 99 } });
    }
    m = p.match(/^\/B\/NEST0001\/journals\/(\d+)\/legs$/);
    if (m) return json(200, { journal_id: Number(m[1]), is_composite: true, legs: state.legs[m[1]] || [] });
    m = p.match(/^\/B\/NEST0001\/journals\/(\d+)\/reverse$/);
    if (m && method === 'POST') return json(200, { reversal: { id: 50 }, original: { id: Number(m[1]) } });
    m = p.match(/^\/B\/NEST0001\/journals\/(\d+)$/);
    if (m && method === 'GET') {
      const j = state.journals.find((x) => x.id === Number(m[1]));
      return j ? json(200, { journal: Object.assign({ subject_id: 2, transfer_out_account_id: 5, created_at: '2026-10-09T01:00:00.000Z', edited_at: '2026-10-09T16:30:00.000Z' }, j) }) : json(404, { error: 'journal not found' });
    }
    if (m && method === 'PATCH') return json(200, { journal: { id: Number(m[1]) } });
    if (m && method === 'DELETE') return json(500, { error: '舊入口不該被呼叫' });

    // ── 主檔 ──
    if (p === B + '/subjects' && method === 'GET') return json(200, { subjects: state.subjects });
    m = p.match(/^\/B\/NEST0001\/subjects\/(\d+)$/);
    if (m && method === 'PATCH') {
      if (body && body.parent_type) return json(400, { error: '這個科目已經有 12 筆記錄,改大類會讓歷史報表整批變動;請新建一個科目,舊的停用。' });
      return json(200, { subject: { id: Number(m[1]) } });
    }
    if (p === B + '/accounts' && method === 'GET') return json(200, { accounts: state.accounts });
    m = p.match(/^\/B\/NEST0001\/accounts\/(\d+)$/);
    if (m && method === 'PATCH') {
      // guardByName:像真的後端一樣,只有「名字在守衛名單裡」的帳戶改名才要二次確認
      const acct = state.accounts.find((a) => a.id === Number(m[1]));
      const needs = sc.guardByName ? !!(acct && state.guardNames.includes(acct.name)) : sc.accountPatchNeedsConfirm;
      if (needs && !(body && body.confirm)) {
        return json(409, { error: '這個帳戶有 128 筆記錄在用,POS 收班每天會用名字找它;改名後推送會失敗。確定要改請再按一次。', usage: { journals: 128, pending: 2, used_by_posting: true }, needs_confirm: true });
      }
      return json(200, { account: { id: Number(m[1]) } });
    }
    if (p === B + '/counterparties' && method === 'GET') {
      if (sc.delayCp) await sleep(sc.delayCp);
      return json(200, { counterparties: state.cps });
    }
    m = p.match(/^\/B\/NEST0001\/counterparties\/(\d+)$/);
    if (m && method === 'PATCH') return json(200, { counterparty: { id: Number(m[1]) } });

    // ── 對帳 ──
    if (p === B + '/reconciliation' && method === 'GET') {
      if (sc.reconFail) return json(500, { error: 'db down' });
      const d = Object.assign({}, state.recon);
      if (!sc.reconRan) { d.ran = false; d.counts = { settled: 0, in_transit: 0, diff: 0 }; d.results = { diff: [], in_transit: [], settled: [] }; d.last_run_at = null; }
      return json(200, d);
    }
    if (p === B + '/reconciliation/run') return json(200, { ok: true });
    if (p === B + '/reconciliation/repush') return json(200, { ok: true });

    return json(404, { error: 'no such fake route: ' + method + ' ' + p });
  };
  return state;
}

// ───────────────── 開頁面 ─────────────────
async function openPage(browser, backend, pagePath, o) {
  o = o || {};
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, timezoneId: o.tz || 'Asia/Taipei' });
  await context.route('http://cloud.test/**', backend.handler);
  await context.route('https://cdn.jsdelivr.net/**', (route) => {
    const u = route.request().url();
    if (u.endsWith('.css') && backend.sc.noCss) return route.fulfill({ status: 404, body: '' });
    if (u.endsWith('.css')) return route.fulfill({ status: 200, contentType: 'text/css', body: '.d-none{display:none!important}.modal{display:none}.modal.show{display:block}' });
    if (/bootstrap/.test(u)) {
      if (backend.sc.noBootstrap) return route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* bootstrap blocked */' });
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.bootstrap={Modal:function(el){this.show=function(){el.classList.add("show")};this.hide=function(){el.classList.remove("show")}}};' });
    }
    if (/chart/.test(u)) {
      if (backend.sc.noChart) return route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* chart blocked */' });
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.__charts=[];window.Chart=function(el,cfg){window.__charts.push(cfg);this.destroy=function(){}};' });
    }
    if (/sortable/i.test(u)) {
      if (backend.sc.noSortable) return route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* sortable blocked */' });
    }
    if (/sortable/i.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.Sortable={create:function(){return{destroy:function(){}}}};' });
    return route.fulfill({ status: 404, body: '' });
  });
  const page = await context.newPage();
  const errors = [], dialogs = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  page.on('dialog', (d) => { dialogs.push(d.type() + ':' + d.message()); d.dismiss().catch(() => {}); });
  await page.addInitScript((init) => {
    window.__CC_NAV = (u) => { window.__navTo = u; };
    if (init.login) {
      localStorage.setItem('token', 'tok-abc');
      localStorage.setItem('user', JSON.stringify({ id: 1, name: '王小明' }));
    }
    if (init.lastEmpId) localStorage.setItem('lastEmpId', init.lastEmpId);
  }, { login: o.login !== false, lastEmpId: o.lastEmpId || 'E001' });
  await page.goto(HOST + pagePath);
  return { page, context, errors, dialogs, backend };
}

const callsTo = (b, method, pathRe) => b.calls.filter((c) => c.method === method && pathRe.test(c.path));

// ───────────────── 主流程 ─────────────────
async function main() {
  const browser = await chromium.launch();
  try {
    // ============ 0. 靜態檢查 ============
    section('0. 檔案層檢查(grep / 換行 / 語法)');
    const allFiles = fs.readdirSync(PUB).filter((f) => /\.(html|js)$/.test(f));
    let nativeHits = [], isoHits = [], crHits = [];
    for (const f of allFiles) {
      const txt = fs.readFileSync(path.join(PUB, f), 'utf8');
      if (/confirm\(|prompt\(|alert\(/.test(txt)) nativeHits.push(f);
      if (/toISOString/.test(txt)) isoHits.push(f);
      if (txt.indexOf('\r') >= 0) crHits.push(f);
    }
    check('八頁 + common.js 沒有任何系統小視窗字樣', nativeHits.length === 0, nativeHits);
    check('沒有 toISOString(日期一律台北時間切日)', isoHits.length === 0, isoHits);
    check('public/ 全部 LF(沒有 CR)', crHits.length === 0, crHits);
    {
      // 外部元件(bootstrap / chart.js / sortablejs)每個標籤都要帶 integrity + crossorigin,且 hash 與版本一一對上
      // hash 是 2026-10-11 用 curl 抓該版本檔、openssl sha384 現算的;改版本要連 hash 一起重算
      const CDN_HASH = {
        'bootstrap@5.3.2/dist/css/bootstrap.min.css': 'sha384-T3c6CoIi6uLrA9TneNEoa7RxnatzjcDSCmG1MXxSR1GAsXEV/Dwwykc2MPK8M2HN',
        'bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js': 'sha384-C6RzsynM9kWDrMNeT87bh95OGNyZPhcTNXj1NW7RuBCsyN/o0jlpcV8Qyq46cDfL',
        'chart.js@4.4.1/dist/chart.umd.min.js': 'sha384-9nhczxUqK87bcKHh20fSQcTGD4qq5GhayNYSYWqwBkINBhOfQLg/P5HG5lF1urn4',
        'sortablejs@1.15.2/Sortable.min.js': 'sha384-BSxuMLxX+FCbTdYec3TbXlnMGEEM2QXTFdtDaveen71o+jswm2J36+xFqp8k4VHM',
      };
      const bad = [];
      let tags = 0;
      for (const f of allFiles.filter((x) => x.endsWith('.html'))) {
        const txt = fs.readFileSync(path.join(PUB, f), 'utf8');
        for (const tag of txt.match(/<(?:script|link)\b[^>]*https:\/\/cdn\.[^>]*>/g) || []) {
          tags++;
          const um = /https:\/\/cdn\.jsdelivr\.net\/npm\/([^"]+)"/.exec(tag);
          const im = /integrity="([^"]+)"/.exec(tag);
          if (!um || !im || CDN_HASH[um[1]] !== im[1] || !/crossorigin="anonymous"/.test(tag)) bad.push(f + ' ← ' + tag.slice(0, 120));
        }
      }
      check(`八頁外部元件共 ${tags} 個標籤,全部帶 integrity + crossorigin,且 hash 與版本對得上`, tags === 13 && bad.length === 0, bad);
    }
    for (const f of allFiles) {
      const txt = fs.readFileSync(path.join(PUB, f), 'utf8');
      let ok = true, msg = '';
      if (f.endsWith('.js')) {
        try { new vm.Script(txt, { filename: f }); } catch (e) { ok = false; msg = e.message; }
      } else {
        const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
        let mm, n = 0;
        while ((mm = re.exec(txt))) { n++; try { new vm.Script(mm[1], { filename: f + '#' + n }); } catch (e) { ok = false; msg = e.message; } }
      }
      check('語法檢查 ' + f, ok, msg);
    }
    for (const n of NAV_PAGES) {
      const txt = fs.readFileSync(path.join(PUB, n + '.html'), 'utf8');
      check(n + '.html 載入 /common.js 且用 initPage 畫導覽', /<script src="\/common\.js"><\/script>/.test(txt) && txt.indexOf("CC.initPage('") > 0 && txt.indexOf('id="navMount"') > 0);
    }

    // ============ 1. common.js 純函式 ============
    section('1. common.js 共用函式');
    {
      const b = makeBackend();
      const t = await openPage(browser, b, '/dashboard');
      await t.page.waitForSelector('#content:not(.d-none)');
      const r = await t.page.evaluate(() => ({
        neg: CC.fmtMoney(-1200), pos: CC.fmtMoney(1234567), zero: CC.fmtMoney(0), signedNeg: CC.fmtSigned(-25000), signedPos: CC.fmtSigned(500),
        d1: CC.fmtDate('2026-10-09T16:00:00.000Z'), d2: CC.fmtDate('2026-10-10'), d3: CC.fmtDate('2026-10-10T20:00:00.000Z'), dBad: CC.fmtDate('abc'),
        dt: CC.fmtDateTime('2026-10-09T16:30:00.000Z'),
        quote: CC.esc("a'b\"c<d>&"), add: CC.addDays('2026-03-01', -1), add2: CC.addDays('2026-12-31', 1),
        gapSalary: CC.legGap([{ kind: 'subject', subject_parent_type: 't3', amount: 30000 }, { kind: 'subject', subject_parent_type: 't3', amount: 3000 }, { kind: 'account', amount: -33000 }]).gap,
        gapPos: CC.legGap([{ kind: 'account', amount: 1000 }, { kind: 'subject', subject_parent_type: 't1', amount: 1000 }]).gap,
        gapRefund: CC.legGap([{ kind: 'account', amount: -100 }, { kind: 'subject', subject_parent_type: 't1', amount: -105 }, { kind: 'subject', subject_parent_type: 't1', amount: 5 }]).gap,
        gapBad: CC.legGap([{ kind: 'account', amount: 500 }, { kind: 'subject', subject_parent_type: 't1', amount: 400 }]).gap,
        gapUnknown: CC.legGap([{ kind: 'account', amount: 500 }, { kind: 'subject', amount: 500 }]).known,
        friendly401: CC.friendlyError(401, {}), friendly500: CC.friendlyError(500, { error: 'ECONNREFUSED 10.0.0.1' }),
        friendly409: CC.friendlyError(409, { error: '這筆已經被處理過了' }), friendlyEn: CC.friendlyError(400, { error: 'invalid thing' }),
        friendly429: CC.friendlyError(429, { error: 'x', retry_after_sec: 600 }),
      }));
      check('負數金額寫成 -$1,200', r.neg === '-$1,200', r.neg);
      check('正數 / 零金額格式', r.pos === '$1,234,567' && r.zero === '$0', [r.pos, r.zero]);
      check('帶正負號:-$25,000 / +$500', r.signedNeg === '-$25,000' && r.signedPos === '+$500', [r.signedNeg, r.signedPos]);
      check('fmtDate:2026-10-09T16:00Z 以台北時間切成 2026-10-10', r.d1 === '2026-10-10', r.d1);
      check('fmtDate:純日期原樣、晚上八點 UTC 算隔天、亂字串回空', r.d2 === '2026-10-10' && r.d3 === '2026-10-11' && r.dBad === '', [r.d2, r.d3, r.dBad]);
      check('fmtDateTime 台北時間', r.dt === '2026-10-10 00:30', r.dt);
      check('esc 跳脫 & < > " 單引號', r.quote === 'a&#39;b&quot;c&lt;d&gt;&amp;', r.quote);
      check('addDays 跨月 / 跨年', r.add === '2026-02-28' && r.add2 === '2027-01-01', [r.add, r.add2]);
      check('守恆公式:薪資 / POS 收班 / 訂金退款差額都是 0', r.gapSalary === 0 && r.gapPos === 0 && r.gapRefund === 0, [r.gapSalary, r.gapPos, r.gapRefund]);
      check('守恆公式:不平衡的單算出差額 100;沒帶科目大類則標示「算不出來」', r.gapBad === 100 && r.gapUnknown === false, [r.gapBad, r.gapUnknown]);
      check('錯誤文字白話:401 / 5xx 不外洩原文 / 409 用後端文案 / 英文 400 換白話 / 429 帶分鐘',
        /重新登入/.test(r.friendly401) && !/ECONNREFUSED/.test(r.friendly500) && /系統暫時有問題/.test(r.friendly500)
        && r.friendly409 === '這筆已經被處理過了' && !/invalid/.test(r.friendlyEn) && /10 分鐘/.test(r.friendly429), r);
      await t.context.close();
    }

    // ============ 2. 登入頁 ============
    section('2. login.html');
    {
      const b = makeBackend({ rosterFail: 1 });
      const t = await openPage(browser, b, '/?reason=' + encodeURIComponent('登入已過期或權限被收回,請重新登入'), { login: false, lastEmpId: 'E002' });
      await t.page.waitForSelector('#retryBtn:not(.d-none)');
      check('名單載入失敗:出現「重新載入名單」鈕、提示白話', (await t.page.textContent('#empHint')).indexOf('沒辦法取得員工名單') >= 0 && !/upstream|exploded|HTTP/.test(await t.page.textContent('#empHint')));
      check('被踢回登入頁時顯示原因', /重新登入/.test(await t.page.textContent('#reason')) && await t.page.isVisible('#reason'));
      await t.page.click('#retryBtn');
      await t.page.waitForFunction(() => document.querySelectorAll('#empId option').length > 2);
      check('按重試後名單載入、登入鈕可按', await t.page.isEnabled('#submitBtn'));
      check('名單文字有跳脫(沒有執行注入)', await t.page.evaluate(() => window.__xss === undefined && !document.querySelector('#empId img')));
      check('記住上次選的人(lastEmpId=E002 預選)', (await t.page.inputValue('#empId')) === 'E002');
      await t.page.selectOption('#empId', 'E001');
      await t.page.fill('#pin', '1234');
      b.sc.loginMode = '429';
      await t.page.click('#submitBtn');
      await t.page.waitForSelector('#err:not(.d-none)');
      check('HR 429:顯示「請 10 分鐘後再試」', /請 10 分鐘後再試/.test(await t.page.textContent('#err')), await t.page.textContent('#err'));
      b.sc.loginMode = '401';
      await t.page.click('#submitBtn');
      await t.page.waitForFunction(() => /編號或密碼不對/.test(document.getElementById('err').textContent));
      check('登入失敗訊息白話(不是 invalid credentials)', !/invalid/.test(await t.page.textContent('#err')), await t.page.textContent('#err'));
      b.sc.loginMode = 'ok';
      await t.page.click('#submitBtn');
      await t.page.waitForFunction(() => window.__navTo);
      const loginCalls = callsTo(b, 'POST', /^\/auth\/login$/);
      const dev = loginCalls[loginCalls.length - 1].body.device_id;
      check('登入時送 device_id(uuid),三次是同一個', !!dev && /^[0-9a-f-]{16,}$/i.test(dev) && loginCalls.every((c) => c.body.device_id === dev), loginCalls.map((c) => c.body.device_id));
      check('登入成功:token 存起來、導向儀表板、lastEmpId 更新', await t.page.evaluate(() => localStorage.getItem('token') === 'tok-123' && window.__navTo === '/dashboard' && localStorage.getItem('lastEmpId') === 'E001'));
      check('login 頁沒有 JS 錯誤、沒有系統小視窗', t.errors.length === 0 && t.dialogs.length === 0, [t.errors, t.dialogs]);
      await t.context.close();
    }

    // ============ 3. 導覽(七個內頁 + 登入頁無導覽) ============
    section('3. 導覽列(含「對帳」)與待審徽章');
    for (const n of NAV_PAGES) {
      const b = makeBackend({ pendingTotal: 7 });
      const t = await openPage(browser, b, '/' + n);
      await t.page.waitForSelector('#navMount .nav-link');
      const info = await t.page.evaluate(() => {
        const links = [...document.querySelectorAll('#navMount .nav-link')].map((a) => ({ t: a.textContent.trim().replace(/\s+/g, ' '), h: a.getAttribute('href') }));
        const act = document.querySelector('#navMount .nav-link.active');
        return { links, act: act && act.getAttribute('href') };
      });
      check(n + ':導覽有「對帳」→ /reconcile 且共 8 個連結', info.links.some((l) => l.t === '對帳' && l.h === '/reconcile') && info.links.length === 8, info.links);
      check(n + ':目前頁有標示 active', !!info.act, info.act);
      await t.page.waitForFunction(() => document.getElementById('pendingBadge') && document.getElementById('pendingBadge').textContent.trim() === '7', null, { timeout: 4000 }).catch(() => {});
      check(n + ':待審徽章顯示總數 7(用 total,不是回傳筆數)', (await t.page.textContent('#pendingBadge')).trim() === '7');
      await sleep(300);
      const missing = await t.page.evaluate(() => {
        const out = [];
        document.querySelectorAll('[onclick],[onchange],[oninput]').forEach((el) => {
          ['onclick', 'onchange', 'oninput'].forEach((a) => {
            const v = el.getAttribute(a);
            if (!v) return;
            const m = /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(v);
            if (m && typeof window[m[1]] !== 'function') out.push(m[1]);
          });
        });
        return out;
      });
      check(n + ':頁面上每個 onclick/onchange 呼叫的函式都找得到', missing.length === 0, missing);
      check(n + ':沒有 JS 錯誤、沒有系統小視窗', t.errors.length === 0 && t.dialogs.length === 0, [t.errors, t.dialogs]);
      await t.context.close();
    }

    // ============ 4. 待審頁 ============
    section('4. pending.html');
    {
      const b = makeBackend();
      const t = await openPage(browser, b, '/pending');
      const P = t.page;
      await P.waitForSelector('#pj-1');
      const txt1 = await P.textContent('#pj-1');
      check('薪資複式單:大標題金額 = |Σ科目腳| = $33,000(payload 沒帶 amount)', /\$33,000/.test(await P.textContent('#pj-1 .amount-display')), await P.textContent('#pj-1 .amount-display'));
      check('薪資複式單:借貸差額 0 → 沒有紅字警告', !/借貸不平衡/.test(txt1));
      check('POS 收班複式單:差額 0 → 沒有警告', !/借貸不平衡/.test(await P.textContent('#pj-2')));
      const badTxt = await P.textContent('#pj-3');
      check('不平衡的單:顯示「借貸不平衡,差 $100,請退回並通知技術」', /借貸不平衡,差 \$100,請退回並通知技術/.test(badTxt), badTxt);
      check('各腳負數有字面負號 -$25,000', />-\$25,000</.test(await P.innerHTML('#pj-1')));
      check('各腳正數有字面正號 +$1,000', />\+\$1,000</.test(await P.innerHTML('#pj-2')));
      check('XSS:摘要 / 單號 / 觸發者 / 腳備註都被跳脫,沒有執行也沒有長出標籤', await P.evaluate(() => window.__xss === undefined && !document.querySelector('#list img, #list script, #list b, #list i')));
      check('XSS:摘要原文以文字顯示', (await P.textContent('#pj-2')).indexOf('<img src=x onerror="window.__xss=1">客人訂金') >= 0);
      check('術語白話:沒有 journal # / balance gap / composite / 英文事件名', !/journal #|balance gap|composite|pos_shift|expense\.created/.test(await P.textContent('#list')));
      check('來源 / 事件翻成中文(點餐結帳、POS 收班)', /點餐結帳/.test(await P.textContent('#pj-2')) && /POS 收班/.test(await P.textContent('#pj-2')));
      check('待審事件徽章由 event_id 前綴推出(薪資 / 訂金抵用 / 支出),不靠不存在的 payload.event_type', /薪資/.test(await P.textContent('#pj-1 .badge.bg-secondary')) && /訂金抵用/.test(await P.textContent('#pj-3 .badge.bg-secondary')) && /支出/.test(await P.textContent('#pj-4 .badge.bg-secondary')));
      await P.click('#filterBtns [data-filter=rejected]');
      await P.waitForSelector('#pj-5');
      const rejTxt = await P.textContent('#pj-5');
      check('已退回的卡片:退回原因以文字顯示(<u> 沒生效)、退回時間用台北時間、不含 T', rejTxt.indexOf('<u>金額錯</u>') >= 0 && !(await P.$('#pj-5 u')) && /2026-10-10 00:30/.test(rejTxt) && !/\d{4}-\d{2}-\d{2}T/.test(rejTxt), rejTxt);
      await P.click('#filterBtns [data-filter=pending]');
      await P.waitForSelector('#pj-4');

      // 單筆核准
      await P.click('#pj-4 [data-act=approve]');
      await P.waitForSelector('.cc-dlg');
      check('核准:跳出的是頁面自畫的框(不是系統小視窗)', t.dialogs.length === 0 && await P.isVisible('.cc-dlg textarea'));
      await P.fill('.cc-dlg textarea', '備註ABC');
      await P.click('.cc-dlg .cc-btn.ok');
      await P.waitForSelector('#pj-4 .cc-result.ok');
      const ap = callsTo(b, 'POST', /\/pending-journals\/4\/approve$/);
      check('核准:真的送出 POST,帶備註', ap.length === 1 && ap[0].body.review_note === '備註ABC', ap);
      check('核准:結果文字留在該張卡片裡,且卡片狀態變「已核准」、按鈕消失', /已核准/.test(await P.textContent('#pj-4 .cc-result')) && /已核准/.test(await P.textContent('#pj-4 .pj-status')) && (await P.$$('#pj-4 [data-act]')).length === 0);
      await sleep(400);
      check('核准後結果訊息沒有自己消失', await P.isVisible('#pj-4 .cc-result'));

      // 退回
      await P.click('#pj-3 [data-act=reject]');
      await P.waitForSelector('.cc-dlg');
      await P.fill('.cc-dlg textarea', '金額不對');
      await P.click('.cc-dlg .cc-btn.danger');
      await P.waitForSelector('#pj-3 .cc-result.ok');
      const rj = callsTo(b, 'POST', /\/pending-journals\/3\/reject$/);
      check('退回:送出 POST 帶原因,結果留在卡片', rj.length === 1 && rj[0].body.review_note === '金額不對' && /已退回/.test(await P.textContent('#pj-3 .cc-result')), rj);

      // 取消不送
      await P.click('#pj-1 [data-act=approve]');
      await P.waitForSelector('.cc-dlg');
      await P.click('.cc-dlg .cc-btn:not(.ok):not(.danger)');
      await sleep(150);
      check('按取消:不送請求', callsTo(b, 'POST', /\/pending-journals\/1\/approve$/).length === 0 && !(await P.$('.cc-dlg')));

      // 批次核准
      await P.check('[data-pj-check="1"]');
      await P.check('[data-pj-check="2"]');
      check('批次鈕顯示「核准勾選的 2 筆」', (await P.textContent('#batchBtn')).trim() === '核准勾選的 2 筆');
      await P.click('#batchBtn');
      await P.waitForSelector('.cc-dlg');
      await P.click('.cc-dlg .cc-btn.ok');
      await P.waitForSelector('#pj-2 .cc-result');
      const bt = callsTo(b, 'POST', /approve-batch$/);
      check('批次核准:送一次 POST,ids = [1,2]', bt.length === 1 && JSON.stringify(bt[0].body.ids) === '[1,2]', bt);
      check('批次核准:成功那張卡片寫「已核准」(綠)', /已核准/.test(await P.textContent('#pj-1 .cc-result')) && await P.isVisible('#pj-1 .cc-result.ok'));
      check('批次核准:失敗那張卡片寫後端白話原因(紅)', /這筆已經被別人核准了/.test(await P.textContent('#pj-2 .cc-result')) && await P.isVisible('#pj-2 .cc-result.bad'));
      check('批次核准:頂端總結「成功 1 筆、失敗 1 筆」', /成功 1 筆、失敗 1 筆/.test(await P.textContent('#batchBar')));
      check('待審頁沒有 JS 錯誤、全程沒有系統小視窗', t.errors.length === 0 && t.dialogs.length === 0, [t.errors, t.dialogs]);
      await t.context.close();
    }
    {
      // 分頁
      const b = makeBackend({ pendingBig: true });
      const t = await openPage(browser, b, '/pending');
      await t.page.waitForSelector('#pager:not(.d-none)');
      check('分頁:顯示「第 1–50 筆,共 120 筆」', /第 1–50 筆,共 120 筆/.test(await t.page.textContent('#pagerInfo')), await t.page.textContent('#pagerInfo'));
      await t.page.click('#nextBtn');
      await t.page.waitForFunction(() => /第 51–100 筆/.test(document.getElementById('pagerInfo').textContent));
      const q = b.calls.filter((c) => c.path.endsWith('/pending-journals') && c.query.offset === '50');
      check('分頁:下一頁帶 offset=50&limit=50', q.length === 1 && q[0].query.limit === '50', q);
      await t.context.close();
    }
    {
      // 唯讀角色
      const b = makeBackend({ role: 'viewer' });
      const t = await openPage(browser, b, '/pending');
      await t.page.waitForSelector('#pj-4');
      check('唯讀角色:核准 / 退回鈕灰掉並寫原因、沒有勾選框', await t.page.evaluate(() => {
        const a = document.querySelector('#pj-4 [data-act=approve]');
        return a.disabled && /只能查看/.test(a.title) && !document.querySelector('[data-pj-check]') && document.getElementById('batchBar').classList.contains('d-none');
      }));
      await t.context.close();
    }
    {
      // 後端錯誤:核准失敗訊息留在卡片
      const b = makeBackend();
      const orig = b.handler;
      b.handler = async (route) => {
        if (/\/pending-journals\/4\/approve$/.test(route.request().url())) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'status is approved, cannot approve' }) });
        return orig(route);
      };
      const t = await openPage(browser, b, '/pending');
      await t.page.waitForSelector('#pj-4');
      await t.page.click('#pj-4 [data-act=approve]');
      await t.page.waitForSelector('.cc-dlg');
      await t.page.click('.cc-dlg .cc-btn.ok');
      await t.page.waitForSelector('#pj-4 .cc-result.bad');
      const m = await t.page.textContent('#pj-4 .cc-result');
      check('核准失敗(409 英文原文):卡片顯示白話,不外洩英文', !/status is|cannot approve/.test(m) && /核准失敗/.test(m), m);
      check('核准失敗後按鈕恢復可再按', await t.page.isEnabled('#pj-4 [data-act=approve]'));
      await t.context.close();
    }

    {
      // 關帳:單據日期 ≤ 關帳日 → 核准鈕灰掉寫原因(退回還是可以)
      const b = makeBackend({ closedThrough: '2026-10-06' });
      const t = await openPage(browser, b, '/pending');
      const P = t.page;
      await P.waitForSelector('#pj-1');
      const a1 = await P.$eval('#pj-1 [data-act=approve]', (e) => ({ d: e.disabled, t: e.title }));
      check('關帳(10/06):10/05 的薪資單核准鈕灰掉,title 寫「已關帳」與關帳日', a1.d && /2026-10-06/.test(a1.t) && /已關帳/.test(a1.t) && !/closed_through|409/.test(a1.t), a1);
      check('關帳:退回鈕還是可以按、批次勾選框拿掉', (await P.isEnabled('#pj-1 [data-act=reject]')) && (await P.$$('[data-pj-check="1"]')).length === 0);
      check('關帳:日期在關帳日之後的單(10/08 支出)核准鈕可按、有勾選框', (await P.isEnabled('#pj-4 [data-act=approve]')) && (await P.$$('[data-pj-check="4"]')).length === 1 && (await P.getAttribute('#pj-4 [data-act=approve]', 'title')) === null);
      await P.dispatchEvent('#pj-1 [data-act=approve]', 'click');
      await sleep(150);
      check('關帳:硬點灰掉的核准鈕,不跳框、不送核准請求', !(await P.$('.cc-dlg')) && callsTo(b, 'POST', /pending-journals\/1\/approve$/).length === 0);
      check('關帳:待審頁沒有 JS 錯誤、沒有系統小視窗', t.errors.length === 0 && t.dialogs.length === 0, [t.errors, t.dialogs]);
      await t.context.close();
      // 邊界:關帳日剛好是 10/05 → 10/05 的單算已關帳;關帳日 10/04 → 10/05 的單還能核准
      for (const [ct, locked] of [['2026-10-05', true], ['2026-10-04', false]]) {
        const bb = makeBackend({ closedThrough: ct });
        const tt = await openPage(browser, bb, '/pending');
        await tt.page.waitForSelector('#pj-1');
        check('關帳邊界:關帳日 ' + ct + ' → 10/05 的單核准鈕' + (locked ? '灰掉(≤ 含當天)' : '可按'), (await tt.page.isDisabled('#pj-1 [data-act=approve]')) === locked);
        await tt.context.close();
      }
    }

    // ============ 5. 401 ============
    section('5. 401:只清 token,保留 lastEmpId,原因帶到登入頁');
    {
      const b = makeBackend({ unauthorizedOn: '/pending-journals' });
      const t = await openPage(browser, b, '/pending', { lastEmpId: 'E777' });
      await t.page.waitForFunction(() => window.__navTo);
      const r = await t.page.evaluate(() => ({ nav: window.__navTo, token: localStorage.getItem('token'), user: localStorage.getItem('user'), last: localStorage.getItem('lastEmpId') }));
      check('401 後:導回登入頁並帶原因', r.nav.indexOf('/?reason=') === 0 && decodeURIComponent(r.nav).indexOf('權限已被收回') > 0, r.nav);
      check('401 後:token / user 清掉,lastEmpId 還在', r.token === null && r.user === null && r.last === 'E777', r);
      check('401 後:頁面沒有噴 JS 錯誤', t.errors.length === 0, t.errors);
      await t.context.close();
      const b2 = makeBackend();
      const t2 = await openPage(browser, b2, '/dashboard', { lastEmpId: 'E888' });
      await t2.page.waitForSelector('#logoutBtn');
      await t2.page.click('#logoutBtn');
      const r2 = await t2.page.evaluate(() => ({ nav: window.__navTo, token: localStorage.getItem('token'), last: localStorage.getItem('lastEmpId') }));
      check('按「登出」:也保留 lastEmpId', r2.nav === '/' && r2.token === null && r2.last === 'E888', r2);
      await t2.context.close();
      const b3 = makeBackend();
      const t3 = await openPage(browser, b3, '/journals', { login: false });
      await t3.page.waitForFunction(() => window.__navTo);
      check('沒登入直接開內頁:導向登入頁', (await t3.page.evaluate(() => window.__navTo)) === '/');
      await t3.context.close();
    }

    // ============ 6. 儀表板 ============
    section('6. dashboard.html');
    {
      const b = makeBackend({ pendingTotal: 9 });
      const t = await openPage(browser, b, '/dashboard');
      await t.page.waitForSelector('#content:not(.d-none)');
      check('XSS:帳戶名稱被跳脫', await t.page.evaluate(() => window.__xss === undefined && !document.querySelector('#accountsList img')));
      check('帳戶類型徽章是中文(現金 / 銀行存款)', /現金/.test(await t.page.textContent('#accountsList')) && /銀行存款/.test(await t.page.textContent('#accountsList')) && !/\bcash\b|\bbank\b/.test(await t.page.textContent('#accountsList')));
      check('負數金額 -$3,000、-$300', (await t.page.textContent('#kpiProfit')) === '-$3,000' && (await t.page.textContent('#kpiBalance')) === '-$300', [await t.page.textContent('#kpiProfit'), await t.page.textContent('#kpiBalance')]);
      check('待審清單:複式單金額用科目腳合計 $33,000、來源中文、顯示「還有 5 筆」', /\$33,000/.test(await t.page.textContent('#pendingList')) && /薪資/.test(await t.page.textContent('#pendingList')) && /還有 5 筆/.test(await t.page.textContent('#pendingList')), await t.page.textContent('#pendingList'));
      check('趨勢圖有畫', await t.page.evaluate(() => window.__charts.length === 1));
      const before = callsTo(b, 'GET', /reports\/dashboard$/).length;
      await t.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await t.page.waitForFunction(() => true);
      await sleep(300);
      check('回到前景:重抓一次儀表板', callsTo(b, 'GET', /reports\/dashboard$/).length === before + 1);
      check('沒有 JS 錯誤、沒有系統小視窗', t.errors.length === 0 && t.dialogs.length === 0, [t.errors, t.dialogs]);
      await t.context.close();
      const b2 = makeBackend({ noChart: true });
      const t2 = await openPage(browser, b2, '/dashboard');
      await t2.page.waitForSelector('#content:not(.d-none)');
      check('圖表元件沒載入:整頁仍顯示,有白話提示,不顯示 Chart is not defined', await t2.page.isVisible('#chartMsg') && !/Chart is not defined/.test(await t2.page.textContent('body')));
      const body2 = await t2.page.innerText('body');
      check('圖表元件沒載入:KPI 數字都有值(本月收入 $12,000、利潤 -$3,000)', (await t2.page.textContent('#kpiIncome')) === '$12,000' && (await t2.page.textContent('#kpiProfit')) === '-$3,000', [await t2.page.textContent('#kpiIncome'), await t2.page.textContent('#kpiProfit')]);
      check('圖表元件沒載入:圖表位置寫「圖表載不出來(店內連不上外網),上面的數字不受影響」,且不出現「載入失敗」', /圖表載不出來\(店內連不上外網\),上面的數字不受影響/.test(await t2.page.textContent('#chartMsg')) && !/載入失敗/.test(body2) && !(await t2.page.isVisible('#trendChart')), body2.slice(0, 200));
      check('圖表元件沒載入:帳戶清單、待審清單照常、沒有 JS 錯誤', /玉山銀行/.test(await t2.page.textContent('#accountsList')) && /薪資/.test(await t2.page.textContent('#pendingList')) && t2.errors.length === 0, t2.errors);
      await t2.context.close();
      // 報表上方的「還有待審沒算進來」提示(儀表板):有 / 零筆 / 查不到 / 後端舊版沒這個欄位
      for (const [label, opt, expectFn] of [
        ['3 筆 $12,820', { pending: { count: 3, total: 12820 } }, (tx) => /還有 3 筆、合計 \$12,820 在待審,沒有算進下面的數字/.test(tx) && /去待審/.test(tx)],
        ['0 筆', { pending: { count: 0, total: 0 } }, (tx) => tx === ''],
        ['查不到(null)', { pending: null }, (tx) => /待審筆數暫時查不到/.test(tx)],
        ['後端舊版沒這個欄位', {}, (tx) => tx === ''],
      ]) {
        const bp = makeBackend(opt);
        const tp = await openPage(browser, bp, '/dashboard');
        await tp.page.waitForSelector('#content:not(.d-none)');
        const tx = (await tp.page.textContent('#pendingNotice')).trim();
        check('儀表板待審提示 · ' + label, expectFn(tx) && tp.errors.length === 0, [tx, tp.errors]);
        if (label.startsWith('3 筆')) {
          check('儀表板待審提示:有連到 /pending、是淡黃提示條、文字沒有欄位名', (await tp.page.getAttribute('#pendingNotice a', 'href')) === '/pending' && (await tp.page.locator('#pendingNotice .cc-notice').count()) === 1 && !/pending|count|total/.test(tx));
        }
        await tp.context.close();
      }
      const b3 = makeBackend({ unauthorizedOn: 'NOPE' });
      const orig = b3.handler;
      b3.handler = async (route) => (/reports\/dashboard/.test(route.request().url()) ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'date/time field value out of range: "2026-11-31"' }) }) : orig(route));
      const t3 = await openPage(browser, b3, '/dashboard');
      await t3.page.waitForSelector('#loading .alert');
      check('後端 500:顯示白話,不洩漏資料庫英文', /系統暫時有問題/.test(await t3.page.textContent('#loading')) && !/date\/time/.test(await t3.page.textContent('#loading')));
      await t3.context.close();
    }

    // ============ 7. 明細頁 ============
    section('7. journals.html');
    {
      const b = makeBackend();
      const t = await openPage(browser, b, '/journals');
      const P = t.page;
      await P.waitForSelector('#rows tr[data-id="1"]');
      const rowsTxt = await P.textContent('#rows');
      check('日期欄不含 T…Z 原始字串', !/\d{4}-\d{2}-\d{2}T/.test(rowsTxt), rowsTxt.slice(0, 120));
      check('2026-10-09T16:00Z 顯示成台北日期 2026-10-10', (await P.textContent('#rows tr[data-id="1"] td:first-child')) === '2026-10-10');
      check('複式單顯示「複式」+「展開明細」,不顯示英文 composite', /複式/.test(await P.textContent('#rows tr[data-id="4"]')) && /展開明細/.test(await P.textContent('#rows tr[data-id="4"]')) && !/composite/.test(await P.textContent('#rows')));
      check('複式單沒有 ✏️ 編輯鈕,但有 ↺ 沖銷鈕', (await P.$$('#rows tr[data-id="4"] [data-act=edit]')).length === 0 && (await P.$$('#rows tr[data-id="4"] [data-act=reverse]')).length === 1);
      check('已被沖銷的單:標「已沖銷」、沒有任何操作鈕', /已沖銷/.test(await P.textContent('#rows tr[data-id="2"]')) && (await P.$$('#rows tr[data-id="2"] [data-act]')).length === 0);
      check('沖銷單標「沖銷單」,沒有操作鈕', /沖銷單/.test(await P.textContent('#rows tr[data-id="3"]')) && (await P.$$('#rows tr[data-id="3"] [data-act]')).length === 0);
      check('類型篩選有「複式」', (await P.$$eval('#fType option', (os) => os.map((o) => o.textContent))).includes('複式'));
      check('下拉選項沒有 (t3)/(cash) 這類代號', !/\(t\d\)|\(cash\)|\(bank\)/.test(await P.$eval('#jmSubject', (e) => e.innerHTML)));
      check('XSS:科目名稱沒被執行', await P.evaluate(() => window.__xss === undefined));

      // 展開明細
      await P.click('#rows tr[data-id="4"] [data-act=legs]');
      await P.waitForSelector('.legs-row');
      check('展開明細:呼叫 /legs,顯示 -$25,000 與帳戶名', callsTo(b, 'GET', /journals\/4\/legs$/).length === 1 && /-\$25,000/.test(await P.textContent('.legs-row')) && /玉山銀行/.test(await P.textContent('.legs-row')));

      // 沖銷:走 /reverse、要原因
      await P.click('#rows tr[data-id="1"] [data-act=reverse]');
      await P.waitForSelector('.cc-dlg');
      check('沖銷:自畫輸入框(非系統小視窗)', t.dialogs.length === 0);
      await P.click('.cc-dlg .cc-btn.danger');
      check('沖銷:原因沒填 → 擋下、顯示提示、沒送請求', /請寫一下為什麼要沖銷/.test(await P.textContent('.cc-dlg-err')) && callsTo(b, 'POST', /reverse$/).length === 0);
      await P.fill('.cc-dlg textarea', '重複記帳');
      await P.click('.cc-dlg .cc-btn.danger');
      await P.waitForSelector('#rows .cc-result');
      const rv = callsTo(b, 'POST', /journals\/1\/reverse$/);
      check('沖銷:POST /journals/1/reverse 帶 reason', rv.length === 1 && rv[0].body.reason === '重複記帳', rv);
      check('沖銷:完全沒有呼叫舊的 DELETE', b.calls.filter((c) => c.method === 'DELETE').length === 0);
      check('沖銷:結果訊息接在該列旁邊(重畫清單後仍在)', /已沖銷這一筆/.test(await P.textContent('#rows tr[data-id="1"] + .cc-result-row')));

      // 編輯:不送 type、日期不跳天
      await P.click('#rows tr[data-id="1"] [data-act=edit]');
      await P.waitForFunction(() => document.getElementById('journalModal').classList.contains('show'));
      check('編輯視窗日期 = 2026-10-10(沒少一天)', (await P.inputValue('#jmDate')) === '2026-10-10');
      await P.fill('#jmAmount', '650');
      await P.click('#jmSaveBtn');
      await P.waitForFunction(() => !document.getElementById('journalModal').classList.contains('show') || !document.getElementById('jmError').classList.contains('d-none'));
      const pa = callsTo(b, 'PATCH', /journals\/1$/);
      check('編輯儲存:PATCH 沒有帶 type 欄位,金額 650', pa.length === 1 && !('type' in pa[0].body) && pa[0].body.amount === 650, pa);
      check('編輯儲存:不帶防重複單號(那是「新增」才用的)', !('client_request_id' in pa[0].body), pa);
      check('編輯儲存後:接回該列「已儲存」', /已儲存/.test(await P.textContent('#rows')));

      // 詳情
      await P.click('#rows tr[data-id="4"] td:nth-child(4)');
      await P.waitForFunction(() => document.getElementById('detailModal').classList.contains('show'));
      await P.waitForFunction(() => /玉山銀行/.test(document.getElementById('dtBody').textContent));
      const dt = await P.textContent('#dtBody');
      check('複式單詳情:列出各腳、日期無 T、來源中文', /玉山銀行/.test(dt) && !/\d{4}-\d{2}-\d{2}T/.test(dt) && /薪資/.test(dt) && !/leo_hr/.test(dt), dt);
      check('複式單詳情:沒有編輯鈕', (await P.$eval('#dtEditBtn', (e) => e.style.display)) === 'none');
      await P.evaluate(() => document.getElementById('detailModal').classList.remove('show'));

      // 沖銷關係:不露內部編號
      await P.click('#rows tr[data-id="2"] td:nth-child(4)');
      await P.waitForFunction(() => /沖銷日/.test(document.getElementById('dtBody').textContent));
      const dt2 = await P.textContent('#dtBody');
      check('已被沖銷的單詳情:寫「已被沖銷(沖銷日 2026-10-02)」,畫面沒有 #數字', /已被沖銷\(沖銷日 2026-10-02\)/.test(dt2) && !/#\d/.test(dt2) && !/#\d/.test(await P.textContent('#detailModal .modal-header')), dt2);
      await P.evaluate(() => document.getElementById('detailModal').classList.remove('show'));
      check('明細頁畫面沒有「各腳」字樣', !/各腳/.test(await P.innerText('body')));

      // 記一筆:日期預設台北今天
      await P.click('#newBtn');
      check('「記一筆」日期預設 = 台北時間今天', (await P.inputValue('#jmDate')) === taipeiDate(0), [await P.inputValue('#jmDate'), taipeiDate(0)]);
      await P.fill('#jmAmount', '100');
      await P.click('#jmSaveBtn');
      check('記一筆缺科目:錯誤是白話', /請選會計科目/.test(await P.textContent('#jmError')));
      check('沒有 JS 錯誤、沒有系統小視窗', t.errors.length === 0 && t.dialogs.length === 0, [t.errors, t.dialogs]);
      await t.context.close();
    }
    {
      // 夜裡 00:30 台北時間 = 前一天 16:30 UTC:「今天」不能是昨天
      const b = makeBackend();
      const t = await openPage(browser, b, '/journals', { tz: 'UTC' });
      await t.page.waitForSelector('#rows tr[data-id="1"]');
      await t.page.evaluate(() => {
        const RealDate = Date;
        const fixed = new RealDate('2026-10-09T16:30:00.000Z').getTime();   // 台北 10/10 00:30
        window.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };
      });
      await t.page.click('#newBtn');
      check('台北凌晨 00:30 開「記一筆」,日期是 10/10(不是 UTC 的 10/09)', (await t.page.inputValue('#jmDate')) === '2026-10-10', await t.page.inputValue('#jmDate'));
      await t.context.close();
    }
    for (const role of ['editor', 'viewer']) {
      const b = makeBackend({ role });
      const t = await openPage(browser, b, '/journals');
      await t.page.waitForSelector('#rows tr[data-id="1"]');
      const hasEdit = (await t.page.$$('#rows [data-act=edit]')).length > 0;
      const hasRev = (await t.page.$$('#rows [data-act=reverse]')).length > 0;
      if (role === 'editor') check('記帳員:看得到編輯、看不到沖銷(沖銷只有擁有者 / 管理員)', hasEdit && !hasRev && await t.page.isEnabled('#newBtn'));
      else check('唯讀:看不到編輯 / 沖銷,「記一筆」灰掉並寫原因', !hasEdit && !hasRev && (await t.page.isDisabled('#newBtn')) && /只能查看/.test(await t.page.getAttribute('#newBtn', 'title')));
      await t.context.close();
    }
    {
      // 沖銷失敗:403 英文 → 白話,訊息在該列旁邊
      const b = makeBackend();
      const orig = b.handler;
      b.handler = async (route) => (/journals\/1\/reverse$/.test(route.request().url()) ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'forbidden, requires role: owner or admin' }) }) : orig(route));
      const t = await openPage(browser, b, '/journals');
      await t.page.waitForSelector('#rows tr[data-id="1"]');
      await t.page.click('#rows tr[data-id="1"] [data-act=reverse]');
      await t.page.waitForSelector('.cc-dlg');
      await t.page.fill('.cc-dlg textarea', '測試');
      await t.page.click('.cc-dlg .cc-btn.danger');
      await t.page.waitForSelector('#rows .cc-result.bad');
      const m = await t.page.textContent('#rows .cc-result.bad');
      check('沖銷被拒(403 英文):該列旁邊顯示白話「你的角色不能做這個」', /你的角色不能做這個/.test(m) && !/forbidden/.test(m), m);
      await t.context.close();
    }

    {
      // 記一筆:網路閃一下(請求沒送到)→ 重按送出,兩次帶同一個防重複單號;成功後再開新表單才換新
      const b = makeBackend({ postAbortFirst: 1 });
      const t = await openPage(browser, b, '/journals');
      const P = t.page;
      await P.waitForSelector('#rows tr[data-id="1"]');
      const fillForm = async () => {
        await P.click('#newBtn');
        await P.selectOption('#jmSubject', '2');
        await P.selectOption('#jmOut', '5');
        await P.fill('#jmAmount', '100');
      };
      const modalOpen = () => P.evaluate(() => document.getElementById('journalModal').classList.contains('show'));
      await fillForm();
      await P.click('#jmSaveBtn');
      await P.waitForSelector('#jmError:not(.d-none)');
      check('送出時網路斷線:表單留著不關、顯示白話「連線有問題」', /連線有問題/.test(await P.textContent('#jmError')) && await modalOpen(), await P.textContent('#jmError'));
      await P.click('#jmSaveBtn');
      await P.waitForFunction(() => !document.getElementById('journalModal').classList.contains('show'));
      let posts = callsTo(b, 'POST', /\/journals$/);
      const id1 = posts[0] && posts[0].body && posts[0].body.client_request_id;
      check('重按送出:兩次 POST 帶同一個防重複單號(有值、≤ 64 字)', posts.length === 2 && !!id1 && id1 === posts[1].body.client_request_id && id1.length <= 64, posts.map((p) => p.body));
      await fillForm();
      await P.click('#jmSaveBtn');
      await P.waitForFunction(() => !document.getElementById('journalModal').classList.contains('show'));
      posts = callsTo(b, 'POST', /\/journals$/);
      check('成功關掉表單後再開新的一張:換新單號', posts.length === 3 && !!posts[2].body.client_request_id && posts[2].body.client_request_id !== id1, posts.map((p) => p.body.client_request_id));
      check('單號只在背後送,畫面上看不到欄位名', !/client_request_id|request_id/.test(await P.innerText('body')));
      const ids = await P.evaluate(() => {
        // 假的網址不是安全環境,瀏覽器本來就沒有 randomUUID(跟現場平板走 http 一樣):先量退回的樣子,再塞一個假的量 UUID 那條路
        const fallback = CC.newRequestId();
        Object.defineProperty(Crypto.prototype, 'randomUUID', { value: () => '11111111-2222-3333-4444-555555555555', configurable: true });
        const uuid = CC.newRequestId();
        return { uuid, fallback };
      });
      check('單號產生:沒有 randomUUID(平板走 http)退回「時間-亂數」≤ 64 字;有就用 UUID', /^\d{13}-0\.\d+$/.test(ids.fallback) && ids.fallback.length <= 64 && ids.uuid === '11111111-2222-3333-4444-555555555555', ids);
      check('記一筆的防重複單號不影響別的功能:沒有 JS 錯誤、沒有系統小視窗', t.errors.length === 0 && t.dialogs.length === 0, [t.errors, t.dialogs]);
      await t.context.close();
    }
    {
      // 關帳:日期 ≤ 關帳日的列灰字 + 鎖頭,編輯 / 沖銷鈕灰掉並寫原因
      const b = makeBackend({ closedThrough: '2026-10-10' });
      const t = await openPage(browser, b, '/journals');
      const P = t.page;
      await P.waitForSelector('#rows tr[data-id="1"]');
      const want = '2026-10-10 以前已關帳,不能再改';
      const row1 = await P.$eval('#rows tr[data-id="1"]', (tr) => ({
        cls: tr.className, first: tr.children[0].textContent.trim(),
        eDis: tr.querySelector('[data-act=edit]').disabled, eTitle: tr.querySelector('[data-act=edit]').title,
        rDis: tr.querySelector('[data-act=reverse]').disabled, rTitle: tr.querySelector('[data-act=reverse]').title,
        color: getComputedStyle(tr.children[2]).color,
      }));
      check('關帳:已關帳的列有「closed-row」灰字樣式、日期前面有 🔒', /closed-row/.test(row1.cls) && /^🔒 2026-10-10$/.test(row1.first) && row1.color === 'rgb(153, 153, 153)', row1);
      const wantRev = '這筆在已關帳期間,沖銷會記在今天,不會改到已關帳的月份';
      check('關帳:✏️ disabled 且 title 寫「2026-10-10 以前已關帳,不能再改」;↺ 不 disabled、title 含「記在今天」', row1.eDis && row1.eTitle === want && !row1.rDis && row1.rTitle === wantRev && /記在今天/.test(row1.rTitle), row1);
      const r4 = await P.$eval('#rows tr[data-id="4"] [data-act=reverse]', (e) => ({ d: e.disabled, t: e.title }));
      check('關帳:複式單(10/06)的 ↺ 也不 disabled、title 含「記在今天」', !r4.d && r4.t === wantRev, r4);
      await P.dispatchEvent('#rows tr[data-id="1"] [data-act=edit]', 'click');
      await sleep(200);
      check('關帳:硬點灰掉的 ✏️,不跳框、不去讀這筆', !(await P.$('.cc-dlg')) && callsTo(b, 'GET', /journals\/1$/).length === 0);
      await P.click('#rows tr[data-id="1"] [data-act=reverse]');
      await P.waitForSelector('.cc-dlg');
      await P.fill('.cc-dlg textarea', '關帳後更正');
      await P.click('.cc-dlg .cc-btn.danger');
      await P.waitForSelector('#rows .cc-result');
      check('關帳:已關帳的列 ↺ 照樣能按,走沖銷入口並帶原因', callsTo(b, 'POST', /journals\/1\/reverse$/).length === 1 && callsTo(b, 'POST', /journals\/1\/reverse$/)[0].body.reason === '關帳後更正');
      await P.click('#rows tr[data-id="1"] td:nth-child(4)');
      await P.waitForFunction(() => document.getElementById('detailModal').classList.contains('show'));
      await P.waitForFunction(() => document.getElementById('dtBody').textContent.length > 0 && !/讀取中/.test(document.getElementById('dtBody').textContent));
      const dd = await P.evaluate(() => ({ e: document.getElementById('dtEditBtn').disabled, et: document.getElementById('dtEditBtn').title, r: document.getElementById('dtReverseBtn').disabled, rt: document.getElementById('dtReverseBtn').title }));
      check('關帳:詳情視窗的編輯鈕灰掉並寫原因;沖銷鈕可按、title 含「記在今天」', dd.e && dd.et === want && !dd.r && dd.rt === wantRev, dd);
      check('關帳:明細頁沒有 JS 錯誤、沒有系統小視窗', t.errors.length === 0 && t.dialogs.length === 0, [t.errors, t.dialogs]);
      await t.context.close();
      // 關帳日 10/06:10/10 的列還能操作、複式單 10/06 算已關帳
      const b2 = makeBackend({ closedThrough: '2026-10-06' });
      const t2 = await openPage(browser, b2, '/journals');
      await t2.page.waitForSelector('#rows tr[data-id="1"]');
      const open1 = await t2.page.$eval('#rows tr[data-id="1"]', (tr) => ({ cls: tr.className, first: tr.children[0].textContent.trim(), eDis: tr.querySelector('[data-act=edit]').disabled, eTitle: tr.querySelector('[data-act=edit]').title }));
      check('關帳日 10/06:10/10 的列沒鎖(沒灰字、沒鎖頭、✏️ 可按、title 還是「編輯」)', !/closed-row/.test(open1.cls) && open1.first === '2026-10-10' && !open1.eDis && open1.eTitle === '編輯', open1);
      check('關帳日 10/06:複式單(10/06,邊界含當天)的列標為已關帳(🔒),↺ 可按且 title 含「記在今天」', /🔒/.test(await t2.page.textContent('#rows tr[data-id="4"] td:first-child')) && !(await t2.page.isDisabled('#rows tr[data-id="4"] [data-act=reverse]')) && /記在今天/.test(await t2.page.getAttribute('#rows tr[data-id="4"] [data-act=reverse]', 'title')));
      check('關帳日 10/06:沒關帳的列 ↺ title 仍是「沖銷這筆」', (await t2.page.getAttribute('#rows tr[data-id="1"] [data-act=reverse]', 'title')) === '沖銷這筆');
      await t2.context.close();
    }
    {
      // 外網元件(Bootstrap / Sortable)沒載入:清單照出、記一筆視窗用備援開得起來、排序講白話
      const b = makeBackend({ noBootstrap: true, noSortable: true });
      const t = await openPage(browser, b, '/journals');
      const P = t.page;
      await P.waitForSelector('#rows tr[data-id="1"]');
      check('Bootstrap 沒載入(明細頁):清單正常顯示、沒有 JS 錯誤', (await P.$$('#rows tr[data-id]')).length === 4 && t.errors.length === 0, t.errors);
      await P.click('#newBtn');
      check('Bootstrap 沒載入:「記一筆」視窗用備援開得起來(看得到金額欄)', await P.isVisible('#jmAmount') && await P.isVisible('#jmSaveBtn'));
      await P.click('.reorder-btn >> nth=0');
      check('Bootstrap 沒載入:按排序鈕(同時 Sortable 也沒載入)講白話,不整頁壞掉', /排序功能暫時用不了/.test(await P.textContent('#jmError')) && !/not defined|Sortable/.test(await P.textContent('#jmError')) && t.errors.length === 0, [await P.textContent('#jmError'), t.errors]);
      await P.click('#journalModal button:has-text("取消")');
      check('Bootstrap 沒載入:按「取消」可關掉視窗', !(await P.isVisible('#jmAmount')));
      await t.context.close();
    }

    {
      // 後端回 409「這張單剛才已經送出成功了」(回應遺失、其實已經記進去):關表單、重載明細、換新單號
      const b = makeBackend({ postConflict409: true });
      const t = await openPage(browser, b, '/journals');
      const P = t.page;
      await P.waitForSelector('#rows tr[data-id="1"]');
      const fillAndSave = async () => {
        await P.click('#newBtn');
        await P.selectOption('#jmSubject', '2');
        await P.selectOption('#jmOut', '5');
        await P.fill('#jmAmount', '100');
        await P.click('#jmSaveBtn');
      };
      const lists = () => callsTo(b, 'GET', /\/journals$/).length;
      const before = lists();
      await fillAndSave();
      await P.waitForFunction(() => !document.getElementById('journalModal').classList.contains('show'));
      for (let i = 0; i < 40 && lists() === before; i++) await sleep(50);
      check('409「剛才已經送出成功了」:表單關掉、明細列表重新抓一次、紅字沒有跳出來', lists() === before + 1 && !(await P.isVisible('#jmError')), [before, lists()]);
      check('409 之後頁面上留一句白話(含後端那句話),沒有狀態碼', /剛才已經送出成功了/.test(await P.textContent('#opMsg')) && !/409/.test(await P.textContent('#opMsg')), await P.textContent('#opMsg'));
      await fillAndSave();
      await P.waitForFunction(() => !document.getElementById('journalModal').classList.contains('show'));
      const ps = callsTo(b, 'POST', /\/journals$/);
      check('409 之後再記一筆:換新的防重複單號', ps.length === 2 && !!ps[0].body.client_request_id && ps[0].body.client_request_id !== ps[1].body.client_request_id, ps.map((p) => p.body.client_request_id));
      await t.context.close();
    }
    {
      // 連 Bootstrap 樣式表也載不到:沒有備援樣式的話 d-none 不生效,「載入中」收不掉、表單全攤開
      const b = makeBackend({ noCss: true });
      const t = await openPage(browser, b, '/dashboard');
      await t.page.waitForSelector('#content:not(.d-none)');
      check('樣式表 404(儀表板):「載入中」收掉了、頁首出現「頁面樣式載不出來(店內連不上外網),功能照常」', !(await t.page.isVisible('#loading')) && await t.page.isVisible('#cc-style-warn') && /頁面樣式載不出來\(店內連不上外網\),功能照常/.test(await t.page.textContent('#cc-style-warn')) && t.errors.length === 0, t.errors);
      await t.context.close();
      const tj = await openPage(browser, makeBackend({ noCss: true }), '/journals');
      const P = tj.page;
      await P.waitForSelector('#rows tr[data-id="1"]');
      const vis = () => P.evaluate(() => ({
        modals: [...document.querySelectorAll('.modal')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.id),
        emptyAlerts: [...document.querySelectorAll('.alert')].filter((e) => getComputedStyle(e).display !== 'none' && !e.textContent.trim()).length,
        loading: getComputedStyle(document.getElementById('loading')).display,
      }));
      let v = await vis();
      check('樣式表 404(明細頁):一張表單都沒攤開、沒有空的紅框、「載入中」收掉', v.modals.length === 0 && v.emptyAlerts === 0 && v.loading === 'none' && await P.isVisible('#cc-style-warn'), v);
      await P.click('#newBtn');
      v = await vis();
      check('樣式表 404:按「記一筆」只看得到那一張表單(不是三張)', v.modals.length === 1 && v.modals[0] === 'journalModal' && await P.isVisible('#jmSaveBtn') && !(await P.isVisible('#jmError')), v);
      check('樣式表 404:沒有 JS 錯誤、沒有系統小視窗', tj.errors.length === 0 && tj.dialogs.length === 0, [tj.errors, tj.dialogs]);
      await tj.context.close();
      // 樣式表正常時不出現這條提示
      const tn = await openPage(browser, makeBackend(), '/dashboard');
      await tn.page.waitForSelector('#content:not(.d-none)');
      check('樣式表正常:沒有「頁面樣式載不出來」提示', (await tn.page.$('#cc-style-warn')) === null && (await tn.page.$('#cc-fallback-css')) === null);
      await tn.context.close();
    }

    // ============ 8. 報表頁 ============
    section('8. reports.html');
    {
      const b = makeBackend({ cpFail: true });
      const t = await openPage(browser, b, '/reports');
      const P = t.page;
      await P.waitForSelector('#mContent:not(.d-none)');
      check('月報:負的月損益顯示 -$300', (await P.textContent('#mKpiProfit')) === '-$300', await P.textContent('#mKpiProfit'));
      check('月報標題白話:沒有 (t1)/(t2)/(t3)', !/\(t[1-5]\)/.test(await P.textContent('body')));
      check('月報:負數科目占比條寬 0(不是 width:-xx%)', await P.evaluate(() => {
        const bars = [...document.querySelectorAll('#mIncomeBody .bar-inner')].map((e) => e.style.width);
        return bars.length === 2 && bars[1] === '0px' || bars[1] === '0%';
      }), await P.$$eval('#mIncomeBody .bar-inner', (e) => e.map((x) => x.getAttribute('style'))));
      check('XSS:科目名稱沒被執行', await P.evaluate(() => window.__xss === undefined && !document.querySelector('#mExpenseBody img')));
      check('月份預設 = 台北時間本月', (await P.inputValue('#mYear')) === taipeiDate(0).slice(0, 7));
      const [dl] = await Promise.all([P.waitForEvent('download'), P.click('button:has-text("匯出 CSV") >> nth=0')]);
      const csv = fs.readFileSync(await dl.path(), 'utf8');
      check('CSV:=HYPERLINK 開頭的儲存格前面補單引號(防公式)', csv.indexOf("'=HYPERLINK") >= 0 && csv.indexOf(',=HYPERLINK') < 0 && csv.indexOf('"=HYPERLINK') < 0, csv);
      check('CSV:負數金額維持數字(-200.00 沒被補引號)', /銷貨退回,-200\.00/.test(csv) && !/'-200/.test(csv), csv);
      check('CSV:類別寫「收入 / 費用」,不出現 t1/t2/t3', /收入/.test(csv) && !/\bt[1-5]\b/.test(csv));
      check('匯出後頁面旁邊有「已匯出」訊息', /已匯出月報/.test(await P.textContent('#mMsg')));

      // 對象報表:查詢失敗時按匯出 → 頁內提示
      await P.click('.report-tab[data-pane=counterparties]');
      await P.waitForSelector('#cLoading .text-danger');
      check('對象報表預設日期 = 台北今天往前 30 天', (await P.inputValue('#cTo')) === taipeiDate(0) && (await P.inputValue('#cFrom')) === taipeiDate(-30), [await P.inputValue('#cFrom'), await P.inputValue('#cTo')]);
      check('對象報表後端 500:顯示白話,不洩漏 stack', /系統暫時有問題/.test(await P.textContent('#cLoading')) && !/stack/.test(await P.textContent('#cLoading')));
      await P.click('button:has-text("匯出 CSV") >> nth=2');
      check('還沒查到結果就按匯出:頁內提示「請先按查詢」,沒有系統小視窗', /請先按「查詢」/.test(await P.textContent('#cMsg')) && t.dialogs.length === 0);
      b.sc.cpFail = false;
      await P.click('#pane-counterparties button:has-text("查詢")');
      await P.waitForSelector('#cContent:not(.d-none)');
      const cpTxt = await P.textContent('#cBody');
      check('對象報表:顯示統編欄、停用對象標「已停用」並變淡', /12345678/.test(cpTxt) && /已停用/.test(cpTxt) && (await P.$$eval('#cBody tr', (rs) => rs[0].getAttribute('style'))).indexOf('opacity') >= 0);
      check('對象報表:收入為負數時照實顯示 -$50(不是破折號)', /-\$50(?!\d)/.test(cpTxt), cpTxt);
      check('對象報表:淨額負數 -$500、XSS 名稱被跳脫', /-\$500/.test(cpTxt) && await P.evaluate(() => !document.querySelector('#cBody b')));
      const cq = b.calls.filter((c) => c.path.endsWith('/reports/counterparties')).pop();
      check('對象報表請求帶 from/to', cq.query.from === taipeiDate(-30) && cq.query.to === taipeiDate(0), cq.query);
      await P.click('.report-tab[data-pane=yearly]');
      await P.waitForSelector('#yContent:not(.d-none)');
      check('年報有畫趨勢圖,沒有 JS 錯誤', await P.evaluate(() => window.__charts.length >= 1) && t.errors.length === 0, t.errors);
      await t.context.close();
    }

    {
      // 月報 / 年報上方的待審提示、已關帳標示、圖表載不出來
      for (const [label, opt, expectFn] of [
        ['3 筆 $12,820', { pending: { count: 3, total: 12820 } }, (tx) => /還有 3 筆、合計 \$12,820 在待審,沒有算進下面的數字/.test(tx) && /去待審/.test(tx)],
        ['0 筆', { pending: { count: 0, total: 0 } }, (tx) => tx === ''],
        ['查不到(null)', { pending: null }, (tx) => /待審筆數暫時查不到/.test(tx)],
        ['後端舊版沒這個欄位', {}, (tx) => tx === ''],
      ]) {
        const bp = makeBackend(opt);
        const tp = await openPage(browser, bp, '/reports');
        await tp.page.waitForSelector('#mContent:not(.d-none)');
        const mt = (await tp.page.textContent('#mPending')).trim();
        await tp.page.click('.report-tab[data-pane=yearly]');
        await tp.page.waitForSelector('#yContent:not(.d-none)');
        const yt = (await tp.page.textContent('#yPending')).trim();
        check('月報 / 年報待審提示 · ' + label, expectFn(mt) && expectFn(yt) && tp.errors.length === 0, [mt, yt, tp.errors]);
        if (label.startsWith('3 筆')) check('月報待審提示:連到 /pending', (await tp.page.getAttribute('#mPending a', 'href')) === '/pending');
        await tp.context.close();
      }
      const bc = makeBackend({ monthClosed: true });
      const tc = await openPage(browser, bc, '/reports');
      await tc.page.waitForSelector('#mContent:not(.d-none)');
      check('月份已關帳:標題旁標「已關帳」', await tc.page.isVisible('#mClosedTag') && /已關帳/.test(await tc.page.textContent('#mClosedTag')) && /2026-10/.test(await tc.page.textContent('#mContent .section-title')));
      await tc.context.close();
      for (const mc of [false, undefined]) {
        const bo = makeBackend({ monthClosed: mc });
        const to = await openPage(browser, bo, '/reports');
        await to.page.waitForSelector('#mContent:not(.d-none)');
        check('月份沒關帳(' + (mc === undefined ? '後端舊版沒這個欄位' : 'closed=false') + '):不標「已關帳」', !(await to.page.isVisible('#mClosedTag')));
        await to.context.close();
      }
      const bn = makeBackend({ noChart: true });
      const tn = await openPage(browser, bn, '/reports');
      await tn.page.waitForSelector('#mContent:not(.d-none)');
      await tn.page.click('.report-tab[data-pane=yearly]');
      await tn.page.waitForSelector('#yContent:not(.d-none)');
      const bodyN = await tn.page.innerText('body');
      check('圖表載不出來(年報):KPI 有值、寫「圖表載不出來(店內連不上外網)…」、不出現「載入失敗」、圖例照列', (await tn.page.textContent('#yKpiIncome')) === '$1' && /圖表載不出來\(店內連不上外網\),上面的數字不受影響/.test(await tn.page.textContent('#yChartMsg')) && await tn.page.isVisible('#yChartMsg') && !/載入失敗/.test(bodyN) && /菜色/.test(await tn.page.textContent('#yIncomeLegend')) && tn.errors.length === 0, [bodyN.slice(0, 200), tn.errors]);
      await tn.context.close();
    }

    // ============ 9. 設定頁 ============
    section('9. settings.html');
    {
      const b = makeBackend();
      const t = await openPage(browser, b, '/settings');
      const P = t.page;
      await P.waitForSelector('#content:not(.d-none)');
      check('設定頁:全域模式下拉 / 儲存模式鈕都拿掉', (await P.$$('#modeCards, #saveModeBtn, .mode-card')).length === 0);
      const cells = await P.$$eval('#modeRows tr', (rs) => rs.map((r) => [...r.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim())));
      const rows = cells.map((c) => c.join(' | '));
      const find = (k) => (cells.find((c) => c[0] === k) || []).join(' | ');
      check('唯讀表:POS 收班 = 直接入帳(每來源真實模式)', /直接入帳/.test(find('POS 收班')) && !/跟著全域/.test(find('POS 收班')), find('POS 收班'));
      check('唯讀表:訂金抵用 = 進待審;支出單(事件鍵 expense_created)= 直接入帳;訂金 / 刷卡撥款(來源 leo_inline)= 直接入帳且不是跟著全域', /進待審,老闆按過才入帳/.test(find('訂金抵用')) && /直接入帳/.test(find('支出單')) && !/跟著全域/.test(find('支出單')) && /直接入帳/.test(find('訂金 / 刷卡撥款')) && !/跟著全域/.test(find('訂金 / 刷卡撥款')), rows);
      check('唯讀表:沒個別設定的來源(進貨 / 薪資)標「(跟著全域)」', ['進貨', '薪資'].every((k) => /跟著全域/.test(find(k))), rows);
      check('唯讀表有全域預設列;說明「由技術端設定」', rows.some((r) => /^全域預設/.test(r)) && /這些由技術端設定,要改請告訴技術/.test(await P.textContent('#modeCard')));
      const seen = await P.innerText('body');
      check('設定頁(畫面上看得到的字)沒有 REVIEW/AUTO/MANUAL/posting_mode/webhook/403 這類術語', !/REVIEW|AUTO|MANUAL|posting_mode|webhook|journal_logs|403/.test(seen), seen.match(/REVIEW|AUTO|MANUAL|posting_mode|webhook|journal_logs|403/));
      check('幣別 / 會計年度起月 disabled 並標「尚未啟用」', (await P.isDisabled('#fCurrency')) && (await P.isDisabled('#fFiscalMonth')) && seen.split('尚未啟用').length - 1 === 2);
      check('名稱 maxlength=50、公司全名 maxlength=100', (await P.getAttribute('#fName', 'maxlength')) === '50' && (await P.getAttribute('#fCompany', 'maxlength')) === '100');
      await P.fill('#fName', '新名稱');
      await P.click('#saveBookBtn');
      await P.waitForSelector('#bookCard .cc-result.ok');
      const pa = callsTo(b, 'PATCH', /^\/B\/NEST0001$/);
      check('儲存帳本資料:只送 name / company_name / tax_id(不送尚未啟用的欄位)', pa.length === 1 && JSON.stringify(Object.keys(pa[0].body).sort()) === '["company_name","name","tax_id"]', pa);
      check('儲存成功訊息留在卡片裡、不自動消失', await P.isVisible('#bookCard .cc-result.ok'));
      check('沒有 JS 錯誤、沒有系統小視窗', t.errors.length === 0 && t.dialogs.length === 0, [t.errors, t.dialogs]);
      await t.context.close();
      const b2 = makeBackend({ role: 'viewer' });
      const t2 = await openPage(browser, b2, '/settings');
      await t2.page.waitForSelector('#content:not(.d-none)');
      check('唯讀角色:顯示橫幅(中文角色名)、儲存鈕灰掉', await t2.page.isVisible('#readOnlyBanner') && /唯讀/.test(await t2.page.textContent('#myRoleName')) && await t2.page.isDisabled('#saveBookBtn'));
      await t2.context.close();
    }
    {
      // 關帳:只有擁有者看得到日期欄和儲存鈕,其他人只看文字
      const b = makeBackend({ role: 'owner', closedThrough: '2026-09-30' });
      const t = await openPage(browser, b, '/settings');
      const P = t.page;
      await P.waitForSelector('#content:not(.d-none)');
      check('關帳(擁有者):看得到「關帳到」日期欄和儲存鈕,預填目前關帳日 2026-09-30', await P.isVisible('#fClosed') && await P.isVisible('#saveCloseBtn') && (await P.inputValue('#fClosed')) === '2026-09-30' && !(await P.isVisible('#closeText')));
      const closeTxt = await P.textContent('#closeCard');
      check('關帳說明用白話(「關帳日以前的帳不能再改。要解鎖按「取消關帳」,或把日期往前調」),不出現欄位名', /關帳日以前的帳不能再改。要解鎖按「取消關帳」,或把日期往前調/.test(closeTxt) && !/closed_through|PATCH|409/.test(closeTxt), closeTxt);
      const D1 = taipeiDate(-1);   // 關帳日不能晚於今天:存的日期一律用昨天
      check('關帳日期欄 max = 台北時間今天;目前已關帳所以「取消關帳」鈕可按', (await P.getAttribute('#fClosed', 'max')) === taipeiDate(0) && await P.isVisible('#cancelCloseBtn') && await P.isEnabled('#cancelCloseBtn'), await P.getAttribute('#fClosed', 'max'));
      await P.fill('#fClosed', taipeiDate(1));
      await P.click('#saveCloseBtn');
      await P.waitForSelector('#closeCard .cc-result.bad');
      check('關帳日晚於今天:擋下、白話說明、沒送請求', /不能晚於今天/.test(await P.textContent('#closeCard .cc-result')) && callsTo(b, 'PATCH', /^\/B\/NEST0001$/).length === 0);
      await P.fill('#fClosed', D1);
      await P.click('#saveCloseBtn');
      await P.waitForSelector('#closeCard .cc-result.ok');
      const pc = callsTo(b, 'PATCH', /^\/B\/NEST0001$/);
      check('關帳:儲存只送 closed_through = 昨天,結果留在關帳卡片裡', pc.length === 1 && JSON.stringify(pc[0].body) === JSON.stringify({ closed_through: D1 }) && new RegExp('已關帳到 ' + D1).test(await P.textContent('#closeCard .cc-result')), pc);
      await P.fill('#fClosed', '');
      await P.click('#saveCloseBtn');
      await P.waitForFunction(() => { const r = document.querySelector('#closeCard .cc-result'); return !!r && /已取消關帳/.test(r.textContent); });
      const pc2 = callsTo(b, 'PATCH', /^\/B\/NEST0001$/);
      check('取消關帳:日期清空再儲存 → 送 closed_through = null', pc2.length === 2 && pc2[1].body.closed_through === null, pc2.map((c) => c.body));
      check('沒關帳時「取消關帳」鈕灰掉', await P.isDisabled('#cancelCloseBtn'));
      // 獨立的「取消關帳」鈕(iOS 日期欄不一定有清除):先關帳,再按取消 → 自畫確認框 → 確認才送
      await P.fill('#fClosed', D1);
      await P.click('#saveCloseBtn');
      await P.waitForFunction(() => document.getElementById('cancelCloseBtn').disabled === false);
      await P.click('#cancelCloseBtn');
      await P.waitForSelector('.cc-dlg');
      check('取消關帳:跳出自畫確認框,文案「確定取消關帳?取消後以前的帳又可以改了」', /確定取消關帳\?取消後以前的帳又可以改了/.test(await P.textContent('.cc-dlg')) && t.dialogs.length === 0);
      await P.click('.cc-dlg .cc-btn:not(.ok):not(.danger)');
      await sleep(150);
      check('取消關帳:按「先不要」不送請求', callsTo(b, 'PATCH', /^\/B\/NEST0001$/).length === 3);
      await P.click('#cancelCloseBtn');
      await P.waitForSelector('.cc-dlg');
      await P.click('.cc-dlg .cc-btn.danger');
      await P.waitForFunction(() => { const r = document.querySelector('#closeCard .cc-result'); return !!r && /已取消關帳/.test(r.textContent) && document.getElementById('cancelCloseBtn').disabled; });
      const pc3 = callsTo(b, 'PATCH', /^\/B\/NEST0001$/);
      check('取消關帳:確認後 PATCH 的 closed_through 是 null,日期欄清空、取消鈕又灰掉', pc3.length === 4 && pc3[3].body.closed_through === null && (await P.inputValue('#fClosed')) === '', pc3.map((c) => c.body));
      check('關帳頁沒有 JS 錯誤、沒有系統小視窗', t.errors.length === 0 && t.dialogs.length === 0, [t.errors, t.dialogs]);
      await t.context.close();
      for (const role of ['editor', 'admin', 'viewer']) {
        const b2 = makeBackend({ role, closedThrough: '2026-09-30' });
        const t2 = await openPage(browser, b2, '/settings');
        await t2.page.waitForSelector('#content:not(.d-none)');
        check('關帳(' + role + '):看不到日期欄、儲存鈕和「取消關帳」鈕,只看到文字「目前關帳到 2026-09-30」', !(await t2.page.isVisible('#fClosed')) && !(await t2.page.isVisible('#saveCloseBtn')) && !(await t2.page.isVisible('#cancelCloseBtn')) && await t2.page.isVisible('#closeText') && /目前關帳到 2026-09-30/.test(await t2.page.textContent('#closeText')), await t2.page.textContent('#closeText'));
        await t2.context.close();
      }
      const b3 = makeBackend({ role: 'editor' });
      const t3 = await openPage(browser, b3, '/settings');
      await t3.page.waitForSelector('#content:not(.d-none)');
      check('關帳(沒設過,記帳員):文字顯示「尚未關帳」', /尚未關帳/.test(await t3.page.textContent('#closeText')) && !(await t3.page.isVisible('#fClosed')));
      await t3.context.close();
    }

    // ============ 10. 主檔頁 ============
    section('10. setup.html');
    {
      const b = makeBackend({ delayCp: 400 });
      const t = await openPage(browser, b, '/setup');
      const P = t.page;
      await P.waitForSelector('#acctRows tr[data-id="5"]', { state: 'attached' });
      await P.click('.master-tab[data-pane=accounts]');
      check('帳戶「綁定對象」第一次就顯示名字(不是 #12)', /應付廠商/.test(await P.textContent('#acctRows tr[data-id="5"]')) && !/#12/.test(await P.textContent('#acctRows')), await P.textContent('#acctRows tr[data-id="5"]'));
      check('XSS:科目 / 帳戶 / 對象名稱都被跳脫', await P.evaluate(() => window.__xss === undefined && !document.querySelector('#subjRows img, #acctRows b, #cpRows s')));
      check('分頁標籤沒有 t1/t2 代號', !/\bt[1-5]\b/.test(await P.textContent('.master-tabs, #subjSubtabs')));
      check('沒有 journals / counterparty 之類英文術語', !/journal|counterpart/i.test(await P.textContent('.section-card')));

      // needs_confirm:帳戶改名
      await P.click('#acctRows tr[data-id="5"] [data-act=edit-acct]');
      await P.fill('#amName', '現金(櫃檯)');
      await P.click('#amSaveBtn');
      await P.waitForSelector('.cc-dlg');
      const dtxt = await P.textContent('.cc-dlg');
      check('409 needs_confirm:用自畫框顯示後端白話文案(含 128 筆)', /128 筆記錄在用/.test(dtxt) && t.dialogs.length === 0, dtxt);
      await P.click('.cc-dlg .cc-btn:not(.danger)');   // 取消
      await sleep(200);
      let patches = callsTo(b, 'PATCH', /accounts\/5$/);
      check('按取消:不重送、只有第一次(沒帶 confirm)的請求', patches.length === 1 && !('confirm' in patches[0].body), patches);
      check('取消後編輯視窗還開著、沒有錯誤紅字', await P.evaluate(() => document.getElementById('accountModal').classList.contains('show') && document.getElementById('amError').classList.contains('d-none')));
      await P.click('#amSaveBtn');
      await P.waitForSelector('.cc-dlg');
      await P.click('.cc-dlg .cc-btn.danger');
      await P.waitForFunction(() => !document.getElementById('accountModal').classList.contains('show'));
      patches = callsTo(b, 'PATCH', /accounts\/5$/);
      check('確定要改:帶 confirm:true 重送,且只送有改的欄位(name)', patches.length === 3 && patches[2].body.confirm === true && patches[2].body.name === '現金(櫃檯)' && !('type' in patches[2].body), patches.map((p) => p.body));
      await P.waitForSelector('#acctRows tr[data-id="5"] + .cc-result-row');
      check('儲存成功訊息接在該列旁邊', /已儲存/.test(await P.textContent('#acctRows tr[data-id="5"] + .cc-result-row')));

      // 改科目大類:400 直接顯示
      await P.click('.master-tab[data-pane=subjects]');
      await P.click('#subjRows tr[data-id="2"] [data-act=edit-subj]');
      await P.selectOption('#smParentType', 't2');
      await P.click('#smSaveBtn');
      await P.waitForSelector('#smError:not(.d-none)');
      check('改科目大類被擋(400):原文白話直接顯示在視窗裡', /改大類會讓歷史報表整批變動/.test(await P.textContent('#smError')), await P.textContent('#smError'));
      await P.evaluate(() => document.getElementById('subjectModal').classList.remove('show'));

      // 升級臨時對象
      await P.click('.master-tab[data-pane=counterparties]');
      await P.click('#cpRows tr[data-id="13"] [data-act=promote-cp]');
      await P.waitForSelector('.cc-dlg');
      check('升級對象:自畫確認框', t.dialogs.length === 0 && /不能再改回臨時/.test(await P.textContent('.cc-dlg')));
      await P.click('.cc-dlg .cc-btn.ok');
      await P.waitForSelector('#cpRows .cc-result');
      const pc = callsTo(b, 'PATCH', /counterparties\/13$/);
      check('升級對象:送出 is_temporary=false,結果接在該列旁邊', pc.length === 1 && pc[0].body.is_temporary === false && /已升級為正式對象/.test(await P.textContent('#cpRows .cc-result')), pc);
      check('主檔頁沒有 JS 錯誤、全程沒有系統小視窗', t.errors.length === 0 && t.dialogs.length === 0, [t.errors, t.dialogs]);
      await t.context.close();
    }
    {
      // 考勤包 5 的三個薪資負債科目:改名要二次確認(409);名字要與主 repo 一字不差(第三個是全形破折號 U+2014)
      const NAMES = [[7, '應付代扣稅款'], [8, '應付勞退自提'], [9, '其他應付款—員工']];
      const b = makeBackend({ guardByName: true, extraAccounts: true });
      const t = await openPage(browser, b, '/setup');
      const P = t.page;
      await P.waitForSelector('#acctRows tr[data-id="5"]', { state: 'attached' });
      await P.click('.master-tab[data-pane=accounts]');
      const shown = [];
      for (const [id, nm] of NAMES) shown.push((await P.textContent(`#acctRows tr[data-id="${id}"]`)).indexOf(nm) >= 0);
      check('三個新負債科目名稱照樣顯示(第三個的破折號是全形 U+2014,與主 repo 一字不差)', shown.every(Boolean) && NAMES[2][1] === '其他應付款—員工' && NAMES[2][1].charCodeAt(5) === 0x2014, shown);
      for (const [id, nm] of NAMES) {
        await P.click(`#acctRows tr[data-id="${id}"] [data-act=edit-acct]`);
        await P.fill('#amName', nm + '(改)');
        await P.click('#amSaveBtn');
        await P.waitForSelector('.cc-dlg');
        const dtxt = await P.textContent('.cc-dlg');
        const before = callsTo(b, 'PATCH', new RegExp('accounts/' + id + '$'));
        check('改名「' + nm + '」→ 409 要二次確認:跳自畫框、文案是後端白話、第一次請求沒帶 confirm', /128 筆記錄在用/.test(dtxt) && t.dialogs.length === 0 && before.length === 1 && !('confirm' in before[0].body), [dtxt, before]);
        await P.click('.cc-dlg .cc-btn:not(.danger)');   // 取消
        await sleep(150);
        await P.evaluate(() => document.getElementById('accountModal').classList.remove('show'));
      }
      // 對照組:不在守衛名單裡的帳戶(id 6)改名,不該被要求二次確認
      await P.click('#acctRows tr[data-id="6"] [data-act=edit-acct]');
      await P.fill('#amName', '應付帳款-乙');
      await P.click('#amSaveBtn');
      await P.waitForFunction(() => !document.getElementById('accountModal').classList.contains('show'));
      check('對照組:不在守衛名單的帳戶改名直接存成功,沒有跳確認框', !(await P.$('.cc-dlg')) && callsTo(b, 'PATCH', /accounts\/6$/).length === 1);
      check('三個科目改名測試沒有 JS 錯誤', t.errors.length === 0 && t.dialogs.length === 0, [t.errors, t.dialogs]);
      await t.context.close();
    }
    {
      // Bootstrap 沒載入(店內連不上外網):頁面不死,視窗用備援
      const b = makeBackend({ noBootstrap: true });
      const t = await openPage(browser, b, '/setup');
      const P = t.page;
      await P.waitForSelector('#acctRows tr[data-id="5"]', { state: 'attached' });
      await P.click('.master-tab[data-pane=accounts]');
      await P.click('#acctRows tr[data-id="5"] [data-act=edit-acct]');
      check('Bootstrap 沒載入(主檔頁):清單照樣出來、編輯視窗用備援開得起來、沒有 JS 錯誤', await P.isVisible('#accountModal') && (await P.inputValue('#amName')) === '現金袋' && t.errors.length === 0, t.errors);
      await P.click('#accountModal button:has-text("取消")');
      check('Bootstrap 沒載入(主檔頁):按「取消」可關掉視窗', !(await P.isVisible('#accountModal')));
      await t.context.close();
    }

    // ============ 11. 對帳頁 ============
    section('11. reconcile.html');
    {
      const b = makeBackend();
      const t = await openPage(browser, b, '/reconcile');
      const P = t.page;
      await P.waitForSelector('#diffList .ev-row');
      const g = callsTo(b, 'GET', /\/reconciliation$/)[0];
      check('預設日期 = 台北時間昨天', g.query.date === taipeiDate(-1) && (await P.inputValue('#datePick')) === taipeiDate(-1), [g.query, taipeiDate(-1)]);
      check('XSS / 引號:external_id 與說明被跳脫,沒有執行', await P.evaluate(() => window.__xss2 === undefined && window.__xss === undefined && !document.querySelector('#diffList img')));
      const btns = await P.$$eval('#diffList [data-act=repush]', (bs) => bs.map((x) => x.dataset.ext));
      check('補送鈕只在後端 can_repush=true 的列出現(「可補推」字樣但 can_repush=false 的不顯示)', btns.length === 1 && btns[0] === "x'); window.__xss2=1;//", btns);
      check('補送鈕沒有 onclick 字串(改 data-* + 事件委派)', (await P.$$('#diffList [onclick]')).length === 0);
      check('補送中的列顯示「補送中…」且不能按', /補送中/.test(await P.textContent('#diffList .ev-row:nth-child(3)')) && (await P.$$eval('#diffList .ev-row:nth-child(3) button', (b2) => b2[0].disabled)));
      check('來源 / 事件名中文(點餐結帳、支出單、收班入帳、薪資)', /點餐結帳/.test(await P.textContent('#diffList')) && /薪資/.test(await P.textContent('#okList')) && !/payroll_finalized|leo_hr|其他/.test(await P.textContent('#okList')) && /訂金/.test(await P.textContent('#transitList')) && /收訂金/.test(await P.textContent('#transitList')));
      check('金額 $1,000 顯示', /\$1,000/.test(await P.textContent('#diffList')));
      check('有跑過:空的欄位不出現「還沒對過帳」警告', !(await P.isVisible('#notRan')));
      check('GET 帶 include_stale=1(後端才會回舊紀錄)', g.query.include_stale === '1', g.query);
      check('現場已沒有的舊紀錄:不混在「對平」裡、預設隱藏、可勾選顯示', !/OLD-9/.test(await P.textContent('#okList')) && !(await P.isVisible('#staleCard')) && (await P.isVisible('#staleToggle')) && /OLD-9/.test(await P.textContent('#staleList')));

      // 點補送:引號字串原樣送回
      await P.click('#diffList [data-act=repush]');
      await P.waitForSelector('#diffList .ev-row .cc-result.ok');
      const rp = callsTo(b, 'POST', /reconciliation\/repush$/);
      check('補送:POST 帶原樣的 external_id(含單引號)', rp.length === 1 && rp[0].body.external_id === "x'); window.__xss2=1;//" && rp[0].body.external_source === 'leo_pos', rp);
      check('補送:按鈕立刻鎖住(連點不會送第二次)', (await P.$$eval('#diffList [data-act=repush]', (bs) => bs[0].disabled)) && callsTo(b, 'POST', /repush$/).length === 1);
      check('補送結果留在該列旁邊(不是 alert)', /已排入補送/.test(await P.textContent('#diffList .ev-row .cc-result')) && t.dialogs.length === 0);

      // 立刻重新對帳
      await P.click('#runBtn');
      await P.waitForSelector('#topMsg .cc-result');
      check('立刻重新對帳:POST run 帶 date,結果顯示在頁內', callsTo(b, 'POST', /reconciliation\/run$/).length === 1 && /已重新對帳/.test(await P.textContent('#topMsg')));
      check('沒有 JS 錯誤、沒有系統小視窗', t.errors.length === 0 && t.dialogs.length === 0, [t.errors, t.dialogs]);
      await t.context.close();

      // 該日沒跑過:ran=false
      const b2 = makeBackend({ reconRan: false });
      const t2 = await openPage(browser, b2, '/reconcile');
      await t2.page.waitForSelector('#notRan:not(.d-none)');
      const diffTxt = await t2.page.textContent('#diffList');
      check('ran=false:顯示「還沒對過帳」,不顯示「沒有問題 🎉」', !/沒有問題 🎉/.test(diffTxt) && /還沒對過帳/.test(diffTxt));
      await t2.context.close();

      // 載入失敗:頁內訊息
      const b3 = makeBackend({ reconFail: true });
      const t3 = await openPage(browser, b3, '/reconcile');
      await t3.page.waitForSelector('#topMsg .cc-result.bad');
      check('載入失敗:頁內顯示白話、不洩漏英文、沒有系統小視窗、沒有未捕捉錯誤', !/db down/.test(await t3.page.textContent('#topMsg')) && t3.dialogs.length === 0 && t3.errors.length === 0, [t3.errors, t3.dialogs]);
      await t3.context.close();
    }
  } finally {
    await browser.close();
  }

  console.log('\n══════════════════════════════');
  console.log(`PASS ${nPass}   FAIL ${nFail}` + (process.env.CC_MUTATE ? `   (突變模式:${process.env.CC_MUTATE})` : ''));
  if (nFail) { console.log('失敗項目:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(nFail ? 1 : 0);
}

main().catch((e) => { console.error('驗收腳本本身出錯:', e); process.exit(2); });
