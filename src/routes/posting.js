// src/routes/posting.js
// M3 webhook + M5 composite journal + per-source posting_mode + triggered_by + invoices.
//
// Endpoints:
//   POST /B/:bookCode/internal/posting      Webhook entry (HMAC OR X-Posting-Token)
//   POST /B/:bookCode/internal/supersede    來源單據修改 / 作廢跟進
//   GET  /B/:bookCode/pending-journals      List pending review (JWT;?offset=&limit=)
//   GET  /B/:bookCode/pending-journals/:id  Detail (JWT)
//   POST /B/:bookCode/pending-journals/approve-batch  批次核准(JWT;owner / admin / editor)
//   POST /B/:bookCode/pending-journals/:id/approve    核准:owner / admin / editor(LEO 2026-10-10 拍板)
//   POST /B/:bookCode/pending-journals/:id/reject     退回:owner / admin / editor
//
// 金額規則:journal 一律「元、整數」,禁浮點。
// composite 守恆(雲 3,2026-10-10):gap = Σ帳戶腳 − Σ(t1/t5 科目腳) + Σ(t2/t3 科目腳) 必須 = 0,
//   收入類(POS 收班、訂金)、支出類(薪資)、訂金退款都適用;≠ 0 直接 422 拒收。

'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth } = require('../auth');
const bookCode = require('../utils/bookCode');
const asyncHandler = require('../utils/asyncHandler');
const hmac = require('../utils/hmac');

const router = express.Router();

const SHARED_POSTING_TOKEN = process.env.SHARED_POSTING_TOKEN || null;
const SYSTEM_BOT_USER_ID = 0;  // D21 / migration 010
const SUMMARY_MAX = 200;       // journal_logs.summary VARCHAR(200)
const MAX_LEGS = 50;
const BATCH_MAX = 100;

// ── helpers ─────────────────────────────────────────────────────────
function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status }, extra || {});
}

function fmtMoney(n) {
  const v = Math.abs(Number(n) || 0);
  return '$' + v.toLocaleString('en-US');
}

// 真日期檢查(2026-02-30 會被擋)
function isRealDate(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(d + 'T00:00:00Z');
  if (isNaN(t.getTime())) return false;
  return t.toISOString().slice(0, 10) === d;
}

// 台北日期(沖銷單日期用;不吃容器時區)
function taipeiToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// DATE 欄位 → 'YYYY-MM-DD'。pg 預設把 DATE 解析成「容器本地時間午夜」的 Date,
// 所以用本地的年月日取回(不能用 toISOString,台北時區會倒退一天)。字串就取前 10 碼。
function toYmd(d) {
  if (d === null || d === undefined || d === '') return null;
  if (d instanceof Date) {
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const s = String(d).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// 來源代號 → 白話(稽核原因用;跟 public/common.js SOURCE_NAME 同一張)
const SOURCE_NAME = {
  leo_pos: '點餐結帳', leo_expense: '支出單', leo_inventory: '進貨', leo_inline: '訂金 / 刷卡撥款', leo_hr: '薪資',
};
function sourceLabel(src) {
  return SOURCE_NAME[src] || '現場系統';
}

// ── 關帳(第二輪 §4.8 / Y26)──────────────────────────────────────────
// books.closed_through(migration 018):這天(含)以前的帳不能再動。NULL = 沒關帳。
// 每個擋點都呼叫同一份 assertNotClosed:
//   mode 'ui'   → 409(畫面操作:手動記帳 / 改 / 沖銷指定日期 / 核准待審)
//   mode 'push' → 422(現場系統推送 posting / supersede;來源端會停止重試並告警,老闆解鎖後到對帳頁補推)
// db 可以是 transaction 的 client(會 FOR SHARE 鎖住帳本那列,關帳設定改到一半不會有人插隊入帳)或 { query }。
async function loadClosedThrough(db, bookId) {
  const r = await db.query(`SELECT closed_through FROM books WHERE id = $1 FOR SHARE`, [bookId]);
  return r.rows.length ? toYmd(r.rows[0].closed_through) : null;
}

function closedMessage(closedThrough, mode) {
  const base = `${closedThrough} 以前已經關帳,不能再動;要改請老闆先到設定頁解鎖`;
  return mode === 'push' ? `${base},解鎖後到對帳頁補推` : base;
}

function isDateClosed(dateYmd, closedThrough) {
  return !!(dateYmd && closedThrough && dateYmd <= closedThrough);
}

/**
 * 有效日期落在關帳期間 → 丟錯(409 / 422)。日期格式不對就不在這裡擋(交給原本的驗證)。
 * 傳了 opts.closedThrough 就不再查一次資料庫。回傳 closedThrough 讓呼叫端重用。
 */
async function assertNotClosed(db, bookId, date, opts) {
  const o = opts || {};
  const ct = o.closedThrough !== undefined ? o.closedThrough : await loadClosedThrough(db, bookId);
  const ymd = toYmd(date);
  if (isDateClosed(ymd, ct)) {
    throw httpError(o.mode === 'push' ? 422 : 409, closedMessage(ct, o.mode), { errCode: 'book_closed' });
  }
  return ct;
}

async function loadBookOpen(req, res, next) {
  const code = (req.params.bookCode || '').toUpperCase();
  if (!bookCode.isValidFormat(code)) return res.status(400).json({ error: '帳本代碼格式不對' });
  const result = await query(
    `SELECT id, code, posting_mode, posting_mode_per_source FROM books WHERE code = $1 AND is_active = TRUE`,
    [code]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: '找不到這個帳本' });
  req.book = result.rows[0];
  next();
}

async function loadBookAuth(req, res, next) {
  const code = (req.params.bookCode || '').toUpperCase();
  if (!bookCode.isValidFormat(code)) return res.status(400).json({ error: '帳本代碼格式不對' });
  const result = await query(
    `SELECT b.id, b.code, b.posting_mode, b.posting_mode_per_source, bm.role
       FROM books b JOIN book_members bm ON bm.book_id = b.id
      WHERE b.code = $1 AND bm.user_id = $2 AND b.is_active = TRUE`,
    [code, req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: '找不到這個帳本,或你沒有這個帳本的權限' });
  req.book = {
    id: result.rows[0].id,
    code: result.rows[0].code,
    posting_mode: result.rows[0].posting_mode,
    posting_mode_per_source: result.rows[0].posting_mode_per_source,
  };
  req.bookMember = { role: result.rows[0].role };
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.bookMember || !roles.includes(req.bookMember.role)) {
      return res.status(403).json({ error: '你的角色不能做這個(核准 / 退回要老闆、管理員或記帳員)' });
    }
    next();
  };
}

const loadOpen = asyncHandler(loadBookOpen);
const loadAuth = asyncHandler(loadBookAuth);

// ── N7：per-source per-event_type posting mode resolver ─────────────
function resolvePostingMode(book, source, eventType) {
  const cfg = book.posting_mode_per_source || {};
  const sourceVal = cfg[source];
  if (typeof sourceVal === 'string') return sourceVal;
  if (sourceVal && typeof sourceVal === 'object') {
    return sourceVal[eventType] || sourceVal._default || book.posting_mode;
  }
  return book.posting_mode || 'review';
}

// ── Q14：subject_code/account_ref resolvers ──────────────────────────
// 找不到 / 已停用 / 不是這本帳的 → 422 白話(以前是無 status 的 Error → 500)。
// 數字 id 也要驗「是這本帳、還在用」(Y5)。
async function resolveSubject(client, bookId, leg) {
  if (leg.subject_code !== undefined && leg.subject_code !== null && leg.subject_code !== '') {
    const code = String(leg.subject_code).trim();
    const r = await client.query(
      `SELECT id, parent_type FROM subjects WHERE book_id = $1 AND code = $2 AND is_active = TRUE`,
      [bookId, code]
    );
    if (r.rows.length === 0) throw httpError(422, `找不到科目代碼 ${code}(可能打錯或已停用)`);
    return { id: r.rows[0].id, parent_type: r.rows[0].parent_type };
  }
  if (leg.subject_id) {
    const sid = Number(leg.subject_id);
    if (!Number.isInteger(sid) || sid < 1) throw httpError(422, '科目編號不正確');
    const r = await client.query(
      `SELECT id, parent_type FROM subjects WHERE id = $1 AND book_id = $2 AND is_active = TRUE`,
      [sid, bookId]
    );
    if (r.rows.length === 0) throw httpError(422, '這本帳找不到這個科目(可能已停用)');
    return { id: r.rows[0].id, parent_type: r.rows[0].parent_type };
  }
  throw httpError(422, '缺少科目');
}

async function resolveSubjectId(client, bookId, leg) {
  return (await resolveSubject(client, bookId, leg)).id;
}

// Y4 後半(第二輪 §4.4):同名帳戶被老闆「停用」→ 422 白話講清楚(不自動啟用,停用是有意的)。
// 以前只說「找不到」,來源端看不出是停用;更早是 500 → 推送整條 dead。
function inactiveAccountError(name) {
  return httpError(422, `帳戶「${name}」已停用,這筆沒辦法入帳;要繼續用請到主檔設定把它啟用,或請技術改推送`,
    { errCode: 'account_inactive' });
}

async function resolveAccountId(client, bookId, leg) {
  if (leg.account_ref !== undefined && leg.account_ref !== null && leg.account_ref !== '') {
    // ensure_accounts 建帳戶時有 trim,找的時候也 trim(Y4)
    const name = String(leg.account_ref).trim();
    const r = await client.query(
      `SELECT id FROM ag_accounts WHERE book_id = $1 AND name = $2 AND is_active = TRUE ORDER BY id LIMIT 1`,
      [bookId, name]
    );
    if (r.rows.length === 0) {
      const off = await client.query(
        `SELECT id FROM ag_accounts WHERE book_id = $1 AND name = $2 AND is_active = FALSE LIMIT 1`,
        [bookId, name]
      );
      if (off.rows.length > 0) throw inactiveAccountError(name);
      throw httpError(422, `找不到帳戶「${name}」(可能改名或已停用)`);
    }
    return r.rows[0].id;
  }
  if (leg.account_id) {
    const aid = Number(leg.account_id);
    if (!Number.isInteger(aid) || aid < 1) throw httpError(422, '帳戶編號不正確');
    const r = await client.query(
      `SELECT id, name, is_active FROM ag_accounts WHERE id = $1 AND book_id = $2`,
      [aid, bookId]
    );
    if (r.rows.length === 0) throw httpError(422, '這本帳找不到這個帳戶(可能已停用)');
    if (!r.rows[0].is_active) throw inactiveAccountError(r.rows[0].name);
    return r.rows[0].id;
  }
  throw httpError(422, '缺少帳戶');
}

async function resolveCounterpartyId(client, bookId, cpId) {
  if (cpId === undefined || cpId === null || cpId === '') return null;
  const n = Number(cpId);
  if (!Number.isInteger(n) || n < 1) throw httpError(422, '往來對象編號不正確');
  const r = await client.query(`SELECT id FROM counterparties WHERE id = $1 AND book_id = $2`, [n, bookId]);
  if (r.rows.length === 0) throw httpError(422, '這本帳找不到這個往來對象');
  return r.rows[0].id;
}

// ── 純函式:composite 守恆與單頭金額(有小測試) ─────────────────────
// legs: [{ kind: 'subject'|'account', amount: int, parent_type: 't1'..'t5'|null }]
function compositeGap(legs) {
  let gap = 0;
  for (const l of legs) {
    const a = Number(l.amount);
    if (l.kind === 'account') gap += a;
    else if (l.parent_type === 't1' || l.parent_type === 't5') gap -= a;
    else if (l.parent_type === 't2' || l.parent_type === 't3') gap += a;
  }
  return gap;
}

// §3.3 單頭金額 = |Σ科目腳|(薪資 = 應發 + 雇主負擔;POS 收班 = 淨收入;訂金退款 = 退款額)
function compositeHeaderAmount(legs) {
  const s = legs.filter(l => l.kind === 'subject').reduce((acc, l) => acc + Number(l.amount), 0);
  return Math.abs(s);
}

// 有 t4(轉帳)科目腳 → 422;gap ≠ 0 → 422
function assertCompositeBalanced(legs) {
  if (legs.some(l => l.kind === 'subject' && l.parent_type === 't4')) {
    throw httpError(422, '轉帳科目不能放在複式單裡');
  }
  const gap = compositeGap(legs);
  if (gap !== 0) {
    throw httpError(422, `這張單借貸不平衡,差 ${fmtMoney(gap)}`);
  }
}

// ── validators(結構 + 金額;回 null 或 { status, error }) ───────────
function isValidAmountInt(v, allowNegative) {
  if (!Number.isInteger(v)) return false;
  return allowNegative ? v !== 0 : v > 0;
}

function validateProposedJournal(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { status: 400, error: '缺少記帳內容' };
  if (!isRealDate(p.date)) return { status: 422, error: `日期不正確${p.date ? ':' + String(p.date).slice(0, 20) : ''}` };
  if (!['expense', 'income', 'transfer', 'reclassify', 'composite'].includes(p.type)) {
    return { status: 400, error: '單據類型不正確' };
  }
  if (p.summary !== undefined && p.summary !== null) {
    if (typeof p.summary !== 'string') return { status: 422, error: '摘要格式不正確' };
    if (p.summary.length > SUMMARY_MAX) return { status: 422, error: `摘要太長(最多 ${SUMMARY_MAX} 字)` };
  }
  if (p.type === 'composite') return validateCompositePayload(p);
  // 單式單維持舊規則(大於 0 的數字):舊系統進貨單有小數金額(線上 59 張,例 11471.25)且一直在推,
  // 改成只收整數會讓它們整批被拒。複式單才強制整數(validateCompositePayload)。2026-10-10 收尾判斷
  const amt = typeof p.amount === 'string' && p.amount.trim() !== '' ? Number(p.amount) : p.amount;
  if (typeof amt !== 'number' || !Number.isFinite(amt) || !(amt > 0)) return { status: 422, error: '金額必須大於 0' };
  if (!p.subject_id && !p.subject_code) return { status: 400, error: '缺少科目' };
  if (p.type === 'expense' && !p.transfer_out_account_id && !p.transfer_out_account_ref) return { status: 400, error: '支出要指定付款帳戶' };
  if (p.type === 'income' && !p.transfer_in_account_id && !p.transfer_in_account_ref) return { status: 400, error: '收入要指定收款帳戶' };
  if (p.type === 'transfer' && ((!p.transfer_out_account_id && !p.transfer_out_account_ref) || (!p.transfer_in_account_id && !p.transfer_in_account_ref))) {
    return { status: 400, error: '轉帳要指定轉出與轉入帳戶' };
  }
  if (p.type === 'reclassify' && !p.reclassify_from_subject_id && !p.reclassify_from_subject_code) {
    return { status: 400, error: '分類轉移要指定原科目' };
  }
  return null;
}

function validateCompositePayload(p) {
  if (!Array.isArray(p.legs) || p.legs.length === 0) return { status: 400, error: '這張單沒有任何明細' };
  if (p.legs.length > MAX_LEGS) return { status: 400, error: `明細太多(最多 ${MAX_LEGS} 行)` };
  let subjectLegs = 0;
  for (let i = 0; i < p.legs.length; i++) {
    const leg = p.legs[i];
    const no = i + 1;
    if (!leg || typeof leg !== 'object') return { status: 400, error: `第 ${no} 行明細格式不正確` };
    if (!['subject', 'account'].includes(leg.kind)) return { status: 400, error: `第 ${no} 行要標明是科目還是帳戶` };
    if (leg.kind === 'subject' && !leg.subject_code && !leg.subject_id) {
      return { status: 400, error: `第 ${no} 行缺少科目` };
    }
    if (leg.kind === 'account' && !leg.account_ref && !leg.account_id) {
      return { status: 400, error: `第 ${no} 行缺少帳戶` };
    }
    if (!isValidAmountInt(leg.amount, true)) {
      return { status: 422, error: `第 ${no} 行金額必須是不為 0 的整數(元)` };
    }
    if (leg.kind === 'subject') subjectLegs++;
  }
  if (subjectLegs === 0) return { status: 422, error: '這張單沒有任何科目,無法入帳' };
  return null;
}

function assertValidProposed(p) {
  const v = validateProposedJournal(p);
  if (v) throw httpError(v.status, v.error);
}

// ── composite 腳解析(帶科目大類);leg_no 由雲端自己編(不用 client 的) ──
async function resolveCompositeLegs(client, bookId, p) {
  const resolvedLegs = [];
  for (let i = 0; i < p.legs.length; i++) {
    const leg = p.legs[i];
    const resolved = {
      leg_no: i + 1,
      kind: leg.kind,
      subject_id: null,
      parent_type: null,
      account_id: null,
      amount: Number(leg.amount),
      note: leg.note ? String(leg.note) : null,
    };
    if (leg.kind === 'subject') {
      const s = await resolveSubject(client, bookId, leg);
      resolved.subject_id = s.id;
      resolved.parent_type = s.parent_type;
    } else {
      resolved.account_id = await resolveAccountId(client, bookId, leg);
    }
    resolvedLegs.push(resolved);
  }
  return resolvedLegs;
}

// ── 收件時就驗(Y3):科目 / 帳戶 / 對象都找得到、composite 守恆 ───────
async function precheckProposed(client, bookId, p) {
  assertValidProposed(p);
  if (p.type === 'composite') {
    const legs = await resolveCompositeLegs(client, bookId, p);
    assertCompositeBalanced(legs);
    return;
  }
  await resolveSubjectId(client, bookId, { subject_code: p.subject_code, subject_id: p.subject_id });
  if (p.type === 'expense' || p.type === 'transfer') {
    await resolveAccountId(client, bookId, { account_ref: p.transfer_out_account_ref, account_id: p.transfer_out_account_id });
  }
  if (p.type === 'income' || p.type === 'transfer') {
    await resolveAccountId(client, bookId, { account_ref: p.transfer_in_account_ref, account_id: p.transfer_in_account_id });
  }
  if (p.type === 'reclassify') {
    await resolveSubjectId(client, bookId, { subject_code: p.reclassify_from_subject_code, subject_id: p.reclassify_from_subject_id });
  }
  await resolveCounterpartyId(client, bookId, p.counterparty_id);
}

// ── Insert: legacy single-subject journal (expense/income/transfer/reclassify) ──
async function insertLegacyJournal(client, bookId, p, externalSource, externalId, createdByUserId, isAuto, triggeredByEmpId, webhookLogId) {
  const subjectId = await resolveSubjectId(client, bookId, { subject_code: p.subject_code, subject_id: p.subject_id });
  let outAccountId = null;
  if (p.type === 'expense' || p.type === 'transfer') {
    outAccountId = await resolveAccountId(client, bookId, { account_ref: p.transfer_out_account_ref, account_id: p.transfer_out_account_id });
  }
  let inAccountId = null;
  if (p.type === 'income' || p.type === 'transfer') {
    inAccountId = await resolveAccountId(client, bookId, { account_ref: p.transfer_in_account_ref, account_id: p.transfer_in_account_id });
  }
  let reclassifyFrom = null;
  if (p.type === 'reclassify') {
    reclassifyFrom = await resolveSubjectId(client, bookId, { subject_code: p.reclassify_from_subject_code, subject_id: p.reclassify_from_subject_id });
  }
  const counterpartyId = await resolveCounterpartyId(client, bookId, p.counterparty_id);

  const insertRes = await client.query(
    `INSERT INTO journal_logs (
       book_id, date, type, amount,
       subject_id, reclassify_from_subject_id,
       transfer_out_account_id, transfer_in_account_id,
       counterparty_id, summary, note,
       external_source, external_id, is_auto_posted,
       triggered_by_external_emp_id, webhook_log_id,
       is_composite,
       created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, FALSE, $17, $17)
     RETURNING *`,
    [
      bookId, p.date, p.type, Number(p.amount),
      subjectId, reclassifyFrom,
      outAccountId, inAccountId,
      counterpartyId, p.summary || null, p.note || null,
      externalSource, externalId, isAuto,
      triggeredByEmpId || null, webhookLogId || null,
      createdByUserId,
    ]
  );
  const journal = insertRes.rows[0];
  const amt = Number(p.amount);
  if (p.type === 'expense' || p.type === 'transfer') {
    await client.query(
      `UPDATE ag_accounts SET current_balance = current_balance - $1, updated_at = NOW()
        WHERE id = $2 AND book_id = $3`,
      [amt, outAccountId, bookId]
    );
  }
  if (p.type === 'income' || p.type === 'transfer') {
    await client.query(
      `UPDATE ag_accounts SET current_balance = current_balance + $1, updated_at = NOW()
        WHERE id = $2 AND book_id = $3`,
      [amt, inAccountId, bookId]
    );
  }
  if (counterpartyId) {
    await client.query(
      `UPDATE counterparties SET promote_count = promote_count + 1, updated_at = NOW()
        WHERE id = $1 AND book_id = $2`,
      [counterpartyId, bookId]
    );
  }
  return journal;
}

// ── Insert: composite journal (N legs) ──────────────────────────────
async function insertCompositeJournal(client, bookId, p, externalSource, externalId, createdByUserId, isAuto, triggeredByEmpId, webhookLogId) {
  const resolvedLegs = await resolveCompositeLegs(client, bookId, p);
  // 雲 3:守恆不平直接擋(不再只警告)
  assertCompositeBalanced(resolvedLegs);

  // primary subject_id for header (first subject leg)
  const primarySubject = resolvedLegs.find(l => l.kind === 'subject');
  const primarySubjectId = primarySubject ? primarySubject.subject_id : null;

  // §3.3 單頭金額 = |Σ科目腳|
  const headerAmount = compositeHeaderAmount(resolvedLegs);

  const journalRes = await client.query(
    `INSERT INTO journal_logs (
       book_id, date, type, amount,
       subject_id,
       summary, note,
       external_source, external_id, is_auto_posted,
       triggered_by_external_emp_id, webhook_log_id,
       is_composite,
       created_by, updated_by
     ) VALUES ($1, $2, 'composite', $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, $12, $12)
     RETURNING *`,
    [
      bookId, p.date, headerAmount,
      primarySubjectId,
      p.summary || null, p.note || null,
      externalSource, externalId, isAuto,
      triggeredByEmpId || null, webhookLogId || null,
      createdByUserId,
    ]
  );
  const journal = journalRes.rows[0];

  // insert legs + apply balance updates
  for (const leg of resolvedLegs) {
    await client.query(
      `INSERT INTO journal_legs (journal_log_id, leg_no, kind, subject_id, account_id, amount, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [journal.id, leg.leg_no, leg.kind, leg.subject_id, leg.account_id, leg.amount, leg.note]
    );
    if (leg.kind === 'account') {
      await client.query(
        `UPDATE ag_accounts SET current_balance = current_balance + $1, updated_at = NOW()
          WHERE id = $2 AND book_id = $3`,
        [leg.amount, leg.account_id, bookId]
      );
    }
    // subject legs: SQL no balance update (reports compute via journal_legs GROUP BY)
  }

  return { journal, balance_gap: 0 };
}

// ── Insert dispatcher ───────────────────────────────────────────────
async function insertJournalFromProposed(client, bookId, p, externalSource, externalId, createdByUserId, isAuto, triggeredByEmpId, webhookLogId) {
  assertValidProposed(p);
  if (p.type === 'composite') {
    return insertCompositeJournal(client, bookId, p, externalSource, externalId, createdByUserId, isAuto, triggeredByEmpId, webhookLogId);
  }
  const journal = await insertLegacyJournal(client, bookId, p, externalSource, externalId, createdByUserId, isAuto, triggeredByEmpId, webhookLogId);
  return { journal, balance_gap: null };
}

// ============================================================================
// 共用沖銷(journals.js 的 /reverse、DELETE 與本檔 supersede 都走這支)
//   - composite:複製 legs 取負、逐帳戶回滾
//   - reclassify 1:N(有 child targets):建成 composite 反向 —— 原科目 +總額、各 target −各自金額
//     (R10:以前做成 1:1「主 target 扣總額」,其他 target 沒沖,科目明細全錯)
//   - 其他單式:type 對調、科目不變(報表依「類型 × 科目大類」正負號自然歸零)
//   沖銷單一律寫 original_date = 原單日期(報表歸回原單月份)
//   例外(第二輪 §4.8 關帳):原單在關帳期間 → 呼叫端傳 opts.originalDate = 沖銷當天,
//     沖銷單不回溯進關帳月(交出去的月報不變、本月多一筆反向)。用 reverseDatesFor() 算。
//   呼叫端負責:鎖原單、檢查狀態、寫 reverse_audit_log。
// opts: { date, summary, note, userId, isAuto, originalDate? }
// 回傳沖銷單整列
// ============================================================================
async function insertCompositeReverseHeader(client, bookId, o, subjectId, opts) {
  const ins = await client.query(
    `INSERT INTO journal_logs (
       book_id, date, type, amount,
       subject_id, counterparty_id,
       summary, note,
       reverses_id, original_date, is_auto_posted,
       is_composite,
       created_by, updated_by
     ) VALUES ($1, $2, 'composite', $3, $4, $5, $6, $7, $8, $9, $10, TRUE, $11, $11)
     RETURNING *`,
    [
      bookId, opts.date, Number(o.amount),
      subjectId, o.counterparty_id || null,
      opts.summary, opts.note,
      o.id, opts.originalDate || o.date, !!opts.isAuto,
      opts.userId,
    ]
  );
  return ins.rows[0];
}

/**
 * 沖銷單的日期怎麼寫(手動沖銷、supersede 自動沖銷共用;第二輪 §4.8)。
 *   原單有效日期沒關帳 → { date: 指定日期 || 今天, originalDate: null(= 原單日期), closedOriginal: false }
 *   原單有效日期已關帳 → { date: 指定日期 || 今天, originalDate: 同 date, closedOriginal: true,
 *                         summaryPrefix: '[沖銷 YYYY-MM-DD 的單]' }
 *   沖銷單自己的日期(預設或指定)落進關帳期間 → 一律丟錯(畫面 409 / 推送 422),不管原單有沒有關帳。
 * keepOriginalDay:supersede 以前把沖銷單 date 寫成原單日期(沒關帳時照舊)。
 */
function reverseDatesFor(o, closedThrough, opts) {
  const x = opts || {};
  const origEff = toYmd(o.original_date) || toYmd(o.date);
  const closedOriginal = isDateClosed(origEff, closedThrough);
  if (!closedOriginal) {
    const date = x.dateOverride || (x.keepOriginalDay ? o.date : taipeiToday());
    // 沖銷單自己的日期一律檢查(不論預設今天還是自選):例 關帳日 = 今天、原單在未來 → 預設今天也會落進關帳期
    if (isDateClosed(toYmd(date), closedThrough)) {
      throw httpError(x.mode === 'push' ? 422 : 409, closedMessage(closedThrough, x.mode), { errCode: 'book_closed' });
    }
    return { date, originalDate: null, closedOriginal: false, summaryPrefix: '' };
  }
  const date = x.dateOverride || taipeiToday();
  if (isDateClosed(toYmd(date), closedThrough)) {
    throw httpError(x.mode === 'push' ? 422 : 409, closedMessage(closedThrough, x.mode), { errCode: 'book_closed' });
  }
  return { date, originalDate: date, closedOriginal: true, summaryPrefix: `[沖銷 ${origEff} 的單]` };
}

async function reverseJournalRow(client, bookId, o, opts) {
  let reverse;
  if (o.is_composite) {
    const legsRes = await client.query(
      `SELECT * FROM journal_legs WHERE journal_log_id = $1 ORDER BY leg_no`, [o.id]);
    reverse = await insertCompositeReverseHeader(client, bookId, o, o.subject_id, opts);
    for (const leg of legsRes.rows) {
      const negAmt = -Number(leg.amount);
      await client.query(
        `INSERT INTO journal_legs (journal_log_id, leg_no, kind, subject_id, account_id, amount, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [reverse.id, leg.leg_no, leg.kind, leg.subject_id, leg.account_id, negAmt, leg.note]);
      if (leg.kind === 'account') {
        await client.query(
          `UPDATE ag_accounts SET current_balance = current_balance + $1, updated_at = NOW()
            WHERE id = $2 AND book_id = $3`, [negAmt, leg.account_id, bookId]);
      }
    }
  } else {
    let targets = [];
    if (o.type === 'reclassify') {
      const tr = await client.query(
        `SELECT target_subject_id, amount FROM journal_reclassify_targets
          WHERE journal_id = $1 ORDER BY display_order, id`, [o.id]);
      targets = tr.rows;
    }
    if (o.type === 'reclassify' && targets.length > 0) {
      // 1:N → composite 反向(只有科目腳,不動帳戶餘額)
      // 不抄往來對象:原重分類單不進對象報表,沖銷單若帶對象會被複式那段算進去 → 對象報表不歸零(驗收 B 抓到)
      reverse = await insertCompositeReverseHeader(client, bookId, { ...o, counterparty_id: null }, o.reclassify_from_subject_id, opts);
      let legNo = 0;
      await client.query(
        `INSERT INTO journal_legs (journal_log_id, leg_no, kind, subject_id, account_id, amount, note)
         VALUES ($1, $2, 'subject', $3, NULL, $4, $5)`,
        [reverse.id, ++legNo, o.reclassify_from_subject_id, Number(o.amount), '沖回原科目']);
      for (const t of targets) {
        await client.query(
          `INSERT INTO journal_legs (journal_log_id, leg_no, kind, subject_id, account_id, amount, note)
           VALUES ($1, $2, 'subject', $3, NULL, $4, $5)`,
          [reverse.id, ++legNo, t.target_subject_id, -Number(t.amount), '沖銷分類轉移']);
      }
    } else {
      let reverseType, outAcc, inAcc, fromSubject, newSubjectId;
      if (o.type === 'expense') {
        reverseType = 'income'; outAcc = null; inAcc = o.transfer_out_account_id;
        fromSubject = null; newSubjectId = o.subject_id;
      } else if (o.type === 'income') {
        reverseType = 'expense'; outAcc = o.transfer_in_account_id; inAcc = null;
        fromSubject = null; newSubjectId = o.subject_id;
      } else if (o.type === 'transfer') {
        reverseType = 'transfer'; outAcc = o.transfer_in_account_id; inAcc = o.transfer_out_account_id;
        fromSubject = null; newSubjectId = o.subject_id;
      } else if (o.type === 'reclassify') {
        // 1:1:原 target ↔ 原 from 對調
        reverseType = 'reclassify'; outAcc = null; inAcc = null;
        fromSubject = o.subject_id; newSubjectId = o.reclassify_from_subject_id;
      } else {
        throw httpError(400, '這種單據不能沖銷');
      }

      const ins = await client.query(
        `INSERT INTO journal_logs (
           book_id, date, type, amount,
           subject_id, reclassify_from_subject_id,
           transfer_out_account_id, transfer_in_account_id,
           counterparty_id, summary, note,
           reverses_id, original_date, is_auto_posted,
           created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)
         RETURNING *`,
        [
          bookId, opts.date, reverseType, Number(o.amount),
          newSubjectId, fromSubject,
          outAcc, inAcc,
          o.counterparty_id || null, opts.summary, opts.note,
          o.id, opts.originalDate || o.date, !!opts.isAuto,
          opts.userId,
        ]
      );
      reverse = ins.rows[0];

      // 帳戶餘額回滾(語意同 insertLegacyJournal 的正向邏輯)
      const amt = Number(o.amount);
      if (reverseType === 'expense' || reverseType === 'transfer') {
        await client.query(
          `UPDATE ag_accounts SET current_balance = current_balance - $1, updated_at = NOW()
            WHERE id = $2 AND book_id = $3`, [amt, outAcc, bookId]);
      }
      if (reverseType === 'income' || reverseType === 'transfer') {
        await client.query(
          `UPDATE ag_accounts SET current_balance = current_balance + $1, updated_at = NOW()
            WHERE id = $2 AND book_id = $3`, [amt, inAcc, bookId]);
      }
    }
  }

  // 雙向標記
  await client.query(
    `UPDATE journal_logs SET reversed_by_id = $1, updated_at = NOW() WHERE id = $2 AND book_id = $3`,
    [reverse.id, o.id, bookId]
  );
  return reverse;
}

// ── D25: invoices writer ────────────────────────────────────────────
// 第二輪 verifier 補洞:發票欄位超長(invoice_period CHAR(6)、customer_tax_id VARCHAR(10))以前會讓
// 核准 / auto 入帳整筆 500 卡死。現在防禦式寫:字串欄位 trim + 依欄寬截斷(期別不是 6 位數字就留空),
// 單一張寫入失敗只 console.warn 跳過那張(用 SAVEPOINT,不弄壞呼叫端的 transaction),分錄照樣入帳。
// 欄寬照 migrations/012_invoices.sql;TEXT 欄位沒有上限,這裡只防垃圾值截到 200 字。
const INVOICE_TEXT_MAX = 200;
function invStr(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

async function writeInvoices(client, bookId, journalLogId, invoices) {
  if (!Array.isArray(invoices) || invoices.length === 0) return;
  for (let i = 0; i < invoices.length; i++) {
    const inv = invoices[i] && typeof invoices[i] === 'object' ? invoices[i] : {};
    const period = invStr(inv.invoice_period, 6);
    const amt = Number(inv.amount);
    const row = [
      bookId, journalLogId,
      invStr(inv.external_order_id, INVOICE_TEXT_MAX),
      invStr(inv.external_source, INVOICE_TEXT_MAX) || 'leo_pos',
      invStr(inv.invoice_number, INVOICE_TEXT_MAX),
      period && /^\d{6}$/.test(period) ? period : null,
      Number.isFinite(amt) ? amt : 0,
      invStr(inv.customer_tax_id, 10),
      !!inv.is_void,
    ];
    await client.query('SAVEPOINT write_invoice');
    try {
      await client.query(
        `INSERT INTO invoices (book_id, journal_log_id, external_order_id, external_source,
                                invoice_number, invoice_period, amount, customer_tax_id, is_void)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        row
      );
      await client.query('RELEASE SAVEPOINT write_invoice');
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT write_invoice');
      await client.query('RELEASE SAVEPOINT write_invoice');
      console.warn(`[posting] 分錄 ${journalLogId} 第 ${i + 1} 張發票寫不進去,跳過:${e.message}`);
    }
  }
}

// Y7(第二輪 §4.2):supersede 沖掉 base 時,掛在 base 上的發票一起標作廢(沒作廢的才標)
async function voidInvoicesOfJournal(client, bookId, journalLogId, reason) {
  const r = await client.query(
    `UPDATE invoices SET is_void = TRUE, void_at = NOW(), void_reason = $1, updated_at = NOW()
      WHERE book_id = $2 AND journal_log_id = $3 AND is_void = FALSE`,
    [String(reason || '').slice(0, 500) || null, bookId, journalLogId]
  );
  return r.rowCount || 0;
}

// Y7:存進待審的 payload 要帶發票(頂層 invoices 優先、沒有才留 payload 原本的),核准時才拿得到
function payloadForStore(payload, empId, invoices) {
  const p = payloadWithTrigger(payload, empId);
  if (Array.isArray(invoices) && invoices.length > 0) p.invoices = invoices;
  return p;
}

// ── ensure_accounts(B5,第二輪 §4.3:posting 與 supersede replace 共用)──
// 來源系統聲明本事件需要的帳戶,缺的自動補建(規格 §5.2.5.3.1「應付帳款-{廠商}」由雲端負責建立的 v1 落地)。
// 白名單 type、name 長度限制;已存在(含停用)一律不動 —— 停用的會在 resolveAccountId 講清楚(§4.4),不自動啟用。
// 用 pool 的 query(不在呼叫端的 transaction 裡):撞 UNIQUE 時只記 warn,不會把呼叫端的 transaction 弄壞。
async function ensureAccounts(bookId, list) {
  if (!Array.isArray(list)) return;
  for (const acc of list.slice(0, 5)) {
    const name = acc && typeof acc.name === 'string' ? acc.name.trim().slice(0, 50) : '';
    const type = acc && acc.type;
    if (!name || !['cash', 'bank', 'virtual', 'liability'].includes(type)) continue;
    try {
      // 先查後插。migration 017 起 ag_accounts(book_id, name) 有 UNIQUE(科目則是 subjects(book_id, code) WHERE code<>''),
      // 兩張同時推來撞到時,第二筆 INSERT 會被 UNIQUE 擋下 → 進下面 catch 只記 warn,
      // 後面 resolveAccountId 照樣找得到先建的那一個(不會建出兩個同名帳戶)。
      const exists = await query(
        `SELECT id FROM ag_accounts WHERE book_id = $1 AND name = $2`,
        [bookId, name]
      );
      if (exists.rows.length > 0) continue;
      const created = await query(
        `INSERT INTO ag_accounts (book_id, name, type, display_order)
         SELECT $1, $2, $3, COALESCE(MAX(display_order), 0) + 10 FROM ag_accounts WHERE book_id = $1
         RETURNING id`,
        [bookId, name, type]
      );
      console.log(`[posting] ensure_accounts: 建立 ${name} (${type}) → id ${created.rows[0].id}`);
    } catch (e) {
      console.warn(`[posting] ensure_accounts ${name} failed: ${e.message}`);
    }
  }
}

// ── webhook log helper (returns log id for FK) ──────────────────────
async function logWebhookInbound(req, bookId, hmacValid, status, responseBody) {
  try {
    const r = await query(
      `INSERT INTO webhook_logs_inbound
         (book_id, external_source, event_id, request_path, request_headers,
          request_body, response_status, response_body, hmac_valid, client_ip)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10)
       RETURNING id`,
      [
        bookId || null,
        (req.body && req.body.external_source) || null,
        (req.body && req.body.event_id) || null,
        req.originalUrl || req.url || '',
        JSON.stringify(req.headers || {}),
        JSON.stringify(req.body || {}),
        status,
        JSON.stringify(responseBody || {}),
        hmacValid,
        req.ip || req.connection?.remoteAddress || null,
      ]
    );
    return r.rows[0]?.id || null;
  } catch (e) {
    console.error('[webhook-log] failed:', e.message);
    return null;
  }
}

// G1:auto 模式先寫「處理中」那列,結束後回寫真正結果
async function updateWebhookLog(logId, status, responseBody) {
  if (!logId) return;
  try {
    await query(
      `UPDATE webhook_logs_inbound SET response_status = $1, response_body = $2::jsonb WHERE id = $3`,
      [status, JSON.stringify(responseBody || {}), logId]
    );
  } catch (e) {
    console.error('[webhook-log] update failed:', e.message);
  }
}

// 觸發者 emp_id:頂層或 payload 都讀,存進待審 payload(核准時才拿得到;G4)
function readTriggeredEmpId(b, payload) {
  return (b && b.triggered_by_emp_id) || (payload && typeof payload === 'object' && payload.triggered_by_emp_id) || null;
}
function payloadWithTrigger(payload, empId) {
  const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? { ...payload } : {};
  if (empId && !p.triggered_by_emp_id) p.triggered_by_emp_id = empId;
  return p;
}

// ============================================================================
// POST /B/:bookCode/internal/posting
// ============================================================================
router.post('/B/:bookCode/internal/posting', loadOpen, asyncHandler(async (req, res) => {
  // auth(第二輪 §4.1:簽章含 method + path)
  let hmacValid = false;
  if (hmac.isConfigured()) {
    const r = hmac.verifyRequest(req.headers, req.rawBody || '', req.method, req.path);
    if (!r.valid) {
      await logWebhookInbound(req, req.book.id, false, 401, { error: r.reason });
      return res.status(401).json({ error: r.reason });
    }
    hmacValid = true;
  } else if (SHARED_POSTING_TOKEN) {
    if (req.headers['x-posting-token'] !== SHARED_POSTING_TOKEN) {
      await logWebhookInbound(req, req.book.id, false, 401, { error: 'invalid X-Posting-Token' });
      return res.status(401).json({ error: 'invalid or missing X-Posting-Token' });
    }
  } else if (!hmac.allowUnsigned()) {
    // 主 repo 包 16 B1:沒設密鑰不再全部放行(只有本機開發明確開 HMAC_ALLOW_UNSIGNED=1 才放)
    await logWebhookInbound(req, req.book.id, false, 401, { error: hmac.NOT_CONFIGURED_REASON });
    return res.status(401).json({ error: hmac.NOT_CONFIGURED_REASON });
  }

  const b = req.body || {};
  const { external_source, external_id, event_id, event_type, payload, proposed_journal, invoices } = b;
  const triggeredEmpId = readTriggeredEmpId(b, payload);

  if (!external_source || typeof external_source !== 'string' || external_source.length > 30) {
    const body = { error: '缺少來源代號(最多 30 字)' };
    await logWebhookInbound(req, req.book.id, hmacValid, 400, body);
    return res.status(400).json(body);
  }
  if (!external_id || typeof external_id !== 'string' || external_id.length > 100) {
    const body = { error: '缺少單據代號(最多 100 字)' };
    await logWebhookInbound(req, req.book.id, hmacValid, 400, body);
    return res.status(400).json(body);
  }
  const vErr = validateProposedJournal(proposed_journal);
  if (vErr) {
    const body = { error: vErr.error };
    await logWebhookInbound(req, req.book.id, hmacValid, vErr.status, body);
    return res.status(vErr.status).json(body);
  }

  // Phase 3:ensure_accounts — 缺的帳戶自動補建(抽成 ensureAccounts,supersede replace 也用;§4.3)
  await ensureAccounts(req.book.id, b.ensure_accounts);

  // idempotency
  const existJ = await query(
    `SELECT id FROM journal_logs WHERE book_id = $1 AND external_source = $2 AND external_id = $3`,
    [req.book.id, external_source, external_id]
  );
  if (existJ.rows.length > 0) {
    const body = { idempotent: true, journal_id: existJ.rows[0].id, status: 'already_posted' };
    await logWebhookInbound(req, req.book.id, hmacValid, 200, body);
    return res.status(200).json(body);
  }
  const existP = await query(
    `SELECT id, status, resulting_journal_id FROM pending_journals
      WHERE book_id = $1 AND external_source = $2 AND external_id = $3`,
    [req.book.id, external_source, external_id]
  );
  if (existP.rows.length > 0) {
    const row = existP.rows[0];
    const body = { idempotent: true, pending_journal_id: row.id, status: row.status, journal_id: row.resulting_journal_id };
    await logWebhookInbound(req, req.book.id, hmacValid, 200, body);
    return res.status(200).json(body);
  }

  // N7：resolve posting mode per source per event_type
  const mode = resolvePostingMode(req.book, external_source, event_type);

  if (mode === 'manual') {
    const body = { error: '這個來源目前設定為不收件,請改到記帳雲手動記帳' };
    await logWebhookInbound(req, req.book.id, hmacValid, 422, body);
    return res.status(422).json(body);
  }

  // 關帳(§4.8):日期在關帳期間 → 422(auto 與 review 都擋:進了待審也核准不了,不如收件就退,
  // 讓來源端標失敗 + 告警,老闆解鎖後到對帳頁補推)。auto 的 transaction 裡會再驗一次(鎖帳本那列)。
  try {
    await assertNotClosed({ query }, req.book.id, proposed_journal.date, { mode: 'push' });
  } catch (e) {
    if (!e.status) throw e;
    const body = { error: e.message, code: e.errCode };
    await logWebhookInbound(req, req.book.id, hmacValid, e.status, body);
    return res.status(e.status).json(body);
  }

  if (mode === 'auto') {
    let webhookLogId = null;
    let result;
    try {
      result = await withTransaction(async (client) => {
        webhookLogId = await logWebhookInbound(req, req.book.id, hmacValid, 0, { in_progress: true });

        // 關帳(§4.8):在 transaction 裡鎖住帳本那列再驗一次,關帳設定改到一半不會有人插隊入帳
        await assertNotClosed(client, req.book.id, proposed_journal.date, { mode: 'push' });

        const pj = await client.query(
          `INSERT INTO pending_journals (book_id, external_source, external_id, event_id, payload, proposed_journal, status)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'auto_posted') RETURNING id`,
          [req.book.id, external_source, external_id, event_id || null,
           JSON.stringify(payloadWithTrigger(payload, triggeredEmpId)), JSON.stringify(proposed_journal)]
        );

        const inserted = await insertJournalFromProposed(
          client, req.book.id, proposed_journal,
          external_source, external_id, SYSTEM_BOT_USER_ID, true, triggeredEmpId, webhookLogId
        );

        await client.query(
          `UPDATE pending_journals SET resulting_journal_id = $1, reviewed_at = NOW() WHERE id = $2`,
          [inserted.journal.id, pj.rows[0].id]
        );

        // D25: write invoices if any
        if (Array.isArray(invoices) && invoices.length > 0) {
          await writeInvoices(client, req.book.id, inserted.journal.id, invoices);
        } else if (payload && Array.isArray(payload.invoices) && payload.invoices.length > 0) {
          await writeInvoices(client, req.book.id, inserted.journal.id, payload.invoices);
        }

        return { journal: inserted.journal, balance_gap: inserted.balance_gap };
      });
    } catch (e) {
      const status = e.status || 500;
      const body = e.status
        ? (e.errCode ? { error: e.message, code: e.errCode } : { error: e.message })
        : { error: '系統發生錯誤,這筆沒有入帳' };
      if (webhookLogId) await updateWebhookLog(webhookLogId, status, { error: e.message });
      else await logWebhookInbound(req, req.book.id, hmacValid, status, { error: e.message });
      if (!e.status) throw e;
      return res.status(status).json(body);
    }

    const body = {
      status: 'posted',
      mode: 'auto',
      journal_id: result.journal.id,
      balance_gap: result.balance_gap === null ? null : 0,  // 不平的單已在上面 422 擋掉
    };
    await updateWebhookLog(webhookLogId, 201, body);
    return res.status(201).json(body);
  }

  // review mode —— 存進待審前先驗一次(Y3:錯的單收件就 422,不要等到核准才 500)
  try {
    await precheckProposed({ query }, req.book.id, proposed_journal);
  } catch (e) {
    if (!e.status) throw e;
    const body = { error: e.message };
    await logWebhookInbound(req, req.book.id, hmacValid, e.status, body);
    return res.status(e.status).json(body);
  }
  // Y7(§4.2):頂層 invoices 也存進 payload(以前只存 payload,發票整批掉;核准時從 payload.invoices 讀)
  const pendingRes = await query(
    `INSERT INTO pending_journals (book_id, external_source, external_id, event_id, payload, proposed_journal, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'pending') RETURNING *`,
    [req.book.id, external_source, external_id, event_id || null,
     JSON.stringify(payloadForStore(payload, triggeredEmpId, invoices)), JSON.stringify(proposed_journal)]
  );
  const body = { mode: 'review', status: 'pending', pending_journal: pendingRes.rows[0] };
  await logWebhookInbound(req, req.book.id, hmacValid, 202, { pending_id: pendingRes.rows[0].id, mode: 'review' });
  res.status(202).json(body);
}));

// ============================================================================
// POST /B/:bookCode/internal/supersede — Phase 2 (紙測 F9)
// 來源單據「修改 / 作廢」後的雲端跟進：
//   1. base 還掛在待審 → 退回（review_note 標 superseded）
//   2. base 已入帳且未沖銷 → 自動反向沖銷（單式、composite、reclassify 1:N 都支援,走 reverseJournalRow）
//   3. action='replace' → 新版本（new_external_id 帶 @v2）永遠進待審 —
//      改過的單一律人工核，不走 auto（N7 同精神）
//   4. base 在待審與分錄都查無 → 409 base_not_found(R2:base 可能還在來源端退避重試,
//      先回 200 會讓作廢 / 改單變成 no-op,base 晚到就留在帳上)。來源端看到非 2xx 會自己重試。
// 冪等：replace 以 new_external_id 判重；void 重送時 base 已沖銷 → idempotent
// ============================================================================
router.post('/B/:bookCode/internal/supersede', loadOpen, asyncHandler(async (req, res) => {
  // auth — 同 /internal/posting(第二輪 §4.1:簽章含 method + path)
  let hmacValid = false;
  if (hmac.isConfigured()) {
    const r = hmac.verifyRequest(req.headers, req.rawBody || '', req.method, req.path);
    if (!r.valid) {
      await logWebhookInbound(req, req.book.id, false, 401, { error: r.reason });
      return res.status(401).json({ error: r.reason });
    }
    hmacValid = true;
  } else if (SHARED_POSTING_TOKEN) {
    if (req.headers['x-posting-token'] !== SHARED_POSTING_TOKEN) {
      return res.status(401).json({ error: 'invalid or missing X-Posting-Token' });
    }
  } else if (!hmac.allowUnsigned()) {
    // 主 repo 包 16 B1:同 /internal/posting
    return res.status(401).json({ error: hmac.NOT_CONFIGURED_REASON });
  }

  const b = req.body || {};
  const { external_source, base_external_id, action, reason, event_id,
          new_external_id, proposed_journal, payload, invoices } = b;
  const triggeredEmpId = readTriggeredEmpId(b, payload);

  if (!external_source || !base_external_id) {
    const body = { error: '缺少來源代號或原單代號' };
    await logWebhookInbound(req, req.book.id, hmacValid, 400, body);
    return res.status(400).json(body);
  }
  if (!['void', 'replace'].includes(action)) {
    const body = { error: '動作只能是作廢或修改' };
    await logWebhookInbound(req, req.book.id, hmacValid, 400, body);
    return res.status(400).json(body);
  }
  if (!reason || !String(reason).trim()) {
    const body = { error: '缺少原因' };
    await logWebhookInbound(req, req.book.id, hmacValid, 400, body);
    return res.status(400).json(body);
  }
  if (action === 'replace') {
    if (!new_external_id || typeof new_external_id !== 'string' || new_external_id.length > 100
        || new_external_id === base_external_id) {
      const body = { error: '修改要帶新版本的單據代號(不能跟原單一樣)' };
      await logWebhookInbound(req, req.book.id, hmacValid, 400, body);
      return res.status(400).json(body);
    }
    const vErr = validateProposedJournal(proposed_journal);
    if (vErr) {
      const body = { error: vErr.error };
      await logWebhookInbound(req, req.book.id, hmacValid, vErr.status, body);
      return res.status(vErr.status).json(body);
    }
    // B5(§4.3):新版本用到的新帳戶(例:薪資重算第一次用到「應付代扣稅款」)先補建,
    // 不然存進待審前的檢查就找不到帳戶。在 transaction 外面做(撞 UNIQUE 不會弄壞下面的 transaction)。
    await ensureAccounts(req.book.id, b.ensure_accounts);
  }

  const reasonText = String(reason).slice(0, 500);

  let result;
  try {
    result = await withTransaction(async (client) => {
      const out = { reversed_journal_id: null, rejected_pending_id: null, new_pending_id: null, idempotent: false };

      // 冪等（replace）：新版本已收過 → 直接回
      if (action === 'replace') {
        const exist = await client.query(
          `SELECT id, status FROM pending_journals
            WHERE book_id = $1 AND external_source = $2 AND external_id = $3`,
          [req.book.id, external_source, new_external_id]
        );
        if (exist.rows.length > 0) {
          out.idempotent = true;
          out.new_pending_id = exist.rows[0].id;
          return out;
        }
        // G8:新版本已經直接入帳過(走過 /internal/posting)→ 也算收過
        const existJ = await client.query(
          `SELECT id FROM journal_logs WHERE book_id = $1 AND external_source = $2 AND external_id = $3`,
          [req.book.id, external_source, new_external_id]
        );
        if (existJ.rows.length > 0) {
          out.idempotent = true;
          return out;
        }
      }

      // 關帳(§4.8):鎖住帳本那列讀關帳日;新版本日期在關帳期間 → 422(整包不做,原單也不沖)
      const closedThrough = await loadClosedThrough(client, req.book.id);
      if (action === 'replace') {
        await assertNotClosed(client, req.book.id, proposed_journal.date, { mode: 'push', closedThrough });
      }

      // 1. base 還在待審 → 退回
      const pend = await client.query(
        `SELECT id, status FROM pending_journals
          WHERE book_id = $1 AND external_source = $2 AND external_id = $3
          ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [req.book.id, external_source, base_external_id]
      );
      if (pend.rows.length > 0 && pend.rows[0].status === 'pending') {
        await client.query(
          `UPDATE pending_journals
              SET status = 'rejected', review_note = $1, reviewed_at = NOW(), updated_at = NOW()
            WHERE id = $2`,
          [`superseded: ${String(reason).slice(0, 300)}`, pend.rows[0].id]
        );
        out.rejected_pending_id = pend.rows[0].id;
      }

      // 2. base 已入帳且未沖銷 → 反向沖銷(共用 reverseJournalRow)
      const jr = await client.query(
        `SELECT * FROM journal_logs
          WHERE book_id = $1 AND external_source = $2 AND external_id = $3 FOR UPDATE`,
        [req.book.id, external_source, base_external_id]
      );

      // 4. 兩邊都查無 → 409,讓來源端稍後重試(R2)
      if (pend.rows.length === 0 && jr.rows.length === 0) {
        throw httpError(409, '原單還沒送到,請稍後重試', { errCode: 'base_not_found' });
      }

      if (jr.rows.length > 0) {
        const o = jr.rows[0];
        if (!o.reversed_by_id && !o.reverses_id) {
          // 沒關帳:沖銷單日期 = 原單日期(照舊);原單已關帳:沖銷單記在今天、摘要標「[沖銷 原單日期 的單]」
          const dates = reverseDatesFor(o, closedThrough, { keepOriginalDay: true, mode: 'push' });
          const baseSummary = `[來源單據${action === 'void' ? '作廢' : '修改'}沖銷] ${base_external_id}`;
          const reverse = await reverseJournalRow(client, req.book.id, o, {
            date: dates.date,
            originalDate: dates.originalDate,
            summary: (dates.summaryPrefix ? `${dates.summaryPrefix} ${baseSummary}` : baseSummary).slice(0, SUMMARY_MAX),
            note: reasonText,
            userId: SYSTEM_BOT_USER_ID,
            isAuto: true,
          });
          out.reversed_journal_id = reverse.id;
          // Y11 後半(§4.5):自動沖銷也寫稽核,明細頁「歷史」才看得到是誰、為什麼沖的
          await client.query(
            `INSERT INTO reverse_audit_log (original_journal_id, reverse_journal_id, reversed_by_user_id, reason)
             VALUES ($1, $2, $3, $4)`,
            [o.id, reverse.id, SYSTEM_BOT_USER_ID, `${sourceLabel(external_source)}自動沖銷:${reasonText}`]
          );
          // Y7(§4.2):原單的發票一起標作廢(改單的新版核准後會寫新的發票)
          out.voided_invoices = await voidInvoicesOfJournal(client, req.book.id, o.id, reasonText);
        } else {
          out.idempotent = out.idempotent || !!o.reversed_by_id; // void 重送：已沖銷過
        }
      }

      // 3. replace → 新版本永遠進待審(存之前先驗,錯的單 422)
      if (action === 'replace') {
        await precheckProposed(client, req.book.id, proposed_journal);
        // Y7(§4.2):新版的發票(頂層 invoices 優先、沒有才用 payload.invoices)存進待審 payload,核准時寫入
        const insP = await client.query(
          `INSERT INTO pending_journals (book_id, external_source, external_id, event_id, payload, proposed_journal, status)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'pending') RETURNING id`,
          [req.book.id, external_source, new_external_id, event_id || null,
           JSON.stringify(payloadForStore(payload, triggeredEmpId, invoices)), JSON.stringify(proposed_journal)]
        );
        out.new_pending_id = insP.rows[0].id;
      }

      return out;
    });
  } catch (e) {
    if (!e.status) throw e;
    const body = e.errCode ? { error: e.message, code: e.errCode } : { error: e.message };
    await logWebhookInbound(req, req.book.id, hmacValid, e.status, body);
    return res.status(e.status).json(body);
  }

  await logWebhookInbound(req, req.book.id, hmacValid, 200, result);
  res.status(200).json({ ok: true, ...result });
}));

// ============================================================================
// GET /B/:bookCode/pending-journals(§3.2:分頁 + 每條科目腳帶 subject_parent_type)
// ============================================================================
function clampInt(v, def, min, max) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isInteger(n)) return def;
  return Math.min(Math.max(n, min), max);
}

// 讓前端用 §4.3 公式算 gap:composite 每條科目腳多帶 subject_parent_type(帳戶腳為 null)
async function annotateLegParentTypes(bookId, rows) {
  const needs = rows.some(r => r.proposed_journal && r.proposed_journal.type === 'composite'
    && Array.isArray(r.proposed_journal.legs));
  if (!needs) return;
  const s = await query(`SELECT id, code, parent_type FROM subjects WHERE book_id = $1`, [bookId]);
  const byCode = new Map();
  const byId = new Map();
  for (const x of s.rows) {
    if (x.code) byCode.set(String(x.code), x.parent_type);
    byId.set(String(x.id), x.parent_type);
  }
  for (const r of rows) {
    const p = r.proposed_journal;
    if (!p || p.type !== 'composite' || !Array.isArray(p.legs)) continue;
    for (const leg of p.legs) {
      if (!leg || typeof leg !== 'object') continue;
      if (leg.kind !== 'subject') { leg.subject_parent_type = null; continue; }
      let pt = null;
      if (leg.subject_code !== undefined && leg.subject_code !== null && leg.subject_code !== '') {
        pt = byCode.get(String(leg.subject_code).trim()) || null;
      } else if (leg.subject_id) {
        pt = byId.get(String(leg.subject_id)) || null;
      }
      leg.subject_parent_type = pt;
    }
  }
}

router.get('/B/:bookCode/pending-journals', requireAuth, loadAuth, asyncHandler(async (req, res) => {
  const status = req.query.status || 'pending';
  if (!['pending', 'approved', 'rejected', 'auto_posted', 'all'].includes(status)) {
    return res.status(400).json({ error: '篩選條件不正確' });
  }
  const limit = clampInt(req.query.limit, 50, 1, 200);
  const offset = clampInt(req.query.offset, 0, 0, 1000000);

  const where = ['pj.book_id = $1'];
  const params = [req.book.id];
  if (status !== 'all') {
    params.push(status);
    where.push(`pj.status = $${params.length}`);
  }
  if (req.query.external_source) {
    params.push(String(req.query.external_source));
    where.push(`pj.external_source = $${params.length}`);
  }

  const totalRes = await query(
    `SELECT COUNT(*)::int AS total FROM pending_journals pj WHERE ${where.join(' AND ')}`,
    params
  );

  const listParams = params.concat([limit, offset]);
  const result = await query(
    `SELECT pj.*,
            au.name AS approved_by_name,
            ru.name AS rejected_by_name
       FROM pending_journals pj
       LEFT JOIN users au ON au.id = pj.approved_by_user_id
       LEFT JOIN users ru ON ru.id = pj.rejected_by_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY pj.created_at DESC, pj.id DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams
  );
  await annotateLegParentTypes(req.book.id, result.rows);
  res.json({
    pending_journals: result.rows,
    count: result.rows.length,
    total: totalRes.rows[0].total,
    limit,
    offset,
  });
}));

// ============================================================================
// POST approve-batch(§3.1;放在 /:id 路由前面)
// ============================================================================
function friendlyApproveError(e) {
  if (e && e.status && e.status < 500) return e.message;
  console.error('[approve] unexpected error:', e);
  return '系統暫時有問題,這筆沒有核准,請稍後再試';
}

router.post(
  '/B/:bookCode/pending-journals/approve-batch',
  requireAuth, loadAuth, requireRole('owner', 'admin', 'editor'),
  asyncHandler(async (req, res) => {
    const rawIds = req.body && req.body.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return res.status(400).json({ error: '請至少勾選一筆' });
    }
    if (rawIds.length > BATCH_MAX) {
      return res.status(400).json({ error: `一次最多核准 ${BATCH_MAX} 筆,請分批` });
    }
    const ids = [];
    const seen = new Set();
    for (const raw of rawIds) {
      const n = (typeof raw === 'string' && /^\d+$/.test(raw)) ? Number(raw) : raw;
      if (!Number.isInteger(n) || n < 1) {
        return res.status(400).json({ error: '勾選的單據編號不正確,請重新整理頁面再試' });
      }
      if (!seen.has(n)) { seen.add(n); ids.push(n); }
    }
    const rawNote = req.body.note;
    const note = (typeof rawNote === 'string' && rawNote.trim()) ? rawNote.trim().slice(0, 500) : null;

    const results = [];
    for (const id of ids) {
      try {
        // 每筆各自一個 transaction,一筆失敗不影響其他
        const r = await withTransaction((client) => approveOne(client, req.book.id, id, req.user.id, note));
        results.push({ id, ok: true, journal_id: r.journal.id });
      } catch (e) {
        results.push({ id, ok: false, error: friendlyApproveError(e) });
      }
    }
    res.json({ results });
  })
);

router.get('/B/:bookCode/pending-journals/:id', requireAuth, loadAuth, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: '單據編號不正確' });
  const result = await query(
    `SELECT pj.*,
            au.name AS approved_by_name,
            ru.name AS rejected_by_name
       FROM pending_journals pj
       LEFT JOIN users au ON au.id = pj.approved_by_user_id
       LEFT JOIN users ru ON ru.id = pj.rejected_by_user_id
      WHERE pj.id = $1 AND pj.book_id = $2`,
    [id, req.book.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: '找不到這筆待審單' });
  await annotateLegParentTypes(req.book.id, result.rows);
  res.json({ pending_journal: result.rows[0] });
}));

// ============================================================================
// approve / reject (S7 audit trail)
// ============================================================================
const STATUS_TEXT = {
  approved: '這筆已經被別人核准了',
  rejected: '這筆已經被退回了',
  auto_posted: '這筆已經自動入帳了',
};

// 單筆核准核心:鎖 → 驗 → 寫分錄 → 更新餘額 → 回寫(單筆與批次共用)
async function approveOne(client, bookId, pendingId, userId, note) {
  const pjRes = await client.query(
    `SELECT * FROM pending_journals WHERE id = $1 AND book_id = $2 FOR UPDATE`,
    [pendingId, bookId]
  );
  if (pjRes.rows.length === 0) throw httpError(404, '找不到這筆待審單');
  const pj = pjRes.rows[0];
  if (pj.status !== 'pending') throw httpError(409, STATUS_TEXT[pj.status] || '這筆已經被處理過了');

  const proposed = pj.proposed_journal;
  // 關帳(§4.8):待審單的日期在關帳期間 → 409,不准核准進關帳月
  await assertNotClosed(client, bookId, proposed && proposed.date, { mode: 'ui' });
  const triggeredEmpId = (pj.payload && pj.payload.triggered_by_emp_id) || null;
  let inserted;
  try {
    // 人工核准:is_auto_posted = false(G3)
    inserted = await insertJournalFromProposed(
      client, bookId, proposed,
      pj.external_source, pj.external_id, userId, false, triggeredEmpId, null
    );
  } catch (e) {
    if (e && e.code === '23505') throw httpError(409, '這筆已經入帳過了(同一張單重複送)');
    throw e;
  }
  const upd = await client.query(
    `UPDATE pending_journals
        SET status = 'approved',
            reviewed_by = $1, reviewed_at = NOW(),
            approved_by_user_id = $1, approved_at = NOW(),
            review_note = $2, resulting_journal_id = $3, updated_at = NOW()
      WHERE id = $4 AND book_id = $5 AND status = 'pending'`,
    [userId, note || null, inserted.journal.id, pendingId, bookId]
  );
  if (upd.rowCount === 0) throw httpError(409, '這筆已經被處理過了');

  // invoices from payload
  const invs = pj.payload && pj.payload.invoices;
  if (Array.isArray(invs) && invs.length > 0) {
    await writeInvoices(client, bookId, inserted.journal.id, invs);
  }

  return { pending_id: pendingId, journal: inserted.journal, balance_gap: inserted.balance_gap };
}

router.post(
  '/B/:bookCode/pending-journals/:id/approve',
  requireAuth, loadAuth, requireRole('owner', 'admin', 'editor'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: '單據編號不正確' });
    const b = req.body || {};
    const rawNote = b.review_note !== undefined ? b.review_note : b.note;
    const note = (typeof rawNote === 'string' && rawNote.trim()) ? rawNote.trim().slice(0, 500) : null;

    const result = await withTransaction((client) => approveOne(client, req.book.id, id, req.user.id, note));
    res.json({ ok: true, ...result });
  })
);

router.post(
  '/B/:bookCode/pending-journals/:id/reject',
  requireAuth, loadAuth, requireRole('owner', 'admin', 'editor'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: '單據編號不正確' });
    const rawReason = (req.body && (req.body.rejected_reason || req.body.review_note)) || null;
    const reason = (typeof rawReason === 'string' && rawReason.trim()) ? rawReason.trim().slice(0, 500) : null;

    // Y10:跟核准一樣鎖住那列,只准從「待審」改成「退回」
    await withTransaction(async (client) => {
      const pjRes = await client.query(
        `SELECT id, status FROM pending_journals WHERE id = $1 AND book_id = $2 FOR UPDATE`,
        [id, req.book.id]
      );
      if (pjRes.rows.length === 0) throw httpError(404, '找不到這筆待審單');
      if (pjRes.rows[0].status !== 'pending') throw httpError(409, '這筆已經被處理過了');
      const upd = await client.query(
        `UPDATE pending_journals
            SET status = 'rejected',
                reviewed_by = $1, reviewed_at = NOW(),
                rejected_by_user_id = $1, rejected_at = NOW(),
                rejected_reason = $2,
                review_note = $2,
                updated_at = NOW()
          WHERE id = $3 AND book_id = $4 AND status = 'pending'`,
        [req.user.id, reason, id, req.book.id]
      );
      if (upd.rowCount === 0) throw httpError(409, '這筆已經被處理過了');
    });
    res.json({ ok: true, pending_id: id, status: 'rejected' });
  })
);

router.use((err, req, res, next) => {
  if (err.status) {
    return res.status(err.status).json(err.errCode ? { error: err.message, code: err.errCode } : { error: err.message });
  }
  next(err);
});

// Export helpers for journals.js (reverse path reuses these)
module.exports = router;
module.exports.helpers = {
  insertJournalFromProposed,
  insertCompositeJournal,
  insertLegacyJournal,
  resolveSubjectId,
  resolveAccountId,
  writeInvoices,
  reverseJournalRow,
  reverseDatesFor,
  httpError,
  isRealDate,
  taipeiToday,
  toYmd,
  loadClosedThrough,
  assertNotClosed,
  isDateClosed,
  closedMessage,
  SYSTEM_BOT_USER_ID,
};
// 純函式(scratchpad 小測試用)
module.exports.pure = {
  compositeGap,
  compositeHeaderAmount,
  assertCompositeBalanced,
  validateProposedJournal,
  isRealDate,
  clampInt,
  toYmd,
  isDateClosed,
  closedMessage,
  reverseDatesFor,
  payloadForStore,
};
