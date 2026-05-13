// src/routes/journals.js
// 記帳記錄 CRUD.
// 規格書 §3.2.7. 支援 4 種 type: expense / income / transfer / reclassify.
// M1 階段 1a (v0.3): POST/GET/GET-by-id.
// M1 階段 1c (v0.7): DELETE = reverse (soft delete via 反向 journal).
// M1 階段 1d (v0.9, 2026-05-13): reclassify 1:N targets + PATCH /journals/:id.

'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
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
  req.bookMember = { role: result.rows[0].role };
  next();
}

function requireBookRole(...roles) {
  return (req, res, next) => {
    if (!req.bookMember || !roles.includes(req.bookMember.role)) {
      return res.status(403).json({ error: `forbidden, requires role: ${roles.join(' or ')}` });
    }
    next();
  };
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
    if (!b.subject_id) throw Object.assign(new Error('subject_id required'), { status: 400 });
    if (!(Number(b.amount) > 0)) throw Object.assign(new Error('amount must be > 0'), { status: 400 });
    return {
      primarySubjectId: Number(b.subject_id),
      totalAmount: Number(b.amount),
      normalizedTargets: [],  // empty = legacy single
    };
  }
  if (targets.length === 0) {
    throw Object.assign(new Error('targets array cannot be empty'), { status: 400 });
  }
  // Validate each
  const norm = [];
  let total = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (!t || !t.subject_id) throw Object.assign(new Error(`targets[${i}].subject_id required`), { status: 400 });
    const amt = Number(t.amount);
    if (!(amt > 0)) throw Object.assign(new Error(`targets[${i}].amount must be > 0`), { status: 400 });
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
      throw Object.assign(new Error(`target subject_id ${t.target_subject_id} duplicated`), { status: 400 });
    }
    seen.add(t.target_subject_id);
  }
  // If body.amount is also given, must match SUM (allow 2-cent floating tolerance)
  if (b.amount !== undefined && b.amount !== null) {
    const declared = Number(b.amount);
    if (Math.abs(declared - total) > 0.02) {
      throw Object.assign(new Error(`amount mismatch: declared ${declared}, sum of targets ${total}`), { status: 400 });
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
      throw Object.assign(new Error('one or more subject_id not in this book'), { status: 400 });
    }
  }
  if (accountIds.length) {
    const uniqAccounts = [...new Set(accountIds.map(Number))];
    const r = await client.query(
      `SELECT COUNT(DISTINCT id)::int AS c FROM ag_accounts WHERE id = ANY($1::bigint[]) AND book_id = $2`,
      [uniqAccounts, bookId]
    );
    if (r.rows[0].c !== uniqAccounts.length) {
      throw Object.assign(new Error('one or more account_id not in this book'), { status: 400 });
    }
  }
  if (counterpartyId) {
    const r = await client.query(
      `SELECT 1 FROM counterparties WHERE id = $1 AND book_id = $2`,
      [counterpartyId, bookId]
    );
    if (r.rows.length === 0) {
      throw Object.assign(new Error('counterparty_id not in this book'), { status: 400 });
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

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    }
    if (!['expense', 'income', 'transfer', 'reclassify'].includes(type)) {
      return res.status(400).json({ error: 'type must be expense / income / transfer / reclassify' });
    }

    // ── Resolve (subject_id, amount, targets) by type ──────────────
    let subjectId, amount, normalizedTargets = [];
    if (type === 'reclassify') {
      const r = normalizeReclassifyTargets(b, req.book.id);
      subjectId = r.primarySubjectId;
      amount = r.totalAmount;
      normalizedTargets = r.normalizedTargets;
      if (!reclassifyFromSubjectId) {
        return res.status(400).json({ error: 'reclassify_from_subject_id required for reclassify' });
      }
      if (outAccountId || inAccountId) {
        return res.status(400).json({ error: 'transfer accounts must be null for reclassify' });
      }
      // Check from != any target
      const allTargets = normalizedTargets.length > 0
        ? normalizedTargets.map((t) => t.target_subject_id)
        : [subjectId];
      if (allTargets.includes(Number(reclassifyFromSubjectId))) {
        return res.status(400).json({ error: 'reclassify_from_subject_id must differ from every target subject_id' });
      }
    } else {
      subjectId = Number(b.subject_id);
      amount = Number(b.amount);
      if (!subjectId) return res.status(400).json({ error: 'subject_id required' });
      if (!(amount > 0)) return res.status(400).json({ error: 'amount must be > 0' });
      if (type === 'expense') {
        if (!outAccountId) return res.status(400).json({ error: 'transfer_out_account_id required for expense' });
        if (inAccountId) return res.status(400).json({ error: 'transfer_in_account_id must be null for expense' });
        if (reclassifyFromSubjectId) return res.status(400).json({ error: 'reclassify_from_subject_id must be null for expense' });
      } else if (type === 'income') {
        if (!inAccountId) return res.status(400).json({ error: 'transfer_in_account_id required for income' });
        if (outAccountId) return res.status(400).json({ error: 'transfer_out_account_id must be null for income' });
        if (reclassifyFromSubjectId) return res.status(400).json({ error: 'reclassify_from_subject_id must be null for income' });
      } else if (type === 'transfer') {
        if (!outAccountId || !inAccountId) return res.status(400).json({ error: 'transfer_out_account_id and transfer_in_account_id both required for transfer' });
        if (outAccountId === inAccountId) return res.status(400).json({ error: 'transfer accounts must differ' });
        if (reclassifyFromSubjectId) return res.status(400).json({ error: 'reclassify_from_subject_id must be null for transfer' });
      }
    }

    const result = await withTransaction(async (client) => {
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
    });

    res.status(201).json({ journal: result });
  })
);

// ── GET /B/:bookCode/journals?from=&to=&type=&subject_id=&counterparty_id=&account_id=&limit= ──
router.get('/B/:bookCode/journals', loadBook, asyncHandler(async (req, res) => {
  const { from, to, type, subject_id, counterparty_id, account_id } = req.query;
  const where = ['j.book_id = $1'];
  const params = [req.book.id];

  if (from) { where.push(`j.date >= $${params.length + 1}`); params.push(from); }
  if (to) { where.push(`j.date <= $${params.length + 1}`); params.push(to); }
  if (type) {
    if (!['expense', 'income', 'transfer', 'reclassify'].includes(type)) {
      return res.status(400).json({ error: 'invalid type filter' });
    }
    where.push(`j.type = $${params.length + 1}`);
    params.push(type);
  }
  if (subject_id) {
    // 1:N: subject_id 篩選也要查 reclassify_targets
    where.push(`(
      j.subject_id = $${params.length + 1}
      OR j.reclassify_from_subject_id = $${params.length + 1}
      OR EXISTS (SELECT 1 FROM journal_reclassify_targets jrt
                  WHERE jrt.journal_id = j.id AND jrt.target_subject_id = $${params.length + 1})
    )`);
    params.push(Number(subject_id));
  }
  if (counterparty_id) {
    where.push(`j.counterparty_id = $${params.length + 1}`);
    params.push(Number(counterparty_id));
  }
  if (account_id) {
    where.push(`(j.transfer_out_account_id = $${params.length + 1} OR j.transfer_in_account_id = $${params.length + 1})`);
    params.push(Number(account_id));
  }

  const lim = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);

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
    return res.status(400).json({ error: 'invalid id' });
  }
  const result = await query(
    `${SELECT_JOURNAL_WITH_JOINS}
      WHERE j.book_id = $1 AND j.id = $2`,
    [req.book.id, id]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'journal not found' });
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
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const b = req.body || {};

    if (b.type !== undefined) {
      return res.status(400).json({ error: 'cannot change type — use reverse + create new instead' });
    }

    const result = await withTransaction(async (client) => {
      const origRes = await client.query(
        `SELECT * FROM journal_logs WHERE id = $1 AND book_id = $2 FOR UPDATE`,
        [id, req.book.id]
      );
      if (origRes.rows.length === 0) {
        throw Object.assign(new Error('journal not found'), { status: 404 });
      }
      const o = origRes.rows[0];
      if (o.reversed_by_id) {
        throw Object.assign(new Error(`journal #${o.id} already reversed by #${o.reversed_by_id}, cannot edit`), { status: 409 });
      }
      if (o.reverses_id) {
        throw Object.assign(new Error(`journal #${o.id} is itself a reverse, cannot edit`), { status: 400 });
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
          throw Object.assign(new Error('invalid date format'), { status: 400 });
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
          throw Object.assign(new Error('reclassify_from_subject_id required for reclassify'), { status: 400 });
        }
        // from != any target
        const allTargets = newTargets && newTargets.length > 0
          ? newTargets.map((t) => t.target_subject_id)
          : [newSubjectId];
        if (allTargets.includes(Number(newReclassifyFromSubjectId))) {
          throw Object.assign(new Error('reclassify_from_subject_id must differ from every target'), { status: 400 });
        }
      } else {
        if (b.subject_id !== undefined) newSubjectId = Number(b.subject_id);
        if (b.amount !== undefined) {
          const a = Number(b.amount);
          if (!(a > 0)) throw Object.assign(new Error('amount must be > 0'), { status: 400 });
          newAmount = a;
        }
        if (type === 'expense' || type === 'transfer') {
          if (b.transfer_out_account_id !== undefined) newOutAcc = b.transfer_out_account_id || null;
          if (!newOutAcc) throw Object.assign(new Error('transfer_out_account_id required'), { status: 400 });
        }
        if (type === 'income' || type === 'transfer') {
          if (b.transfer_in_account_id !== undefined) newInAcc = b.transfer_in_account_id || null;
          if (!newInAcc) throw Object.assign(new Error('transfer_in_account_id required'), { status: 400 });
        }
        if (type === 'transfer' && newOutAcc && newInAcc && newOutAcc === newInAcc) {
          throw Object.assign(new Error('transfer accounts must differ'), { status: 400 });
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

// ── DELETE /B/:bookCode/journals/:id ───────────────────────────────────
// Soft delete via reverse: not a hard DELETE on the row. Instead create a
// new journal_log with opposite direction (type swapped, accounts swapped,
// reclassify subjects swapped) and link via reverses_id / reversed_by_id.
// Account balances are auto-rolled-back. Original row stays for audit.
//
// 1:N reclassify reverse: child targets 翻過去成 reverse journal 的 1:1 form,
// 但因為 reverse 是「1 origin → N targets」翻成「N origins → 1 target」,
// 結構不對稱. 簡化處理: reverse journal 走 1:1 (用 primary),
// 並把所有 child targets 合計成 1 個 reverse amount 用 primary 即可.
//   → 原 reclassify 多 target 的 reverse,雖然是 1:1 形式但金額 = 原 total,
//      reclassify_from = 原 primary target,subject_id = 原 from.
//      語意上「全部沖回到原 from 科目」.
router.delete(
  '/B/:bookCode/journals/:id',
  loadBook,
  requireBookRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });

    const result = await withTransaction(async (client) => {
      const origRes = await client.query(
        `SELECT * FROM journal_logs WHERE id = $1 AND book_id = $2 FOR UPDATE`,
        [id, req.book.id]
      );
      if (origRes.rows.length === 0) {
        throw Object.assign(new Error('journal not found'), { status: 404 });
      }
      const o = origRes.rows[0];
      if (o.reversed_by_id) {
        throw Object.assign(
          new Error(`journal #${o.id} already reversed by #${o.reversed_by_id}`),
          { status: 409 }
        );
      }
      if (o.reverses_id) {
        throw Object.assign(
          new Error(`journal #${o.id} is itself a reverse of #${o.reverses_id}, cannot re-reverse`),
          { status: 400 }
        );
      }

      let reverseType, outAcc, inAcc, fromSubject, newSubjectId;
      if (o.type === 'expense') {
        reverseType = 'income';
        outAcc = null;
        inAcc = o.transfer_out_account_id;
        fromSubject = null;
        newSubjectId = o.subject_id;
      } else if (o.type === 'income') {
        reverseType = 'expense';
        outAcc = o.transfer_in_account_id;
        inAcc = null;
        fromSubject = null;
        newSubjectId = o.subject_id;
      } else if (o.type === 'transfer') {
        reverseType = 'transfer';
        outAcc = o.transfer_in_account_id;
        inAcc = o.transfer_out_account_id;
        fromSubject = null;
        newSubjectId = o.subject_id;
      } else if (o.type === 'reclassify') {
        // 1:N reverse 簡化: 全部沖回 origin. Reverse journal 是 1:1 form.
        reverseType = 'reclassify';
        outAcc = null;
        inAcc = null;
        fromSubject = o.subject_id;            // origin = 原 primary target
        newSubjectId = o.reclassify_from_subject_id;  // target = 原 from
      }

      const ins = await client.query(
        `INSERT INTO journal_logs (
           book_id, date, type, amount,
           subject_id, reclassify_from_subject_id,
           transfer_out_account_id, transfer_in_account_id,
           counterparty_id, summary, note,
           reverses_id, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
         RETURNING *`,
        [
          req.book.id, req.body.date || o.date, reverseType, o.amount,
          newSubjectId, fromSubject,
          outAcc, inAcc,
          o.counterparty_id, req.body.summary || `Reverse of #${o.id}`, req.body.note || null,
          o.id, req.user.id,
        ]
      );
      const reverse = ins.rows[0];

      await applyBalanceDelta(
        client, req.book.id, reverseType,
        outAcc, inAcc, Number(o.amount), 'apply'
      );

      await client.query(
        `UPDATE journal_logs SET reversed_by_id = $1, updated_at = NOW() WHERE id = $2`,
        [reverse.id, o.id]
      );

      return { original_id: o.id, reverse_journal: reverse };
    });

    res.json({ ok: true, ...result });
  })
);

// ============================================================================
// POST /B/:bookCode/journals/:id/reverse  (D14 / N1 / P2 / Q11)
// 新 canonical reverse endpoint — 強制 reason，寫 reverse_audit_log，支援 composite
// ============================================================================
router.post(
  '/B/:bookCode/journals/:id/reverse',
  loadBook,
  requireBookRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const reason = (req.body && req.body.reason && String(req.body.reason).trim()) || null;
    if (!reason) return res.status(400).json({ error: 'reason required' });

    const result = await withTransaction(async (client) => {
      // Q11: SELECT FOR UPDATE 鎖
      const origRes = await client.query(
        `SELECT * FROM journal_logs WHERE id = $1 AND book_id = $2 FOR UPDATE`,
        [id, req.book.id]
      );
      if (origRes.rows.length === 0) {
        throw Object.assign(new Error('journal not found'), { status: 404 });
      }
      const o = origRes.rows[0];

      // Q15 cascade 防護
      if (o.reverses_id) {
        throw Object.assign(
          new Error(`journal #${o.id} is itself a reverse, cannot re-reverse`),
          { status: 409 }
        );
      }
      const dupCheck = await client.query(
        `SELECT id FROM journal_logs WHERE reverses_id = $1 LIMIT 1`,
        [o.id]
      );
      if (dupCheck.rows.length > 0) {
        throw Object.assign(
          new Error(`journal #${o.id} already reversed by #${dupCheck.rows[0].id}`),
          { status: 409 }
        );
      }

      const todayDate = new Date().toISOString().slice(0, 10);
      let reverseId;

      if (o.is_composite) {
        // 1A — Composite Reverse: 複製 legs 取負
        const legsRes = await client.query(
          `SELECT * FROM journal_legs WHERE journal_log_id = $1 ORDER BY leg_no`,
          [o.id]
        );
        const legs = legsRes.rows;

        // 算 reverse header amount = sum(positive account legs after negation = sum(negative account legs of original))
        // 簡化：直接 negate 原 amount
        const ins = await client.query(
          `INSERT INTO journal_logs (
             book_id, date, type, amount,
             subject_id,
             summary, note,
             reverses_id, original_date,
             is_composite,
             created_by, updated_by
           ) VALUES ($1, $2, 'composite', $3, $4, $5, $6, $7, $8, TRUE, $9, $9)
           RETURNING *`,
          [
            req.book.id, todayDate, Number(o.amount), o.subject_id,
            `Reverse of #${o.id}`, reason,
            o.id, o.date, req.user.id,
          ]
        );
        const reverse = ins.rows[0];
        reverseId = reverse.id;

        // 複製 legs 取負，並回滾 ag_accounts
        for (const leg of legs) {
          const negAmt = -Number(leg.amount);
          await client.query(
            `INSERT INTO journal_legs (journal_log_id, leg_no, kind, subject_id, account_id, amount, note)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [reverse.id, leg.leg_no, leg.kind, leg.subject_id, leg.account_id, negAmt, leg.note]
          );
          if (leg.kind === 'account') {
            await client.query(
              `UPDATE ag_accounts SET current_balance = current_balance + $1, updated_at = NOW()
                WHERE id = $2 AND book_id = $3`,
              [negAmt, leg.account_id, req.book.id]
            );
          }
        }
      } else {
        // 1B — Legacy Reverse: 走既有 M1 1c swap 邏輯
        let reverseType, outAcc, inAcc, fromSubject, newSubjectId;
        if (o.type === 'expense') {
          reverseType = 'income';
          outAcc = null; inAcc = o.transfer_out_account_id;
          fromSubject = null; newSubjectId = o.subject_id;
        } else if (o.type === 'income') {
          reverseType = 'expense';
          outAcc = o.transfer_in_account_id; inAcc = null;
          fromSubject = null; newSubjectId = o.subject_id;
        } else if (o.type === 'transfer') {
          reverseType = 'transfer';
          outAcc = o.transfer_in_account_id; inAcc = o.transfer_out_account_id;
          fromSubject = null; newSubjectId = o.subject_id;
        } else if (o.type === 'reclassify') {
          reverseType = 'reclassify';
          outAcc = null; inAcc = null;
          fromSubject = o.subject_id;
          newSubjectId = o.reclassify_from_subject_id;
        } else {
          throw Object.assign(new Error(`unsupported type for reverse: ${o.type}`), { status: 400 });
        }

        const ins = await client.query(
          `INSERT INTO journal_logs (
             book_id, date, type, amount,
             subject_id, reclassify_from_subject_id,
             transfer_out_account_id, transfer_in_account_id,
             counterparty_id, summary, note,
             reverses_id, original_date,
             created_by, updated_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
           RETURNING *`,
          [
            req.book.id, todayDate, reverseType, o.amount,
            newSubjectId, fromSubject,
            outAcc, inAcc,
            o.counterparty_id, `Reverse of #${o.id}`, reason,
            o.id, o.date, req.user.id,
          ]
        );
        const reverse = ins.rows[0];
        reverseId = reverse.id;

        await applyBalanceDelta(
          client, req.book.id, reverseType,
          outAcc, inAcc, Number(o.amount), 'apply'
        );
      }

      // 雙向標記
      await client.query(
        `UPDATE journal_logs SET reversed_by_id = $1, updated_at = NOW() WHERE id = $2`,
        [reverseId, o.id]
      );

      // 寫 reverse_audit_log
      await client.query(
        `INSERT INTO reverse_audit_log (original_journal_id, reverse_journal_id, reversed_by_user_id, reason)
         VALUES ($1, $2, $3, $4)`,
        [o.id, reverseId, req.user.id, reason]
      );

      return { original_id: o.id, reverse_id: reverseId };
    });

    res.json({ ok: true, ...result });
  })
);

// ============================================================================
// GET /B/:bookCode/journals/:id/legs  (D14)
// ============================================================================
router.get('/B/:bookCode/journals/:id/legs', loadBook, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  const jr = await query(
    `SELECT id, is_composite, type, date FROM journal_logs WHERE id = $1 AND book_id = $2`,
    [id, req.book.id]
  );
  if (jr.rows.length === 0) return res.status(404).json({ error: 'journal not found' });

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
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });

  const jr = await query(
    `SELECT j.*, cu.name AS created_by_name
       FROM journal_logs j
       LEFT JOIN users cu ON cu.id = j.created_by
      WHERE j.id = $1 AND j.book_id = $2`,
    [id, req.book.id]
  );
  if (jr.rows.length === 0) return res.status(404).json({ error: 'journal not found' });
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

// 統一錯誤導向 (status 從 error.status 拿)
router.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
});
