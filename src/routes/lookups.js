// src/routes/lookups.js
// CRUD for subjects / ag_accounts / counterparties.
// M1 階段 1a: GET list. M1 階段 1b: POST + PATCH (含 is_active soft delete).
// 沒做 hard DELETE (用 PATCH is_active=false 達成 soft delete; 已記入 journal 的不能 hard delete).
//
// 2026-10-10 記帳雲重掃 雲 7(Y18、Y19、Y20、G10、LEO 拍板 7)—— 主檔改動守衛(契約見施工計畫 §3.5):
//   · 科目代碼 / 帳戶名稱不准重複(新增、改都先查,409 白話;migration 017 的 UNIQUE 是最後防線)。
//   · 改到「被用到」的科目 / 帳戶的代碼、名稱或把它停用 → 409 needs_confirm + usage,body 帶 confirm:true 才真的改。
//     被用到 = 有分錄(含複式各腳、1:N 重分類)、有待審單引用、或現場系統推送會用代碼 / 名字找它。
//     (推送是「用名字 / 代碼找啟用中的那一筆」:改名或停用之後,每一筆 POS 收班 / 訂金 / 薪資推送都會卡住。)
//   · 已有分錄的科目不准改大類(t1 收入 → t3 費用 會讓歷史報表整批變動)→ 一律 400,請新建科目、舊的停用。
//   · 欄位型別都驗(以前 name 是陣列也會過、display_order 亂填回 500、include_inactive=0 也當成真、期初餘額收小數)。

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

const VALID_ACCOUNT_TYPES = [
  'cash', 'bank', 'digital_bank', 'time_deposit', 'investment',
  'income_account', 'liability', 'asset', 'virtual',
];
const VALID_SUBJECT_PARENT_TYPES = ['t1', 't2', 't3', 't4', 't5'];
const VALID_COUNTERPARTY_TYPES = ['income', 'expense', 'both'];
const PARENT_TYPE_ZH = { t1: '收入', t2: '成本', t3: '費用', t4: '轉帳', t5: '股東權益' };
const ACCOUNT_TYPE_ZH = {
  cash: '現金', bank: '銀行', digital_bank: '數位帳戶', time_deposit: '定存', investment: '投資',
  income_account: '收款帳戶', liability: '負債', asset: '資產', virtual: '虛擬帳戶',
};

// ── 現場系統(主 repo lib/integrations/cloudBookkeepingClient.js)推送時「用名字 / 代碼找」的主檔 ─────
// 2026-10-10 從 cloudBookkeepingClient.js grep 核對(account_ref / transfer_*_account_ref / subject_code)。
// 支出單的科目代碼另外來自主 repo subjects.cloud_subject_code 對應表(動態),那些靠「有推送來的分錄 / 待審單在用」判斷。
const POSTING_ACCOUNTS = {
  '現金袋': 'POS 收班、訂金、支出、進貨付款、薪資',
  '玉山銀行': '訂金、支出、進貨付款、薪資',
  '彰化品圓': 'POS 收班(匯款 / 刷卡)',
  'INLINE 訂金待撥': 'INLINE 訂金',
  '應付勞健保': '薪資',
};
const POSTING_ACCOUNT_PREFIXES = { '應付帳款-': '進貨(廠商應付帳款)' };
const POSTING_SUBJECTS = {
  '4101': 'POS 收班',
  '4109': 'POS 收班(服務費)',
  '4191': 'POS 收班(折讓)',
  '4198': '訂金退款(違約金)',
  '4408': '訂金',
  '5106': '進貨(沒指定科目時)',
  '5197': '進貨退回',
  '6506': 'INLINE 訂金手續費',
  '6801': '薪資',
  '6802': '薪資(勞健保)',
  '6901': '支出(對應不到科目時)',
  '7301': '進貨付款、訂金撥款、薪資繳款',
};

function postingSourceOfAccount(name) {
  if (typeof name !== 'string') return null;
  if (POSTING_ACCOUNTS[name]) return POSTING_ACCOUNTS[name];
  for (const [p, src] of Object.entries(POSTING_ACCOUNT_PREFIXES)) if (name.startsWith(p)) return src;
  return null;
}
function postingSourceOfSubject(code) {
  return code && POSTING_SUBJECTS[code] ? POSTING_SUBJECTS[code] : null;
}

// ── 欄位驗證(回 { value } 或 { error },error 是白話)─────────────────────
function vName(v, max, label) {
  if (typeof v !== 'string' || !v.trim()) return { error: `${label}必填` };
  if (v.trim().length > max) return { error: `${label}最多 ${max} 個字` };
  return { value: v.trim() };
}
function vOptStr(v, max, label) {
  if (v === null || v === '') return { value: null };
  if (typeof v !== 'string') return { error: `${label}格式不對` };
  if (v.trim().length > max) return { error: `${label}最多 ${max} 個字` };
  return { value: v.trim() || null };
}
function vCode(v) {
  if (v === null || v === '') return { value: null };
  if (typeof v !== 'string' && typeof v !== 'number') return { error: '科目代碼格式不對' };
  const s = String(v).trim();
  if (s.length > 10) return { error: '科目代碼最多 10 個字' };
  return { value: s || null };
}
function vInt(v, label, min, max) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) return { error: `${label}要是 ${min} 到 ${max} 的整數` };
  return { value: n };
}
function vBool(v, label) {
  if (v === true || v === false) return { value: v };
  return { error: `${label}只能是「是」或「否」` };
}
function vId(v) {
  if (v === null || v === '') return { value: null };
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isInteger(n) || n < 1) return { error: '選的項目不存在,請重新整理再試' };
  return { value: n };
}
function vMoneyInt(v, label) {
  if (v === undefined || v === null || v === '') return { value: 0 };
  if (typeof v !== 'number' && typeof v !== 'string') return { error: `${label}要是整數元` };
  const n = Number(v);
  if (!Number.isInteger(n)) return { error: `${label}要是整數元(不能有小數)` };
  if (Math.abs(n) > 1e12) return { error: `${label}太大了` };
  return { value: n };
}
const isTrueFlag = (v) => v === '1' || v === 'true';

// ── 引用數 ─────────────────────────────────────────────────────────
const NO_MATCH = '\u0001(無)';   // 代碼是空的時候拿來比對的字,不會撞到真資料

async function subjectUsage(bookId, s) {
  const j = await query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE j.external_source IS NOT NULL)::int AS ext
       FROM journal_logs j
      WHERE j.book_id = $1
        AND (j.subject_id = $2 OR j.reclassify_from_subject_id = $2
             OR EXISTS (SELECT 1 FROM journal_legs l WHERE l.journal_log_id = j.id AND l.subject_id = $2)
             OR EXISTS (SELECT 1 FROM journal_reclassify_targets t WHERE t.journal_id = j.id AND t.target_subject_id = $2))`,
    [bookId, s.id]
  );
  const vars = JSON.stringify({ c: s.code || NO_MATCH, i: Number(s.id), s: String(s.id) });
  const filt = '(@.subject_code == $c || @.reclassify_from_subject_code == $c'
    + ' || @.subject_id == $i || @.subject_id == $s || @.reclassify_from_subject_id == $i || @.reclassify_from_subject_id == $s)';
  const p = await query(
    `SELECT COUNT(*)::int AS n FROM pending_journals
      WHERE book_id = $1 AND status = 'pending'
        AND (jsonb_path_exists(proposed_journal, $2::jsonpath, $4::jsonb)
             OR jsonb_path_exists(proposed_journal, $3::jsonpath, $4::jsonb))`,
    [bookId, `$ ? ${filt}`, `$.** ? ${filt}`, vars]
  );
  const source = postingSourceOfSubject(s.code);
  return {
    journals: j.rows[0].n,
    pending: p.rows[0].n,
    used_by_posting: !!source || j.rows[0].ext > 0 || p.rows[0].n > 0,
    posting_source: source,
  };
}

async function accountUsage(bookId, a) {
  const j = await query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE j.external_source IS NOT NULL)::int AS ext
       FROM journal_logs j
      WHERE j.book_id = $1
        AND (j.transfer_out_account_id = $2 OR j.transfer_in_account_id = $2
             OR EXISTS (SELECT 1 FROM journal_legs l WHERE l.journal_log_id = j.id AND l.account_id = $2))`,
    [bookId, a.id]
  );
  const vars = JSON.stringify({ n: a.name, i: Number(a.id), s: String(a.id) });
  const filt = '(@.account_ref == $n || @.transfer_out_account_ref == $n || @.transfer_in_account_ref == $n'
    + ' || @.account_id == $i || @.account_id == $s'
    + ' || @.transfer_out_account_id == $i || @.transfer_out_account_id == $s'
    + ' || @.transfer_in_account_id == $i || @.transfer_in_account_id == $s)';
  const p = await query(
    `SELECT COUNT(*)::int AS n FROM pending_journals
      WHERE book_id = $1 AND status = 'pending'
        AND (jsonb_path_exists(proposed_journal, $2::jsonpath, $4::jsonb)
             OR jsonb_path_exists(proposed_journal, $3::jsonpath, $4::jsonb))`,
    [bookId, `$ ? ${filt}`, `$.** ? ${filt}`, vars]
  );
  const source = postingSourceOfAccount(a.name);
  return {
    journals: j.rows[0].n,
    pending: p.rows[0].n,
    used_by_posting: !!source || j.rows[0].ext > 0 || p.rows[0].n > 0,
    posting_source: source,
  };
}

const isUsed = (u) => u.journals > 0 || u.pending > 0 || u.used_by_posting;

/**
 * 守衛文案(白話)。kind = 'subject' | 'account';changes = ['code','name','deactivate'] 的子集
 */
function guardMessage(kind, usage, changes, ident) {
  const noun = kind === 'subject' ? '科目' : '帳戶';
  const parts = [];
  if (usage.journals > 0 || usage.pending > 0) {
    let s = `這個${noun}有 ${usage.journals} 筆記錄在用`;
    if (usage.pending > 0) s += `、${usage.pending} 筆待審單在等`;
    parts.push(s);
  } else {
    parts.push(`這個${noun}目前沒有記錄`);
  }
  // 推送用什麼找它:科目用代碼、帳戶用名字
  const breaks = kind === 'subject'
    ? changes.filter((c) => c === 'code' || c === 'deactivate')
    : changes.filter((c) => c === 'name' || c === 'deactivate');
  if (usage.used_by_posting && breaks.length) {
    const who = usage.posting_source || '現場系統';
    const by = kind === 'subject' ? `代碼 ${ident} ` : `名字「${ident}」`;
    const what = breaks.map((c) => ({ code: '改代碼', name: '改名', deactivate: '停用' }[c])).join('或');
    parts.push(`${who}推送時會用${by}找它;${what}後推送會失敗`);
  } else if (kind === 'subject' && changes.includes('name')) {
    parts.push('改名後歷史記錄會跟著顯示新名字');
  } else if (changes.includes('deactivate')) {
    parts.push('停用後新的記錄選不到它');
  }
  return `${parts.join(',')}。確定要改請再按一次。`;
}

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
    return res.status(404).json({ error: '找不到這本帳,或你沒有權限看' });
  }
  req.book = { id: result.rows[0].id, code: result.rows[0].code };
  req.bookMember = { role: result.rows[0].role };
  next();
}

const ROLE_ZH = { owner: '老闆', admin: '管理員', editor: '記帳員', viewer: '唯讀' };

function requireBookRole(...roles) {
  return (req, res, next) => {
    if (!req.bookMember || !roles.includes(req.bookMember.role)) {
      return res.status(403).json({ error: `你的角色不能做這個(需要${roles.map((r) => ROLE_ZH[r] || r).join(' / ')})` });
    }
    next();
  };
}

const loadBook = asyncHandler(loadBookMiddleware);

/** 撞到 017 的 UNIQUE(兩個人同時新增)→ 白話 409;其他錯照丟 */
function dupOr(e, msg) {
  if (e && e.code === '23505') { const err = new Error(msg); err.status = 409; throw err; }
  throw e;
}

async function subjectCodeTaken(bookId, code, exceptId) {
  if (!code) return false;
  const r = await query(
    'SELECT 1 FROM subjects WHERE book_id = $1 AND code = $2 AND id <> $3 LIMIT 1',
    [bookId, code, exceptId || 0]
  );
  return r.rows.length > 0;
}

async function accountNameTaken(bookId, name, exceptId) {
  const r = await query(
    'SELECT is_active FROM ag_accounts WHERE book_id = $1 AND name = $2 AND id <> $3 LIMIT 1',
    [bookId, name, exceptId || 0]
  );
  if (r.rows.length === 0) return null;
  return r.rows[0].is_active ? 'active' : 'inactive';
}
const accountDupMsg = (name, state) =>
  `已經有一個帳戶叫「${name}」了${state === 'inactive' ? '(停用中,可以到「顯示停用」把它開回來)' : ''}`;

/** 檢查科目上層:要在同一本帳、不能指自己、不能繞一圈(A 的上層是 B、B 的上層是 A) */
async function checkSubjectParent(bookId, selfId, parentId) {
  if (!parentId) return null;
  const p = await query('SELECT book_id FROM subjects WHERE id = $1', [parentId]);
  if (p.rows.length === 0 || String(p.rows[0].book_id) !== String(bookId)) return '上層科目不在這本帳裡';
  if (!selfId) return null;
  let cur = parentId;
  for (let i = 0; i < 50 && cur; i++) {
    if (Number(cur) === Number(selfId)) return '上層科目不能是自己(或自己底下的科目)';
    const r = await query('SELECT parent_id FROM subjects WHERE id = $1 AND book_id = $2', [cur, bookId]);
    cur = r.rows[0] ? r.rows[0].parent_id : null;
  }
  return null;
}

// ============================================================================
// SUBJECTS
// ============================================================================

router.get('/B/:bookCode/subjects', loadBook, asyncHandler(async (req, res) => {
  const { parent_type, include_inactive } = req.query;
  const where = ['book_id = $1'];
  const params = [req.book.id];
  if (parent_type) { where.push(`parent_type = $${params.length + 1}`); params.push(String(parent_type)); }
  if (!isTrueFlag(include_inactive)) where.push('is_active = TRUE');
  const result = await query(
    `SELECT id, code, name, parent_type, parent_id, display_order, is_active, created_at, updated_at
       FROM subjects WHERE ${where.join(' AND ')}
      ORDER BY parent_type, display_order, code, name`,
    params
  );
  res.json({ subjects: result.rows });
}));

router.post(
  '/B/:bookCode/subjects',
  loadBook,
  requireBookRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const name = vName(b.name, 50, '科目名稱');
    if (name.error) return res.status(400).json({ error: name.error });
    if (!VALID_SUBJECT_PARENT_TYPES.includes(b.parent_type)) {
      return res.status(400).json({ error: '請選科目大類(收入 / 成本 / 費用 / 轉帳 / 股東權益)' });
    }
    const code = vCode(b.code === undefined ? null : b.code);
    if (code.error) return res.status(400).json({ error: code.error });
    const parentId = vId(b.parent_id === undefined ? null : b.parent_id);
    if (parentId.error) return res.status(400).json({ error: parentId.error });
    const order = b.display_order === undefined || b.display_order === null || b.display_order === ''
      ? { value: 0 } : vInt(b.display_order, '排序', -1000000, 1000000);
    if (order.error) return res.status(400).json({ error: order.error });

    const perr = await checkSubjectParent(req.book.id, null, parentId.value);
    if (perr) return res.status(400).json({ error: perr });
    if (await subjectCodeTaken(req.book.id, code.value)) {
      return res.status(409).json({ error: `已經有一個科目用 ${code.value} 了` });
    }
    const result = await query(
      `INSERT INTO subjects (book_id, code, name, parent_type, parent_id, display_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.book.id, code.value, name.value, b.parent_type, parentId.value, order.value]
    ).catch((e) => dupOr(e, `已經有一個科目用 ${code.value} 了`));
    res.status(201).json({ subject: result.rows[0] });
  })
);

router.patch(
  '/B/:bookCode/subjects/:id',
  loadBook,
  requireBookRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: '找不到這個科目' });
    const existing = await query('SELECT * FROM subjects WHERE id = $1 AND book_id = $2', [id, req.book.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: '找不到這個科目' });
    const cur = existing.rows[0];
    const body = req.body || {};

    // 1. 驗型別,收集真的有變的欄位
    const clean = {};
    const check = {
      code: (v) => vCode(v),
      name: (v) => vName(v, 50, '科目名稱'),
      parent_type: (v) => (VALID_SUBJECT_PARENT_TYPES.includes(v) ? { value: v } : { error: '請選科目大類(收入 / 成本 / 費用 / 轉帳 / 股東權益)' }),
      parent_id: (v) => vId(v),
      display_order: (v) => vInt(v, '排序', -1000000, 1000000),
      is_active: (v) => vBool(v, '啟用'),
    };
    for (const f of Object.keys(check)) {
      if (body[f] === undefined) continue;
      const c = check[f](body[f]);
      if (c.error) return res.status(400).json({ error: c.error });
      clean[f] = c.value;
    }
    if (Object.keys(clean).length === 0) return res.status(400).json({ error: '沒有要改的欄位' });
    const changed = (f) => clean[f] !== undefined && String(clean[f] ?? '') !== String(cur[f] ?? '');

    if (changed('parent_id')) {
      const perr = await checkSubjectParent(req.book.id, id, clean.parent_id);
      if (perr) return res.status(400).json({ error: perr });
    }
    if (changed('code') && await subjectCodeTaken(req.book.id, clean.code, id)) {
      return res.status(409).json({ error: `已經有一個科目用 ${clean.code} 了` });
    }

    // 2. 改大類 / 改代碼名稱停用 → 看有沒有被用到
    const sensitive = [];
    if (changed('code')) sensitive.push('code');
    if (changed('name')) sensitive.push('name');
    if (changed('is_active') && clean.is_active === false) sensitive.push('deactivate');
    let usage = null;
    if (changed('parent_type') || sensitive.length) usage = await subjectUsage(req.book.id, cur);

    if (changed('parent_type') && usage.journals > 0) {
      return res.status(400).json({
        error: `這個科目已經有 ${usage.journals} 筆記錄,改大類(${PARENT_TYPE_ZH[cur.parent_type] || cur.parent_type} → ${PARENT_TYPE_ZH[clean.parent_type]})會讓歷史報表整批變動;請新建一個科目,舊的停用。`,
        usage,
      });
    }
    if (sensitive.length && isUsed(usage) && body.confirm !== true) {
      return res.status(409).json({
        error: guardMessage('subject', usage, sensitive, cur.code || cur.name),
        usage: { journals: usage.journals, pending: usage.pending, used_by_posting: usage.used_by_posting },
        needs_confirm: true,
      });
    }

    // 3. 寫入
    const updates = [];
    const params = [];
    for (const [f, v] of Object.entries(clean)) {
      updates.push(`${f} = $${params.length + 1}`);
      params.push(v);
    }
    updates.push('updated_at = NOW()');
    params.push(id, req.book.id);
    const result = await query(
      `UPDATE subjects SET ${updates.join(', ')} WHERE id = $${params.length - 1} AND book_id = $${params.length} RETURNING *`,
      params
    ).catch((e) => dupOr(e, `已經有一個科目用 ${clean.code} 了`));
    if (sensitive.length && isUsed(usage)) {
      console.warn(`[lookups] book ${req.book.code} 科目 #${id} 已確認改動(${sensitive.join(',')}),記錄 ${usage.journals} 筆、待審 ${usage.pending} 筆、推送用到:${usage.used_by_posting},by user ${req.user.id}`);
    }
    res.json({ subject: result.rows[0] });
  })
);

// ============================================================================
// AG_ACCOUNTS
// ============================================================================

router.get('/B/:bookCode/accounts', loadBook, asyncHandler(async (req, res) => {
  const { type, include_inactive } = req.query;
  const where = ['book_id = $1'];
  const params = [req.book.id];
  if (type) { where.push(`type = $${params.length + 1}`); params.push(String(type)); }
  if (!isTrueFlag(include_inactive)) where.push('is_active = TRUE');
  const result = await query(
    `SELECT id, name, type, linked_counterparty_id, display_order,
            initial_balance, current_balance, note, is_active, created_at, updated_at
       FROM ag_accounts WHERE ${where.join(' AND ')}
      ORDER BY display_order, name`,
    params
  );
  res.json({ accounts: result.rows });
}));

async function checkCounterpartyInBook(bookId, cpId) {
  if (!cpId) return null;
  const c = await query('SELECT book_id FROM counterparties WHERE id = $1', [cpId]);
  if (c.rows.length === 0 || String(c.rows[0].book_id) !== String(bookId)) return '綁定的對象不在這本帳裡';
  return null;
}

router.post(
  '/B/:bookCode/accounts',
  loadBook,
  requireBookRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const name = vName(b.name, 50, '帳戶名稱');
    if (name.error) return res.status(400).json({ error: name.error });
    if (!VALID_ACCOUNT_TYPES.includes(b.type)) {
      return res.status(400).json({ error: `請選帳戶類型(${Object.values(ACCOUNT_TYPE_ZH).join(' / ')})` });
    }
    const cp = vId(b.linked_counterparty_id === undefined ? null : b.linked_counterparty_id);
    if (cp.error) return res.status(400).json({ error: cp.error });
    const cperr = await checkCounterpartyInBook(req.book.id, cp.value);
    if (cperr) return res.status(400).json({ error: cperr });
    const initBal = vMoneyInt(b.initial_balance, '期初餘額');
    if (initBal.error) return res.status(400).json({ error: initBal.error });
    const order = b.display_order === undefined || b.display_order === null || b.display_order === ''
      ? { value: 0 } : vInt(b.display_order, '排序', -1000000, 1000000);
    if (order.error) return res.status(400).json({ error: order.error });
    const note = vOptStr(b.note === undefined ? null : b.note, 500, '備註');
    if (note.error) return res.status(400).json({ error: note.error });

    const taken = await accountNameTaken(req.book.id, name.value);
    if (taken) return res.status(409).json({ error: accountDupMsg(name.value, taken) });

    const result = await query(
      `INSERT INTO ag_accounts
         (book_id, name, type, linked_counterparty_id, display_order,
          initial_balance, current_balance, note)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7) RETURNING *`,
      [req.book.id, name.value, b.type, cp.value, order.value, initBal.value, note.value]
    ).catch((e) => dupOr(e, accountDupMsg(name.value, 'active')));
    res.status(201).json({ account: result.rows[0] });
  })
);

router.patch(
  '/B/:bookCode/accounts/:id',
  loadBook,
  requireBookRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: '找不到這個帳戶' });
    const existing = await query('SELECT * FROM ag_accounts WHERE id = $1 AND book_id = $2', [id, req.book.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: '找不到這個帳戶' });
    const cur = existing.rows[0];
    const body = req.body || {};

    // 注意: initial_balance / current_balance 不允許 PATCH (會破壞 journal_logs 累積的一致性)
    const clean = {};
    const check = {
      name: (v) => vName(v, 50, '帳戶名稱'),
      type: (v) => (VALID_ACCOUNT_TYPES.includes(v) ? { value: v } : { error: `請選帳戶類型(${Object.values(ACCOUNT_TYPE_ZH).join(' / ')})` }),
      linked_counterparty_id: (v) => vId(v),
      display_order: (v) => vInt(v, '排序', -1000000, 1000000),
      note: (v) => vOptStr(v, 500, '備註'),
      is_active: (v) => vBool(v, '啟用'),
    };
    for (const f of Object.keys(check)) {
      if (body[f] === undefined) continue;
      const c = check[f](body[f]);
      if (c.error) return res.status(400).json({ error: c.error });
      clean[f] = c.value;
    }
    if (Object.keys(clean).length === 0) return res.status(400).json({ error: '沒有要改的欄位' });
    const changed = (f) => clean[f] !== undefined && String(clean[f] ?? '') !== String(cur[f] ?? '');

    if (changed('linked_counterparty_id')) {
      const cperr = await checkCounterpartyInBook(req.book.id, clean.linked_counterparty_id);
      if (cperr) return res.status(400).json({ error: cperr });
    }
    if (changed('name')) {
      const taken = await accountNameTaken(req.book.id, clean.name, id);
      if (taken) return res.status(409).json({ error: accountDupMsg(clean.name, taken) });
    }

    const sensitive = [];
    if (changed('name')) sensitive.push('name');
    if (changed('is_active') && clean.is_active === false) sensitive.push('deactivate');
    let usage = null;
    if (sensitive.length) usage = await accountUsage(req.book.id, cur);
    if (sensitive.length && isUsed(usage) && body.confirm !== true) {
      return res.status(409).json({
        error: guardMessage('account', usage, sensitive, cur.name),
        usage: { journals: usage.journals, pending: usage.pending, used_by_posting: usage.used_by_posting },
        needs_confirm: true,
      });
    }

    const updates = [];
    const params = [];
    for (const [f, v] of Object.entries(clean)) {
      updates.push(`${f} = $${params.length + 1}`);
      params.push(v);
    }
    updates.push('updated_at = NOW()');
    params.push(id, req.book.id);
    const result = await query(
      `UPDATE ag_accounts SET ${updates.join(', ')} WHERE id = $${params.length - 1} AND book_id = $${params.length} RETURNING *`,
      params
    ).catch((e) => dupOr(e, accountDupMsg(clean.name, 'active')));
    if (sensitive.length && isUsed(usage)) {
      console.warn(`[lookups] book ${req.book.code} 帳戶 #${id} 已確認改動(${sensitive.join(',')}),記錄 ${usage.journals} 筆、待審 ${usage.pending} 筆、推送用到:${usage.used_by_posting},by user ${req.user.id}`);
    }
    res.json({ account: result.rows[0] });
  })
);

// ============================================================================
// COUNTERPARTIES
// ============================================================================

router.get('/B/:bookCode/counterparties', loadBook, asyncHandler(async (req, res) => {
  const { type, category, is_temporary, include_inactive } = req.query;
  const where = ['book_id = $1'];
  const params = [req.book.id];
  if (type) { where.push(`type = $${params.length + 1}`); params.push(String(type)); }
  if (category) { where.push(`category = $${params.length + 1}`); params.push(String(category)); }
  if (is_temporary !== undefined) {
    where.push(`is_temporary = $${params.length + 1}`);
    params.push(isTrueFlag(is_temporary));
  }
  if (!isTrueFlag(include_inactive)) where.push('is_active = TRUE');
  const result = await query(
    `SELECT id, name, name_normalized, type, category, tax_id, contact,
            display_order, is_active, is_temporary, promote_count,
            auto_promote_threshold, promoted_at, created_at, updated_at
       FROM counterparties WHERE ${where.join(' AND ')}
      ORDER BY display_order, name`,
    params
  );
  res.json({ counterparties: result.rows });
}));

const vTaxId = (v) => {
  if (v === null || v === '') return { value: null };
  if (typeof v !== 'string' || !/^\d{8}$/.test(v.trim())) return { error: '統一編號要是 8 位數字' };
  return { value: v.trim() };
};
const COUNTERPARTY_TYPE_MSG = '請選對象類型(收入 / 支出 / 兩者)';

router.post(
  '/B/:bookCode/counterparties',
  loadBook,
  requireBookRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const name = vName(b.name, 100, '對象名稱');
    if (name.error) return res.status(400).json({ error: name.error });
    if (!VALID_COUNTERPARTY_TYPES.includes(b.type)) {
      return res.status(400).json({ error: COUNTERPARTY_TYPE_MSG });
    }
    const fields = {
      name_normalized: vOptStr(b.name_normalized === undefined ? null : b.name_normalized, 100, '對象簡稱'),
      category: vOptStr(b.category === undefined ? null : b.category, 50, '分類'),
      tax_id: vTaxId(b.tax_id === undefined ? null : b.tax_id),
      contact: vOptStr(b.contact === undefined ? null : b.contact, 100, '聯絡方式'),
      display_order: b.display_order === undefined || b.display_order === null || b.display_order === ''
        ? { value: 0 } : vInt(b.display_order, '排序', -1000000, 1000000),
    };
    for (const c of Object.values(fields)) if (c.error) return res.status(400).json({ error: c.error });
    const result = await query(
      `INSERT INTO counterparties
         (book_id, name, name_normalized, type, category, tax_id, contact,
          display_order, is_temporary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        req.book.id, name.value, fields.name_normalized.value, b.type,
        fields.category.value, fields.tax_id.value, fields.contact.value,
        fields.display_order.value, b.is_temporary === true,
      ]
    );
    res.status(201).json({ counterparty: result.rows[0] });
  })
);

router.patch(
  '/B/:bookCode/counterparties/:id',
  loadBook,
  requireBookRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: '找不到這個對象' });
    const existing = await query('SELECT * FROM counterparties WHERE id = $1 AND book_id = $2', [id, req.book.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: '找不到這個對象' });
    const body = req.body || {};

    const check = {
      name: (v) => vName(v, 100, '對象名稱'),
      name_normalized: (v) => vOptStr(v, 100, '對象簡稱'),
      type: (v) => (VALID_COUNTERPARTY_TYPES.includes(v) ? { value: v } : { error: COUNTERPARTY_TYPE_MSG }),
      category: (v) => vOptStr(v, 50, '分類'),
      tax_id: (v) => vTaxId(v),
      contact: (v) => vOptStr(v, 100, '聯絡方式'),
      display_order: (v) => vInt(v, '排序', -1000000, 1000000),
      is_active: (v) => vBool(v, '啟用'),
      is_temporary: (v) => vBool(v, '臨時對象'),
      auto_promote_threshold: (v) => vInt(v, '自動升級門檻', 1, 1000),
    };
    const updates = [];
    const params = [];
    for (const f of Object.keys(check)) {
      if (body[f] === undefined) continue;
      const c = check[f](body[f]);
      if (c.error) return res.status(400).json({ error: c.error });
      // 升級 (is_temporary: true -> false) 時自動填 promoted_at
      if (f === 'is_temporary' && existing.rows[0].is_temporary && c.value === false) {
        updates.push('promoted_at = NOW()');
      }
      updates.push(`${f} = $${params.length + 1}`);
      params.push(c.value);
    }
    if (params.length === 0) return res.status(400).json({ error: '沒有要改的欄位' });
    updates.push('updated_at = NOW()');
    params.push(id, req.book.id);
    const result = await query(
      `UPDATE counterparties SET ${updates.join(', ')} WHERE id = $${params.length - 1} AND book_id = $${params.length} RETURNING *`,
      params
    );
    res.json({ counterparty: result.rows[0] });
  })
);

module.exports = router;
module.exports._internals = {
  guardMessage, postingSourceOfAccount, postingSourceOfSubject, vCode, vName, vInt, vBool, vId, vMoneyInt, isTrueFlag,
  POSTING_ACCOUNTS, POSTING_SUBJECTS,
};
