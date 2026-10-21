// scripts/test_posting_mode_alias.js
// 反向事件 pos_deposit_offset_return(主 repo 訂金體檢包 7;整單退款把 POS 訂金折抵還回訂金)的入帳方式要跟原事件
// pos_deposit_offset 一樣,而且分錄守恆。不需要 PostgreSQL / express / bcrypt:載入 posting.js 時把這幾個模組換成空殼,
// 只測純函式 resolvePostingMode / compositeGap。
//   node scripts/test_posting_mode_alias.js        全過 exit 0,有紅 exit 1

'use strict';

const Module = require('module');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`); }
}
function eq(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), name, { actual, expected });
}

// ── 載入 posting.js 用的空殼 ────────────────────────────────────────────
const noopRouter = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => undefined) });   // router.get/post/use… 都是空操作;posting.js 自己掛上去的 .pure / .helpers 照常取得
const stubs = {
  express: Object.assign(() => ({}), { Router: noopRouter }),
  bcrypt: {},
  jsonwebtoken: {},
  pg: { Pool: function Pool() {} },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  if (/(^|[\\/])db(\.js)?$/.test(request) && parent && /posting\.js$/.test(parent.filename || '')) {
    return { query: async () => ({ rows: [] }), withTransaction: async () => ({}) };
  }
  if (/(^|[\\/])auth(\.js)?$/.test(request) && parent && /posting\.js$/.test(parent.filename || '')) {
    return { requireAuth: (req, res, next) => next && next() };
  }
  return realLoad.apply(this, arguments);
};

const posting = require(path.join('..', 'src', 'routes', 'posting.js'));
Module._load = realLoad;
const { resolvePostingMode, compositeGap } = posting.pure;

console.log('[resolvePostingMode · 反向事件跟著原事件]');
// 正式帳本 NEST0001 的設定(migration 011):收班自動、訂金抵用進待審
const prod = {
  posting_mode: 'auto',   // 故意把全域設成 auto:以前反向事件會掉到這裡,原折抵待審、還回卻直接入帳
  posting_mode_per_source: { leo_pos: { pos_shift_settled: 'auto', pos_deposit_offset: 'review' }, leo_expense: 'review' },
};
eq(resolvePostingMode(prod, 'leo_pos', 'pos_deposit_offset'), 'review', '原事件:訂金抵用 = 進待審');
eq(resolvePostingMode(prod, 'leo_pos', 'pos_deposit_offset_return'), 'review', '反向事件:跟著訂金抵用 = 進待審(不掉到全域 auto)');
eq(resolvePostingMode(prod, 'leo_pos', 'pos_shift_settled'), 'auto', '收班不受影響');
eq(resolvePostingMode(prod, 'leo_pos', 'something_else'), 'auto', '其他沒設定的事件照舊落到全域');

// staging NEST0099:全 auto
const staging = { posting_mode: 'review', posting_mode_per_source: { leo_pos: { pos_shift_settled: 'auto', pos_deposit_offset: 'auto' } } };
eq(resolvePostingMode(staging, 'leo_pos', 'pos_deposit_offset_return'), 'auto', 'staging:反向事件跟著 auto');

// 反向事件自己有設定就用自己的
const own = { posting_mode: 'review', posting_mode_per_source: { leo_pos: { pos_deposit_offset: 'review', pos_deposit_offset_return: 'auto' } } };
eq(resolvePostingMode(own, 'leo_pos', 'pos_deposit_offset_return'), 'auto', '有自己的設定 → 用自己的');
// 整個來源是字串 → 照字串
eq(resolvePostingMode({ posting_mode: 'review', posting_mode_per_source: { leo_pos: 'manual' } }, 'leo_pos', 'pos_deposit_offset_return'), 'manual', '來源整個設成字串 → 照字串');
// 來源沒設定 → 全域
eq(resolvePostingMode({ posting_mode: 'review', posting_mode_per_source: {} }, 'leo_pos', 'pos_deposit_offset_return'), 'review', '沒有個別設定 → 全域');
// _default 排在別名之後
const withDefault = { posting_mode: 'review', posting_mode_per_source: { leo_pos: { _default: 'auto', pos_deposit_offset: 'review' } } };
eq(resolvePostingMode(withDefault, 'leo_pos', 'pos_deposit_offset_return'), 'review', '別名比 _default 優先');

console.log('[分錄守恆 · 4101 −x / 4408 +x]');
// 主 repo enqueueDepositOffsetReversal 送出的兩條科目腳;4101、4408 都是收入類(t1)
const legs = [
  { kind: 'subject', amount: -3000, parent_type: 't1' },   // 4101
  { kind: 'subject', amount: 3000, parent_type: 't1' },    // 4408
];
eq(compositeGap(legs), 0, '還回訂金的分錄 gap = 0(雲端收得下)');
eq(compositeGap([{ kind: 'subject', amount: -3000, parent_type: 't1' }, { kind: 'subject', amount: 3000, parent_type: 't1' }].reverse()), 0, '順序不影響');
// 原折抵(4408 −x / 4101 +x)也是 0:兩筆淨額 0
eq(compositeGap([{ kind: 'subject', amount: -3000, parent_type: 't1' }, { kind: 'subject', amount: 3000, parent_type: 't1' }]), 0, '原折抵 gap = 0');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
