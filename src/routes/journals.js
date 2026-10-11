// src/routes/journals.js
// 記帳記錄 CRUD.
// 規格書 §3.2.7. 支援 4 種 type: expense / income / transfer / reclassify.
// M1 階段 1a (v0.3): POST/GET/GET-by-id.
// M1 階段 1c (v0.7): DELETE = reverse (soft delete via 反向 journal).
// M1 階段 1d (v0.9, 2026-05-13): reclassify 1:N targets + PATCH /journals/:id.

'use strict';

const crypto = require('crypto');
const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth } = require('../auth');
const bookCode = require('../utils/bookCode');
const asyncHandler = require('../utils/asyncHandler');
const { helpers: postingHelpers } = require('./posting');

const {
  reverseJournalRow, reverseDatesFor, httpError, isRealDate,
  toYmd, loadClosedThrough, assertNotClosed,
} = postingHelpers;

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

const SUMMARY_MAX = 200;

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

function requireBookRole(...roles) {
  return (req, res, next) => {
    if (!req.bookMember || !roles.includes(req.bookMember.role)) {
      return res.status(403).json({ error: '你的角色不能做這個' });
    }
    next();
  };
}

// §3.4 沖銷權限:只有 owner / admin
function requireReverseRole(req, res, next) {
  if (!req.bookMember || !['owner', 'admin'].includes(req.bookMember.role)) {
    return res.status(403).json({ error: '只有老闆或管理員能沖銷' });
  }
  next();
}

const loadBook = asyncHandler(loadBookMiddleware);

const SELECT_JOURNAL_WITH_JOINS = `
  SELECT j.*,
         s.name AS subject_name, s.code AS subject_code, s.parent_type AS subject_parent_type,
         sf.name AS reclassify_from_subject_name, sf.code AS reclassify_from_subject_code,
         cp.name AS counterparty_name,
         ao.name AS transfer_out_account_name,
         ai.name AS transfer_in_account_name
    FROM journal_logs j
    LEFT JOIN subjects s ON s.id = j.subject_id
    LEFT JOIN subjects sf ON sf.id = j.reclassify_from_subject_id
    LEFT JOIN counterparties cp ON cp.id = j.counterparty_id
    LEFT JOIN ag_accounts ao ON ao.id = j.transfer_out_account_id
    LEFT JOIN ag_accounts ai ON ai.id = j.transfer_in_account_id
`;

// ── reclassify 1:N targets helpers ──────────────────────────────────
async function fetchTargetsForJournal(client, journalId) {
  const r = await client.query(
    `SELECT jrt.id, jrt.target_subject_id, jrt.amount, jrt.display_order,
            s.name AS target_subject_name, s.code AS target_subject_code
       FROM journal_reclassify_targets jrt
       JOIN subjects s ON s.id = jrt.target_subject_id
      WHERE jrt.journal_id = $1
      ORDER BY jrt.display_order, jrt.id`,
    [journalId]
  );
  return r.rows;
}

async function fetchTargetsForJournals(journalIds) {
  if (journalIds.length === 0) return new Map();
  const r = await query(
    `SELECT jrt.journal_id, jrt.id, jrt.target_subject_id, jrt.amount, jrt.display_order,
            s.name AS target_subject_name, s.code AS target_subject_code
       FROM journal_reclassify_targets jrt
       JOIN subjects s ON s.id = jrt.target_subject_id
      WHERE jrt.journal_id = ANY($1::bigint[])
      ORDER BY jrt.journal_id, jrt.display_order, jrt.id`,
    [journalIds]
  );
  const map = new Map();
  for (const row of r.rows) {
    if (!map.has(row.journal_id)) map.set(row.journal_id, []);
    map.get(row.journal_id).push({
      id: row.id,
      target_subject_id: row.target_subject_id,
      amount: row.amount,
      display_order: row.display_order,
      target_subject_name: row.target_subject_name,
      target_subject_code: row.target_subject_code,
    });
  }
  return map;
}

/**
 * 驗 + 規範化 body.targets for reclassify 1:N.
 * 回 { primarySubjectId, totalAmount, normalizedTargets }
 *   - normalizedTargets: [{ target_subject_id, amount, display_order }, ...]
 *   - 當 N=1 時 normalizedTargets 是空陣列 (single-target legacy 形式),
 *     primary 仍是該 target.
 *   - 當 N>=2 時 normalizedTargets 含全部 N 筆,primary = display_order=0 那筆.
 */
function normalizeReclassifyTargets(b, bookId) {
  // 兩種輸入支援:
  //  (a) targets: [{ subject_id, amount }, ...]   1:N 完整形式
  //  (b) subject_id + amount                       legacy 1:1 形式
  let targets = b.targets;
  if (!targets || !Array.isArray(targets)) {
    // 沒給 targets array → 走 legacy 1:1
    if (!b.subject_id) throw Object.assign(new Error('請選科目'), { status: 400 });
    if (!(Number(b.amount) > 0)) throw Object.assign(new Error('金額必須是大於 0 的整數(元)'), { status: 400 });
    return {
      primarySubjectId: Number(b.subject_id),
      totalAmount: Number(b.amount),
      normalizedTargets: [],  // empty = legacy single
    };
  }
  if (targets.length === 0) {
    throw Object.assign(new Error('至少要有一個轉入科目'), { status: 400 });
  }
  // Validate each
  const norm = [];
  let total = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (!t || !t.subject_id) throw Object.assign(new Error(`第 ${i + 1} 個轉入科目沒選`), { status: 400 });
    const amt = Number(t.amount);
    if (!(amt > 0)) throw Object.assign(new Error(`第 ${i + 1} 個轉入金額必須是大於 0 的整數(元)`), { status: 400 });
    norm.push({
      target_subject_id: Number(t.subject_id),
      amount: amt,
      display_order: i,
    });
    total += amt;
  }
  // De-dupe primary key (target_subject_id)
  const seen = new Set();
  for (const t of norm) {
    if (seen.has(t.target_subject_id)) {
      throw Object.assign(new Error('同一個科目重複出現在轉入清單'), { status: 400 });
    }
    seen.add(t.target_subject_id);
  }
  // If body.amount is also given, must match SUM (allow 2-cent floating tolerance)
  if (b.amount !== undefined && b.amount !== null) {
    const declared = Number(b.amount);
    if (Math.abs(declared - total) > 0.02) {
      throw Object.assign(new Error(`總金額 ${declared} 跟各科目加總 ${total} 對不上`), { status: 400 });
    }
  }
  if (norm.length === 1) {
    // N=1 → legacy 形式
    return {
      primarySubjectId: norm[0].target_subject_id,
      totalAmount: norm[0].amount,
      normalizedTargets: [],
    };
  }
  return {
    primarySubjectId: norm[0].target_subject_id,  // primary = display_order=0
    totalAmount: total,
    normalizedTargets: norm,
  };
}

async function insertChildTargets(client, journalId, targets) {
  for (const t of targets) {
    await client.query(
      `INSERT INTO journal_reclassify_targets (journal_id, target_subject_id, amount, display_order)
       VALUES ($1, $2, $3, $4)`,
      [journalId, t.target_subject_id, t.amount, t.display_order]
    );
  }
}

// ── FK validation 用 helper（一次性 EXISTS 檢查） ──────────────────────
// Bug B fix (2026-05-13): COUNT(DISTINCT id) 對比「去重後的 array length」，
// 否則同一個 subject_id 多處引用 (reclassify 1:N 的 primary = targets[0]) 會誤報。
async function validateFKs(client, bookId, opts) {
  const { subjectIds = [], accountIds = [], counterpartyId = null } = opts;
  if (subjectIds.length) {
    const uniqSubjects = [...new Set(subjectIds.map(Number))];
    const r = await client.query(
      `SELECT COUNT(DISTINCT id)::int AS c FROM subjects WHERE id = ANY($1::bigint[]) AND book_id = $2`,
      [uniqSubjects, bookId]
    );
    if (r.rows[0].c !== uniqSubjects.length) {
      throw Object.assign(new Error('有科目不屬於這本帳'), { status: 400 });
    }
  }
  if (accountIds.length) {
    const uniqAccounts = [...new Set(accountIds.map(Number))];
    const r = await client.query(
      `SELECT COUNT(DISTINCT id)::int AS c FROM ag_accounts WHERE id = ANY($1::bigint[]) AND book_id = $2`,
      [uniqAccounts, bookId]
    );
    if (r.rows[0].c !== uniqAccounts.length) {
      throw Object.assign(new Error('有帳戶不屬於這本帳'), { status: 400 });
    }
  }
  if (counterpartyId) {
    const r = await client.query(
      `SELECT 1 FROM counterparties WHERE id = $1 AND book_id = $2`,
      [counterpartyId, bookId]
    );
    if (r.rows.length === 0) {
      throw Object.assign(new Error('往來對象不屬於這本帳'), { status: 400 });
    }
  }
}

// ── 套用帳戶餘額變化（+/- direction）──────────────────────────────────
// Bug A fix (2026-05-13): 之前用 `$1 * $2` 兩個 parameter 讓 pg 推斷不出 type
// (operator is not unique: unknown * unknown). 直接在 JS 算好 signed delta 即可.
async function applyBalanceDelta(client, bookId, type, outAcc, inAcc, amount, direction) {
  const sign = direction === 'apply' ? 1 : -1;  // 'apply' or 'revert'
  const signedAmount = Number(amount) * sign;
  if (type === 'expense' || type === 'transfer') {
    await client.query(
      `UPDATE ag_accounts SET current_balance = current_balance - $1::numeric, updated_at = NOW()
         WHERE id = $2 AND book_id = $3`,
      [signedAmount, outAcc, bookId]
    );
  }
  if (type === 'income' || type === 'transfer') {
    await client.query(
      `UPDATE ag_accounts SET current_balance = current_balance + $1::numeric, updated_at = NOW()
         WHERE id = $2 AND book_id = $3`,
      [signedAmount, inAcc, bookId]
    );
  }
}

// ── 手動記帳冪等(第二輪 §4.7 / Y54)──────────────────────────────────
// 平板網路閃一下、回應沒收到 → 使用者重按「記一筆」就多一筆。前端每張表單帶一個 client_request_id,
// 同一張表單重送用同一個。後端記憶體 Map(單一 app container,不用 Redis):
//   key = bookId:userId:client_request_id → { at, journalId | promise, hash(內容指紋) }
//   同鍵同內容 → 回同一筆;同鍵但內容不同 → 409 白話(不回舊單假裝成功)
//   10 分鐘過期、最多 1000 筆(滿了丟最舊的)。沒帶 client_request_id 照舊(不強制)。
// 競態:第一次還在寫、第二次就進來 → 第一次在開始寫入前就先「佔位」(存一個還沒完成的 promise),
//   第二次看到佔位就等它:成功 → 回同一筆(200 + idempotent:true);失敗 → 佔位已拿掉,第二次自己重做一次。
const IDEM_TTL_MS = 10 * 60 * 1000;
const IDEM_MAX = 1000;
const idemMap = new Map();

function idemPurge(now) {
  for (const [k, v] of idemMap) {
    if (now - v.at > IDEM_TTL_MS) idemMap.delete(k);
    else break;   // Map 依放入順序走,後面的都比較新
  }
}

function idemReadId(b) {
  const v = b && b.client_request_id;
  if (v === undefined || v === null || v === '') return { id: null };
  if (typeof v !== 'string' || v.length > 64) {
    return { error: '這次送出的表單識別碼不對,請重新整理頁面再記一次' };
  }
  return { id: v };
}

async function loadJournalForResponse(bookId, id) {
  const r = await query(`${SELECT_JOURNAL_WITH_JOINS} WHERE j.book_id = $1 AND j.id = $2`, [bookId, id]);
  if (r.rows.length === 0) return null;
  const j = r.rows[0];
  const t = await fetchTargetsForJournals([j.id]);
  j.targets = t.get(j.id) || [];
  return j;
}

// 同一個識別碼、內容卻不一樣(第一次其實成功但回應遺失,使用者改了金額再按)→ 不能回舊單假裝成功
const IDEM_MISMATCH_MSG = '這張單剛才已經送出成功了,內容跟現在填的不一樣;請到明細找到那筆再修改,不要重送';

// body 內容指紋:排除 client_request_id 本身,物件鍵排序後 sha256(同內容不同鍵順序算同一張)
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}
function idemBodyHash(b) {
  const rest = { ...(b && typeof b === 'object' ? b : {}) };
  delete rest.client_request_id;
  return crypto.createHash('sha256').update(stableStringify(rest)).digest('hex');
}

/**
 * 用冪等鍵跑 work()(work 回傳新建的 journal 整列)。
 * bodyHash:這次送來內容的指紋;同鍵但指紋不同 → 409(IDEM_MISMATCH_MSG)。
 * 回 { journal, idempotent }。work 丟錯 → 拿掉佔位、照樣丟出去。
 */
async function runIdempotent(key, bookId, work, bodyHash) {
  if (!key) return { journal: await work(), idempotent: false };
  const sameBody = (entry) => !bodyHash || !entry.hash || entry.hash === bodyHash;
  for (let round = 0; round < 3; round++) {
    const now = Date.now();
    idemPurge(now);
    const hit = idemMap.get(key);
    if (hit && now - hit.at <= IDEM_TTL_MS) {
      if (hit.journalId) {
        if (!sameBody(hit)) throw httpError(409, IDEM_MISMATCH_MSG);
        const j = await loadJournalForResponse(bookId, hit.journalId);
        if (j) return { journal: j, idempotent: true };
        idemMap.delete(key);   // 那筆不見了(不該發生)→ 當沒做過
      } else if (hit.promise) {
        let jid = null;
        try {
          jid = await hit.promise;
        } catch (_) { /* 第一次失敗 → 佔位已拿掉,下一輪自己做 */ }
        if (jid) {
          // 第一次成功了:內容不同 → 409;相同 → 回同一筆
          if (!sameBody(hit)) throw httpError(409, IDEM_MISMATCH_MSG);
          const j = await loadJournalForResponse(bookId, jid);
          if (j) return { journal: j, idempotent: true };
        }
        continue;
      }
    }
    // 佔位(開始寫入之前)
    let resolveFn, rejectFn;
    const promise = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
    promise.catch(() => {});   // 沒人在等時不要變成未處理的 rejection
    const entry = { at: now, promise, journalId: null, hash: bodyHash || null };
    idemMap.delete(key);       // 先刪再放:保持 Map 依時間排序(過期清理靠這個)
    idemMap.set(key, entry);
    while (idemMap.size > IDEM_MAX) idemMap.delete(idemMap.keys().next().value);
    try {
      const journal = await work();
      entry.journalId = journal.id;
      entry.promise = null;
      resolveFn(journal.id);
      return { journal, idempotent: false };
    } catch (e) {
      if (idemMap.get(key) === entry) idemMap.delete(key);
      rejectFn(e);
      throw e;
    }
  }
  // 連續三輪都撞到別人正在做又失敗 → 不再等,直接當一般請求處理會有重複風險;請使用者重送
  throw httpError(409, '同一張單正在送出中,請稍等幾秒再看一次清單');
}

// ── POST /B/:bookCode/journals ─────────────────────────────────────────
// body:
//   date, type, amount, counterparty_id?, summary?, note?
//   --- per-type ---
//   expense:    subject_id, transfer_out_account_id
//   income:     subject_id, transfer_in_account_id
//   transfer:   subject_id, transfer_out_account_id, transfer_in_account_id
//   reclassify (1:1 legacy): subject_id, reclassify_from_subject_id, amount
//   reclassify (1:N new):    reclassify_from_subject_id,
//                            targets: [{ subject_id, amount }, ...]
//                            (subject_id / amount on top level optional;
//                             primary = targets[0], amount = sum(targets[*].amount))
router.post(
  '/B/:bookCode/journals',
  loadBook,
  requireBookRole('owner', 'admin', 'editor'),
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const date = b.date;
    const type = b.type;
    const counterpartyId = b.counterparty_id || null;
    const reclassifyFromSubjectId = b.reclassify_from_subject_id || null;
    const outAccountId = b.transfer_out_account_id || null;
    const inAccountId = b.transfer_in_account_id || null;

    if (!isRealDate(date)) {
      return res.status(400).json({ error: '日期不正確' });
    }
    if (!['expense', 'income', 'transfer', 'reclassify'].includes(type)) {
      return res.status(400).json({ error: '單據類型不正確' });
    }
    if (b.summary !== undefined && b.summary !== null && String(b.summary).length > SUMMARY_MAX) {
      return res.status(400).json({ error: `摘要太長(最多 ${SUMMARY_MAX} 字)` });
    }
    const idem = idemReadId(b);
    if (idem.error) return res.status(400).json({ error: idem.error });

    // ── Resolve (subject_id, amount, targets) by type ──────────────
    let subjectId, amount, normalizedTargets = [];
    if (type === 'reclassify') {
      const r = normalizeReclassifyTargets(b, req.book.id);
      subjectId = r.primarySubjectId;
      amount = r.totalAmount;
      normalizedTargets = r.normalizedTargets;
      if (!reclassifyFromSubjectId) {
        return res.status(400).json({ error: '分類轉移要選原科目' });
      }
      if (outAccountId || inAccountId) {
        return res.status(400).json({ error: '分類轉移不能選帳戶' });
      }
      // Check from != any target
      const allTargets = normalizedTargets.length > 0
        ? normalizedTargets.map((t) => t.target_subject_id)
        : [subjectId];
      if (allTargets.includes(Number(reclassifyFromSubjectId))) {
        return res.status(400).json({ error: '原科目不能跟轉入科目相同' });
      }
    } else {
      subjectId = Number(b.subject_id);
      amount = Number(b.amount);
      if (!Number.isInteger(subjectId) || subjectId < 1) return res.status(400).json({ error: '請選科目' });
      if (!(Number.isInteger(amount) && amount > 0)) return res.status(400).json({ error: '金額必須是大於 0 的整數(元)' });
      if (type === 'expense') {
        if (!outAccountId) return res.status(400).json({ error: '支出要選付款帳戶' });
        if (inAccountId) return res.status(400).json({ error: '支出不能選收款帳戶' });
        if (reclassifyFromSubjectId) return res.status(400).json({ error: '支出不能選原科目' });
      } else if (type === 'income') {
        if (!inAccountId) return res.status(400).json({ error: '收入要選收款帳戶' });
        if (outAccountId) return res.status(400).json({ error: '收入不能選付款帳戶' });
        if (reclassifyFromSubjectId) return res.status(400).json({ error: '收入不能選原科目' });
      } else if (type === 'transfer') {
        if (!outAccountId || !inAccountId) return res.status(400).json({ error: '轉帳要選轉出與轉入帳戶' });
        if (outAccountId === inAccountId) return res.status(400).json({ error: '轉出與轉入帳戶不能相同' });
        if (reclassifyFromSubjectId) return res.status(400).json({ error: '轉帳不能選原科目' });
      }
    }

    const idemKey = idem.id ? `${req.book.id}:${req.user.id}:${idem.id}` : null;
    const ran = await runIdempotent(idemKey, req.book.id, () => withTransaction(async (client) => {
      // 關帳(§4.8):日期在關帳期間 → 409
      await assertNotClosed(client, req.book.id, date, { mode: 'ui' });

      const subjectIds = [subjectId];
      if (reclassifyFromSubjectId) subjectIds.push(Number(reclassifyFromSubjectId));
      for (const t of normalizedTargets) subjectIds.push(t.target_subject_id);
      const accountIds = [outAccountId, inAccountId].filter(Boolean).map(Number);
      await validateFKs(client, req.book.id, { subjectIds, accountIds, counterpartyId });

      const ins = await client.query(
        `INSERT INTO journal_logs (
           book_id, date, type, amount,
           subject_id, reclassify_from_subject_id,
           transfer_out_account_id, transfer_in_account_id,
           counterparty_id, summary, note,
           created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
         RETURNING *`,
        [
          req.book.id, date, type, amount,
          subjectId, reclassifyFromSubjectId,
          outAccountId, inAccountId,
          counterpartyId, b.summary || null, b.note || null,
          req.user.id,
        ]
      );
      const journal = ins.rows[0];

      if (type === 'reclassify' && normalizedTargets.length > 0) {
        await insertChildTargets(client, journal.id, normalizedTargets);
      }

      await applyBalanceDelta(client, req.book.id, type, outAccountId, inAccountId, amount, 'apply');

      if (counterpartyId) {
        await client.query(
          `UPDATE counterparties SET promote_count = promote_count + 1, updated_at = NOW()
             WHERE id = $1 AND book_id = $2`,
          [counterpartyId, req.book.id]
        );
      }

      journal.targets = await fetchTargetsForJournal(client, journal.id);
      return journal;
    }), idemKey ? idemBodyHash(b) : null);

    if (ran.idempotent) return res.status(200).json({ journal: ran.journal, idempotent: true });
    res.status(201).json({ journal: ran.journal });
  })
);

// ── GET /B/:bookCode/journals?from=&to=&type=&subject_id=&counterparty_id=&account_id=&limit= ──
router.get('/B/:bookCode/journals', loadBook, asyncHandler(async (req, res) => {
  const { from, to, type, subject_id, counterparty_id, account_id } = req.query;
  const where = ['j.book_id = $1'];
  const params = [req.book.id];

  const isPosInt = (v) => /^\d+$/.test(String(v)) && Number(v) >= 1;
  if (from && !isRealDate(String(from))) return res.status(400).json({ error: '開始日期不正確' });
  if (to && !isRealDate(String(to))) return res.status(400).json({ error: '結束日期不正確' });
  if (subject_id && !isPosInt(subject_id)) return res.status(400).json({ error: '科目篩選不正確' });
  if (counterparty_id && !isPosInt(counterparty_id)) return res.status(400).json({ error: '往來對象篩選不正確' });
  if (account_id && !isPosInt(account_id)) return res.status(400).json({ error: '帳戶篩選不正確' });

  if (from) { where.push(`j.date >= $${params.length + 1}`); params.push(String(from)); }
  if (to) { where.push(`j.date <= $${params.length + 1}`); params.push(String(to)); }
  if (type) {
    if (!['expense', 'income', 'transfer', 'reclassify', 'composite'].includes(type)) {
      return res.status(400).json({ error: '類型篩選不正確' });
    }
    where.push(`j.type = $${params.length + 1}`);
    params.push(type);
  }
  if (subject_id) {
    // 1:N: subject_id 篩選也要查 reclassify_targets;Y8:composite 的科目腳也要找得到
    where.push(`(
      j.subject_id = $${params.length + 1}
      OR j.reclassify_from_subject_id = $${params.length + 1}
      OR EXISTS (SELECT 1 FROM journal_reclassify_targets jrt
                  WHERE jrt.journal_id = j.id AND jrt.target_subject_id = $${params.length + 1})
      OR EXISTS (SELECT 1 FROM journal_legs jl
                  WHERE jl.journal_log_id = j.id AND jl.subject_id = $${params.length + 1})
    )`);
    params.push(Number(subject_id));
  }
  if (counterparty_id) {
    where.push(`j.counterparty_id = $${params.length + 1}`);
    params.push(Number(counterparty_id));
  }
  if (account_id) {
    // Y8:composite 的帳戶腳(POS 收班、薪資、訂金退款)也要找得到
    where.push(`(
      j.transfer_out_account_id = $${params.length + 1}
      OR j.transfer_in_account_id = $${params.length + 1}
      OR EXISTS (SELECT 1 FROM journal_legs jl
                  WHERE jl.journal_log_id = j.id AND jl.account_id = $${params.length + 1})
    )`);
    params.push(Number(account_id));
  }

  const lim = Math.min(Math.max(Math.floor(Number(req.query.limit)) || 100, 1), 500);

  const result = await query(
    `${SELECT_JOURNAL_WITH_JOINS}
      WHERE ${where.join(' AND ')}
      ORDER BY j.date DESC, j.id DESC
      LIMIT ${lim}`,
    params
  );
  const journalIds = result.rows.map((r) => r.id);
  const targetsMap = await fetchTargetsForJournals(journalIds);
  for (const r of result.rows) {
    r.targets = targetsMap.get(r.id) || [];
  }
  res.json({ journals: result.rows, count: result.rows.length });
}));

// ── GET /B/:bookCode/journals/:id ─────────────────────────────────────
router.get('/B/:bookCode/journals/:id', loadBook, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: '記錄編號不正確' });
  }
  const result = await query(
    `${SELECT_JOURNAL_WITH_JOINS}
      WHERE j.book_id = $1 AND j.id = $2`,
    [req.book.id, id]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: '找不到這筆記錄' });
  }
  const journal = result.rows[0];
  const targetsMap = await fetchTargetsForJournals([journal.id]);
  journal.targets = targetsMap.get(journal.id) || [];
  res.json({ journal });
}));

// ── PATCH /B/:bookCode/journals/:id ───────────────────────────────────
// M1 階段 1d (2026-05-13): 修改現有 journal,自動重算帳戶餘額.
// 可改: date, amount, subject_id (非 reclassify), reclassify_from_subject_id (reclassify),
//       transfer_out_account_id / transfer_in_account_id (per type),
//       counterparty_id, summary, note, targets (reclassify 1:N).
// 不可改: type (用 reverse + 新增 替代), book_id.
// 不可改的 row: 已被 reverse 的 / 本身是 reverse 的.
router.patch(
  '/B/:bookCode/journals/:id',
  loadBook,
  requireBookRole('owner', 'admin', 'editor'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: '記錄編號不正確' });
    const b = req.body || {};

    if (b.type !== undefined) {
      return res.status(400).json({ error: '不能改單據類型;請先沖銷再重新記一筆' });
    }
    if (b.date !== undefined && !isRealDate(String(b.date))) {
      return res.status(400).json({ error: '日期不正確' });
    }
    if (b.summary !== undefined && b.summary !== null && String(b.summary).length > SUMMARY_MAX) {
      return res.status(400).json({ error: `摘要太長(最多 ${SUMMARY_MAX} 字)` });
    }

    const result = await withTransaction(async (client) => {
      const origRes = await client.query(
        `SELECT * FROM journal_logs WHERE id = $1 AND book_id = $2 FOR UPDATE`,
        [id, req.book.id]
      );
      if (origRes.rows.length === 0) {
        throw Object.assign(new Error('找不到這筆記錄'), { status: 404 });
      }
      const o = origRes.rows[0];
      if (o.reversed_by_id) {
        throw Object.assign(new Error('這筆已經被沖銷過了,不能再改'), { status: 409 });
      }
      if (o.reverses_id) {
        throw Object.assign(new Error('沖銷單不能修改'), { status: 400 });
      }

      // 關帳(§4.8):原單的有效日期、或要改成的新日期在關帳期間 → 409
      const closedThrough = await loadClosedThrough(client, req.book.id);
      await assertNotClosed(client, req.book.id, toYmd(o.original_date) || toYmd(o.date), { mode: 'ui', closedThrough });
      if (b.date !== undefined) {
        await assertNotClosed(client, req.book.id, String(b.date), { mode: 'ui', closedThrough });
      }

      // Y2:複式單(POS 收班 / 薪資 / 訂金退款)只准改日期、摘要(備註也可),
      //     金額 / 科目 / 帳戶 / 對象都在明細裡,改單頭不會動明細 → 擋。
      if (o.is_composite) {
        const locked = ['amount', 'subject_id', 'reclassify_from_subject_id', 'transfer_out_account_id',
          'transfer_in_account_id', 'counterparty_id', 'targets', 'legs'];
        if (locked.some((k) => b[k] !== undefined)) {
          throw Object.assign(
            new Error('這種多行明細的單只能改日期和摘要;要改金額或科目,請先沖銷,再請現場系統重新送一次'),
            { status: 400 }
          );
        }
        await client.query(
          `UPDATE journal_logs SET
             date = $1, summary = $2, note = $3,
             edited_at = NOW(), edited_by_id = $4, edit_count = edit_count + 1,
             updated_at = NOW(), updated_by = $4
           WHERE id = $5 AND book_id = $6`,
          [
            b.date !== undefined ? String(b.date) : o.date,
            b.summary !== undefined ? b.summary : o.summary,
            b.note !== undefined ? b.note : o.note,
            req.user.id, id, req.book.id,
          ]
        );
        const fin = await client.query(`SELECT * FROM journal_logs WHERE id = $1`, [id]);
        const j = fin.rows[0];
        j.targets = [];
        return j;
      }

      // 1. 算「新版」欄位
      const type = o.type;
      const newDate = b.date !== undefined ? b.date : o.date;
      const newCounterpartyId = b.counterparty_id !== undefined ? (b.counterparty_id || null) : o.counterparty_id;
      const newSummary = b.summary !== undefined ? b.summary : o.summary;
      const newNote = b.note !== undefined ? b.note : o.note;

      // Validate date
      if (newDate) {
        const d = newDate instanceof Date ? newDate.toISOString().slice(0, 10) : String(newDate);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          throw Object.assign(new Error('日期不正確'), { status: 400 });
        }
      }

      let newSubjectId = o.subject_id;
      let newAmount = Number(o.amount);
      let newReclassifyFromSubjectId = o.reclassify_from_subject_id;
      let newOutAcc = o.transfer_out_account_id;
      let newInAcc = o.transfer_in_account_id;
      let newTargets = null;  // null = don't rewrite child; [] = rewrite empty; [...] = rewrite with rows

      if (type === 'reclassify') {
        // Allow body.targets to fully redefine targets
        if (b.targets !== undefined || b.subject_id !== undefined || b.amount !== undefined) {
          // Re-normalize using whatever the caller supplied, merging with current
          const merged = {
            targets: b.targets,
            subject_id: b.subject_id !== undefined ? b.subject_id : o.subject_id,
            amount: b.amount !== undefined ? b.amount : undefined,
          };
          const r = normalizeReclassifyTargets(merged, req.book.id);
          newSubjectId = r.primarySubjectId;
          newAmount = r.totalAmount;
          newTargets = r.normalizedTargets;  // [] for N=1, [...] for N>=2
        }
        if (b.reclassify_from_subject_id !== undefined) {
          newReclassifyFromSubjectId = b.reclassify_from_subject_id || null;
        }
        if (!newReclassifyFromSubjectId) {
          throw Object.assign(new Error('分類轉移要選原科目'), { status: 400 });
        }
        // from != any target
        const allTargets = newTargets && newTargets.length > 0
          ? newTargets.map((t) => t.target_subject_id)
          : [newSubjectId];
        if (allTargets.includes(Number(newReclassifyFromSubjectId))) {
          throw Object.assign(new Error('原科目不能跟轉入科目相同'), { status: 400 });
        }
      } else {
        if (b.subject_id !== undefined) {
          const sid = Number(b.subject_id);
          if (!Number.isInteger(sid) || sid < 1) throw Object.assign(new Error('請選科目'), { status: 400 });
          newSubjectId = sid;
        }
        if (b.amount !== undefined) {
          const a = Number(b.amount);
          if (!(Number.isInteger(a) && a > 0)) throw Object.assign(new Error('金額必須是大於 0 的整數(元)'), { status: 400 });
          newAmount = a;
        }
        if (type === 'expense' || type === 'transfer') {
          if (b.transfer_out_account_id !== undefined) newOutAcc = b.transfer_out_account_id || null;
          if (!newOutAcc) throw Object.assign(new Error('要選付款帳戶'), { status: 400 });
        }
        if (type === 'income' || type === 'transfer') {
          if (b.transfer_in_account_id !== undefined) newInAcc = b.transfer_in_account_id || null;
          if (!newInAcc) throw Object.assign(new Error('要選收款帳戶'), { status: 400 });
        }
        if (type === 'transfer' && newOutAcc && newInAcc && Number(newOutAcc) === Number(newInAcc)) {
          throw Object.assign(new Error('轉出與轉入帳戶不能相同'), { status: 400 });
        }
      }

      // 2. Validate FKs
      const subjectIds = [Number(newSubjectId)];
      if (newReclassifyFromSubjectId) subjectIds.push(Number(newReclassifyFromSubjectId));
      if (newTargets) for (const t of newTargets) subjectIds.push(t.target_subject_id);
      const accountIds = [newOutAcc, newInAcc].filter(Boolean).map(Number);
      await validateFKs(client, req.book.id, {
        subjectIds: [...new Set(subjectIds)],
        accountIds,
        counterpartyId: newCounterpartyId,
      });

      // 3. Revert old account balance (use original amount + accounts + type)
      await applyBalanceDelta(
        client, req.book.id, o.type,
        o.transfer_out_account_id, o.transfer_in_account_id,
        Number(o.amount), 'revert'
      );

      // 4. Update journal_logs row
      await client.query(
        `UPDATE journal_logs SET
           date = $1, amount = $2,
           subject_id = $3, reclassify_from_subject_id = $4,
           transfer_out_account_id = $5, transfer_in_account_id = $6,
           counterparty_id = $7, summary = $8, note = $9,
           edited_at = NOW(), edited_by_id = $10, edit_count = edit_count + 1,
           updated_at = NOW(), updated_by = $10
         WHERE id = $11 AND book_id = $12`,
        [
          newDate, newAmount,
          newSubjectId, newReclassifyFromSubjectId,
          newOutAcc, newInAcc,
          newCounterpartyId, newSummary, newNote,
          req.user.id, id, req.book.id,
        ]
      );

      // 5. Rewrite child targets if reclassify and changed
      if (type === 'reclassify' && newTargets !== null) {
        await client.query(`DELETE FROM journal_reclassify_targets WHERE journal_id = $1`, [id]);
        if (newTargets.length > 0) {
          await insertChildTargets(client, id, newTargets);
        }
      }

      // 6. Apply new account balance
      await applyBalanceDelta(
        client, req.book.id, type,
        newOutAcc, newInAcc,
        newAmount, 'apply'
      );

      const finalRes = await client.query(`SELECT * FROM journal_logs WHERE id = $1`, [id]);
      const journal = finalRes.rows[0];
      journal.targets = await fetchTargetsForJournal(client, id);
      return journal;
    });

    res.json({ journal: result });
  })
);

// ============================================================================
// 沖銷(§3.4,2026-10-10)
//   POST   /B/:bookCode/journals/:id/reverse  body { reason 必填, date 可省略 } —— canonical
//   DELETE /B/:bookCode/journals/:id          舊入口,內部轉呼叫同一套(reason 預設「畫面沖銷(舊入口)」)
//   兩條都:只限 owner / admin、鎖原單、支援 composite 與 reclassify 1:N、寫 reverse_audit_log、
//   回 { reversal, original }。沖銷單 date = 台北今天(或指定),original_date = 原單日期(報表歸回原月);
//   原單已關帳時 original_date = 沖銷當天(第二輪 §4.8,見 reverseById)。
//   真正寫分錄的邏輯在 posting.js 的 reverseJournalRow(supersede 也共用)。
// ============================================================================
const LEGACY_DELETE_REASON = '畫面沖銷(舊入口)';

async function reverseById(client, bookId, id, userId, reason, dateOverride) {
  const origRes = await client.query(
    `SELECT * FROM journal_logs WHERE id = $1 AND book_id = $2 FOR UPDATE`,
    [id, bookId]
  );
  if (origRes.rows.length === 0) throw httpError(404, '找不到這筆記錄');
  const o = origRes.rows[0];

  // Q15 cascade 防護
  if (o.reverses_id) throw httpError(409, '這筆本身就是沖銷單,不能再沖銷');
  if (o.reversed_by_id) throw httpError(409, '這筆已經被沖銷過了');
  const dupCheck = await client.query(
    `SELECT id FROM journal_logs WHERE reverses_id = $1 LIMIT 1`,
    [o.id]
  );
  if (dupCheck.rows.length > 0) throw httpError(409, '這筆已經被沖銷過了');

  // 關帳(§4.8):原單在關帳期間照樣准沖,但沖銷單記在沖銷當天(original_date 也是那天,不回溯進關帳月),
  // 摘要前綴「[沖銷 原單日期 的單]」→ 交出去的月報不變、本月多一筆反向。
  // 沖銷單自己會落進關帳期間(指定的沖銷日期太早)→ 409。
  const closedThrough = await loadClosedThrough(client, bookId);
  const dates = reverseDatesFor(o, closedThrough, { dateOverride, mode: 'ui' });
  const summary = (dates.closedOriginal
    ? `${dates.summaryPrefix} ${o.summary || ''}`
    : `[沖銷] ${o.summary || ''}`).trim().slice(0, SUMMARY_MAX);
  const reversal = await reverseJournalRow(client, bookId, o, {
    date: dates.date,
    originalDate: dates.originalDate,
    summary,
    note: reason,
    userId,
    isAuto: false,
  });

  await client.query(
    `INSERT INTO reverse_audit_log (original_journal_id, reverse_journal_id, reversed_by_user_id, reason)
     VALUES ($1, $2, $3, $4)`,
    [o.id, reversal.id, userId, reason]
  );

  const after = await client.query(`SELECT * FROM journal_logs WHERE id = $1`, [o.id]);
  return { reversal, original: after.rows[0] };
}

function readReverseInput(req, defaultReason) {
  const b = req.body || {};
  const rawReason = b.reason !== undefined && b.reason !== null ? String(b.reason).trim() : '';
  const reason = (rawReason || defaultReason || '').slice(0, 500);
  let date = null;
  if (b.date !== undefined && b.date !== null && b.date !== '') {
    if (!isRealDate(String(b.date))) return { error: '沖銷日期不正確' };
    date = String(b.date);
  }
  if (!reason) return { error: '請寫沖銷原因' };
  return { reason, date };
}

function sendReverseResult(res, r) {
  res.json({
    ok: true,
    reversal: r.reversal,
    original: r.original,
    // 舊欄位(舊頁面相容)
    original_id: r.original.id,
    reverse_id: r.reversal.id,
    reverse_journal: r.reversal,
  });
}

router.delete(
  '/B/:bookCode/journals/:id',
  loadBook,
  requireReverseRole,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: '記錄編號不正確' });
    const input = readReverseInput(req, LEGACY_DELETE_REASON);
    if (input.error) return res.status(400).json({ error: input.error });
    const r = await withTransaction((client) =>
      reverseById(client, req.book.id, id, req.user.id, input.reason, input.date));
    sendReverseResult(res, r);
  })
);

router.post(
  '/B/:bookCode/journals/:id/reverse',
  loadBook,
  requireReverseRole,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: '記錄編號不正確' });
    const input = readReverseInput(req, null);
    if (input.error) return res.status(400).json({ error: input.error });
    const r = await withTransaction((client) =>
      reverseById(client, req.book.id, id, req.user.id, input.reason, input.date));
    sendReverseResult(res, r);
  })
);

// ============================================================================
// GET /B/:bookCode/journals/:id/legs  (D14)
// ============================================================================
router.get('/B/:bookCode/journals/:id/legs', loadBook, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: '記錄編號不正確' });
  const jr = await query(
    `SELECT id, is_composite, type, date FROM journal_logs WHERE id = $1 AND book_id = $2`,
    [id, req.book.id]
  );
  if (jr.rows.length === 0) return res.status(404).json({ error: '找不到這筆記錄' });

  const legsRes = await query(
    `SELECT l.*, s.code AS subject_code, s.name AS subject_name, a.name AS account_name
       FROM journal_legs l
       LEFT JOIN subjects s ON s.id = l.subject_id
       LEFT JOIN ag_accounts a ON a.id = l.account_id
      WHERE l.journal_log_id = $1
      ORDER BY l.leg_no`,
    [id]
  );
  res.json({ journal_id: id, is_composite: jr.rows[0].is_composite, legs: legsRes.rows });
}));

// ============================================================================
// GET /B/:bookCode/journals/:id/history  (B5)
// ============================================================================
router.get('/B/:bookCode/journals/:id/history', loadBook, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: '記錄編號不正確' });

  const jr = await query(
    `SELECT j.*, cu.name AS created_by_name
       FROM journal_logs j
       LEFT JOIN users cu ON cu.id = j.created_by
      WHERE j.id = $1 AND j.book_id = $2`,
    [id, req.book.id]
  );
  if (jr.rows.length === 0) return res.status(404).json({ error: '找不到這筆記錄' });
  const j = jr.rows[0];

  const events = [];
  events.push({
    type: 'created',
    at: j.created_at,
    actor: j.created_by_name || (j.created_by === 0 ? 'System Bot' : 'unknown'),
    via: j.external_source || 'manual',
    triggered_by_emp_id: j.triggered_by_external_emp_id || null,
    webhook_log_id: j.webhook_log_id || null,
  });

  // pending approval audit
  const pj = await query(
    `SELECT pj.status, pj.approved_at, pj.rejected_at, pj.rejected_reason,
            au.name AS approved_by_name, ru.name AS rejected_by_name
       FROM pending_journals pj
       LEFT JOIN users au ON au.id = pj.approved_by_user_id
       LEFT JOIN users ru ON ru.id = pj.rejected_by_user_id
      WHERE pj.resulting_journal_id = $1
      LIMIT 1`,
    [id]
  );
  if (pj.rows.length > 0) {
    const p = pj.rows[0];
    if (p.approved_at) events.push({ type: 'approved', at: p.approved_at, actor: p.approved_by_name });
    if (p.rejected_at) events.push({ type: 'rejected', at: p.rejected_at, actor: p.rejected_by_name, reason: p.rejected_reason });
  }

  // reversed events
  if (j.reversed_by_id) {
    const rev = await query(
      `SELECT r.id, r.created_at, ra.reason, ru.name AS reversed_by_name
         FROM journal_logs r
         LEFT JOIN reverse_audit_log ra ON ra.reverse_journal_id = r.id
         LEFT JOIN users ru ON ru.id = ra.reversed_by_user_id
        WHERE r.id = $1`,
      [j.reversed_by_id]
    );
    if (rev.rows.length > 0) {
      events.push({
        type: 'reversed',
        at: rev.rows[0].created_at,
        actor: rev.rows[0].reversed_by_name,
        reason: rev.rows[0].reason,
        reverse_id: rev.rows[0].id,
      });
    }
  }

  // 若本筆就是 reverse，記回顯
  if (j.reverses_id) {
    const ra = await query(
      `SELECT reason, ru.name AS reversed_by_name
         FROM reverse_audit_log
         LEFT JOIN users ru ON ru.id = reversed_by_user_id
        WHERE reverse_journal_id = $1`,
      [j.id]
    );
    if (ra.rows.length > 0) {
      events.push({
        type: 'is_reverse_of',
        original_id: j.reverses_id,
        reason: ra.rows[0].reason,
        actor: ra.rows[0].reversed_by_name,
        at: j.created_at,
      });
    }
  }

  events.sort((a, b) => new Date(a.at) - new Date(b.at));
  res.json({
    journal_id: j.id,
    journal: {
      date: j.date,
      original_date: j.original_date,
      type: j.type,
      is_composite: j.is_composite,
      amount: j.amount,
      summary: j.summary,
      external_source: j.external_source,
      external_id: j.external_id,
      reverses_id: j.reverses_id,
      reversed_by_id: j.reversed_by_id,
    },
    events,
  });
}));

module.exports = router;
// 小測試用(冪等佔位 / 競態)
module.exports._internals = { runIdempotent, idemReadId, idemBodyHash, idemMap, IDEM_MAX, IDEM_TTL_MS };

// 統一錯誤導向 (status 從 error.status 拿)
router.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
});
