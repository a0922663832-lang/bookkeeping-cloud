// src/auth.js
// 認證 helper + middleware. bcrypt 密碼 + JWT token + requireAuth.

'use strict';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me_64chars_minimum_aaaaaaaaaaaaaaaaaaaaaaa';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const BCRYPT_ROUNDS = 10;

if (process.env.NODE_ENV === 'production' && JWT_SECRET.includes('change_me')) {
  console.error('[auth] FATAL: JWT_SECRET is default value in production mode!');
  process.exit(1);
}

async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 6) {
    throw new Error('password too short (min 6 chars)');
  }
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  if (typeof plain !== 'string' || typeof hash !== 'string') return false;
  return bcrypt.compare(plain, hash);
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// ── 權限跟著 HR 走(2026-10-09 B4 → 2026-10-10 記帳雲重掃 R5 / Y15 / Y16、LEO 拍板 4)────────
// 每個請求比一次 HR 名單(公開的 /api/auth/employees-roster,只列在職的人 + cloud_access + ver;60 秒快取):
//   · 不在名單 / 權限 none → 401,並刪掉這個人在 NEST0001、NEST0099 的成員資格
//     (以前只擋不刪:曾是 owner 的人先改「無」再開回「viewer」,不用重新登入就直接回到 owner —— R5 情境 2)。
//     HR 開回來之後,下一個請求(或重新登入)照 HR「現在」的權限重建成員資格,不會回到舊角色。
//   · 權限跟帳本角色不同 → 當場改 book_members(降級立即生效,不用等重新登入;R5 情境 1)。
//     NEST0099(測試帳本)鏡射 NEST0001:owner / admin / editor 同角色,viewer 不進(migration 015 的作法)。
//   · 名單有 ver(HR 的密碼版本,改 PIN 會 +1)且 token 有 ver,兩個不同 → 401「密碼已更改,請重新登入」(Y15)。
//     名單沒有 ver 欄(主 repo 還沒部署)或舊 token 沒帶 ver → 不比對,不會誤踢人。
//   · HR 連不上(非 200 / 空名單 / 逾時):沿用「最後一份成功名單」,只要它不超過 10 分鐘;
//     超過 10 分鐘 → 401「人資系統連不上,暫時無法確認權限,請稍後再試」。不再放行(LEO 2026-10-10 拍板 4)。
// 舊的 email 帳號(沒有 hr_emp_id)不受影響。
const HR_BASE_URL = process.env.HR_BASE_URL || 'http://10.0.1.168:3000';
const MAIN_BOOK_CODE = process.env.HR_DEFAULT_BOOK_CODE || 'NEST0001';
const STAGING_BOOK_CODE = 'NEST0099';
const ROSTER_CACHE_MS = 60 * 1000;          // 名單 60 秒內不重抓
const ROSTER_STALE_MAX_MS = 10 * 60 * 1000; // HR 連不上時,最後一份成功名單最多沿用 10 分鐘
const ROSTER_DOWN_MS = 30 * 1000;           // HR 連不上之後 30 秒內不再試(不然每個請求都多等 3 秒)
const SYNC_CACHE_MS = 10 * 60 * 1000;       // 同一人同一個權限,10 分鐘內不重複寫成員資格
const VALID_ROLES = new Set(['owner', 'admin', 'editor', 'viewer']);
const STAGING_ROLES = new Set(['owner', 'admin', 'editor']);

const MSG = {
  missing: '人資名單裡沒有你(可能已離職或停用),請找老闆確認',
  none: '你的記帳雲權限已被收回,請找老闆開通',
  ver: '密碼已更改,請重新登入',
  hrDown: '人資系統連不上,暫時無法確認權限,請稍後再試',
  internal: '系統暫時無法確認權限,請稍後再試',
};

let rosterCache = { at: 0, map: null };     // 最後一份成功名單
let rosterDownUntil = 0;
let rosterInflight = null;                  // 同一時間只打一次
const warnedAt = new Map();                 // userId → 上次寫 log 的時間(同一人 10 分鐘只記一次,不洗版)
const empOfUser = new Map();                // userId → { at, emp }
const syncedAccess = new Map();             // userId → { at, access } 上次同步成員資格時的 HR 權限

// ── 純邏輯(不碰網路 / 資料庫,測試直接呼叫)────────────────────────────

/** HR 的記帳雲權限 → 帳本角色;none / 不認得 → null */
function roleForCloudAccess(access) {
  return VALID_ROLES.has(access) ? access : null;
}

/** 這個權限在主帳本 / 測試帳本該是什麼角色(null = 不該是成員) */
function desiredMemberships(access) {
  const role = roleForCloudAccess(access);
  return {
    [MAIN_BOOK_CODE]: role,
    [STAGING_BOOK_CODE]: role && STAGING_ROLES.has(role) ? role : null,
  };
}

/** 名單新鮮度:'fresh'(≤60 秒,不用重抓)/ 'stale_ok'(HR 連不上時還能沿用)/ 'expired'(不能用) */
function rosterState(at, now) {
  if (!at) return 'expired';
  const age = now - at;
  if (age < ROSTER_CACHE_MS) return 'fresh';
  if (age <= ROSTER_STALE_MAX_MS) return 'stale_ok';
  return 'expired';
}

/** HR 名單 JSON → Map(emp_id → { access, ver });空 / 格式錯 → null(當成連不上) */
function parseRoster(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const map = new Map();
  for (const e of rows) {
    if (!e || e.emp_id == null) continue;
    const hasVer = Object.prototype.hasOwnProperty.call(e, 'ver') && e.ver !== null && e.ver !== '' && Number.isFinite(Number(e.ver));
    map.set(String(e.emp_id), { access: e.cloud_access || 'none', ver: hasVer ? Number(e.ver) : undefined });
  }
  return map.size ? map : null;
}

/**
 * 比對名單裡這個人與 token。
 * 回 { ok: true, access } 或 { ok: false, code, message, drop }(drop = 要不要刪成員資格)
 */
function judge(entry, tokenVer) {
  if (entry === undefined) return { ok: false, code: 'not_in_roster', message: MSG.missing, drop: true };
  if (!roleForCloudAccess(entry.access)) return { ok: false, code: 'access_revoked', message: MSG.none, drop: true };
  if (entry.ver !== undefined && tokenVer !== undefined && tokenVer !== null && Number(tokenVer) !== entry.ver) {
    return { ok: false, code: 'pin_changed', message: MSG.ver, drop: false };
  }
  return { ok: true, access: entry.access };
}

/** 從 HR 登入回應拿密碼版本:回應本身有 ver 就用;沒有就讀 HR 憑證前半段(雲端自己向 HR 拿的,不用驗章) */
function hrVerFromLogin(hrData) {
  if (!hrData) return undefined;
  if (hrData.ver !== undefined && hrData.ver !== null && Number.isFinite(Number(hrData.ver))) return Number(hrData.ver);
  if (typeof hrData.token !== 'string') return undefined;
  try {
    const body = hrData.token.split('.')[0];
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (p && p.ver !== undefined && p.ver !== null && Number.isFinite(Number(p.ver))) return Number(p.ver);
  } catch (_) { /* 看不懂 → 當沒有,不比對 */ }
  return undefined;
}

// ── 名單抓取 ───────────────────────────────────────────────────────

async function hrRoster() {
  const now = Date.now();
  if (rosterCache.map && rosterState(rosterCache.at, now) === 'fresh') return rosterCache.map;
  if (now >= rosterDownUntil) {
    if (!rosterInflight) {
      rosterInflight = fetchRoster()
        .then((m) => { if (!m) rosterDownUntil = Date.now() + ROSTER_DOWN_MS; return m; })
        .finally(() => { rosterInflight = null; });
    }
    const m = await rosterInflight;
    if (m) return m;
  }
  // HR 連不上 → 沿用最後一份成功名單(不超過 10 分鐘);超過就回 null(呼叫端擋下)
  if (rosterCache.map && rosterState(rosterCache.at, Date.now()) !== 'expired') return rosterCache.map;
  return null;
}

async function fetchRoster() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(`${HR_BASE_URL}/api/auth/employees-roster`, { signal: ctrl.signal });
    if (!r.ok) return null;
    // 空名單 = HR 那邊不正常(剛開機 / 資料庫沒接上)→ 當成連不上,不可以拿來把所有人踢掉
    const map = parseRoster(await r.json());
    if (!map) return null;
    rosterCache = { at: Date.now(), map };
    return map;
  } catch (_) { return null; } finally { clearTimeout(t); }
}

// ── 成員資格同步 ───────────────────────────────────────────────────

async function syncMemberships(userId, access) {
  const hit = syncedAccess.get(userId);
  if (hit && hit.access === access && Date.now() - hit.at < SYNC_CACHE_MS) return;
  const { query } = require('./db');
  const want = desiredMemberships(access);
  const books = await query(
    `SELECT id, code FROM books WHERE code = ANY($1::text[]) AND is_active = TRUE`,
    [[MAIN_BOOK_CODE, STAGING_BOOK_CODE]]
  );
  for (const b of books.rows) {
    const role = want[b.code] || null;
    if (role) {
      const r = await query(
        `INSERT INTO book_members (book_id, user_id, role, joined_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (book_id, user_id) DO UPDATE SET role = EXCLUDED.role
           WHERE book_members.role IS DISTINCT FROM EXCLUDED.role
         RETURNING role`,
        [b.id, userId, role]
      );
      if (r.rowCount > 0) console.log(`[auth] user ${userId} 在 ${b.code} 的角色跟著 HR 改成 ${role}`);
    } else {
      const r = await query('DELETE FROM book_members WHERE book_id = $1 AND user_id = $2', [b.id, userId]);
      if (r.rowCount > 0) console.log(`[auth] user ${userId} 在 ${b.code} 的成員資格已移除(HR 權限:${access || '不在名單'})`);
    }
  }
  syncedAccess.set(userId, { at: Date.now(), access });
}

/** 回 null = 放行;否則回 { status, code, message } */
async function accessProblem(userId, tokenVer) {
  const { query } = require('./db');
  let hit = empOfUser.get(userId);
  if (!hit || Date.now() - hit.at > ROSTER_CACHE_MS) {
    const r = await query('SELECT hr_emp_id FROM users WHERE id = $1', [userId]);
    hit = { at: Date.now(), emp: r.rows[0] ? r.rows[0].hr_emp_id : null };
    empOfUser.set(userId, hit);
  }
  if (!hit.emp) return null;                       // 舊 email 帳號
  const roster = await hrRoster();
  if (!roster) return { status: 401, code: 'hr_unreachable', message: MSG.hrDown };
  const verdict = judge(roster.get(String(hit.emp)), tokenVer);
  if (verdict.ok) {
    await syncMemberships(userId, verdict.access);
    return null;
  }
  if (verdict.drop) await syncMemberships(userId, 'none');
  return { status: 401, code: verdict.code, message: verdict.message };
}

/** 登入成功後清掉這個人的快取(下一個請求重新比對、重新同步) */
function forgetUser(userId) {
  empOfUser.delete(userId);
  syncedAccess.delete(userId);
  warnedAt.delete(userId);
}

/**
 * Middleware: 從 Authorization: Bearer <token> 解出 user, 失敗回 401.
 * 設好 req.user = { id, email }.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: '請先登入' });
  }
  let payload;
  try {
    payload = verifyToken(match[1]);
  } catch (e) {
    return res.status(401).json({ error: '登入已過期,請重新登入' });
  }
  req.user = { id: payload.userId, email: payload.email };
  accessProblem(payload.userId, payload.hv).then((p) => {
    if (!p) return next();
    const last = warnedAt.get(payload.userId) || 0;
    if (Date.now() - last > 10 * 60 * 1000) { warnedAt.set(payload.userId, Date.now()); console.warn(`[auth] user ${payload.userId} 擋下:${p.code}`); }
    res.status(p.status).json({ error: p.message, code: p.code });
  }).catch((e) => {
    // 拍板 4:確認不了就不放行
    console.warn('[auth] 查 HR 權限失敗,擋下:', e.message);
    res.status(503).json({ error: MSG.internal, code: 'auth_check_failed' });
  });
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  requireAuth,
  roleForCloudAccess,
  hrVerFromLogin,
  forgetUser,
  // 測試用(純邏輯 + 內部狀態)
  _internals: {
    desiredMemberships, rosterState, parseRoster, judge, hrRoster, accessProblem,
    MAIN_BOOK_CODE, STAGING_BOOK_CODE, ROSTER_CACHE_MS, ROSTER_STALE_MAX_MS, ROSTER_DOWN_MS,
    _reset() { rosterCache = { at: 0, map: null }; rosterDownUntil = 0; rosterInflight = null; empOfUser.clear(); syncedAccess.clear(); warnedAt.clear(); },
  },
};
