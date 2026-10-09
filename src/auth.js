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

/**
 * Middleware: 從 Authorization: Bearer <token> 解出 user, 失敗回 401.
 * 設好 req.user = { id, email }.
 */
// ── 收回權限要馬上生效(2026-10-09 全專案重掃 B4)──────────────────────────────
// 以前 token 7 天有效、只在登入時看 HR 的記帳雲權限:老闆把某人改成「無」或那人離職,
// 手上的 token 7 天內照樣能看帳 / 改帳(book_members 的角色還在)。
// 現在每個請求比一次 HR 名單(公開的 /api/auth/employees-roster,只列在職的人 + cloud_access;60 秒快取):
// 不在名單或權限是 none → 401(只擋、不刪成員資格:HR 那邊權限開回來就馬上能用,各帳本的角色都還在)。
// HR 連不上就照舊放行(不讓 HR 停機連帶記帳雲整個不能用)。舊的 email 帳號(沒有 hr_emp_id)不受影響。
const HR_BASE_URL = process.env.HR_BASE_URL || 'http://10.0.1.168:3000';
const ROSTER_CACHE_MS = 60 * 1000;
let rosterCache = { at: 0, map: null };
let rosterDownUntil = 0;              // HR 連不上之後 30 秒內不再試(不然每個請求都多等 3 秒)
let rosterInflight = null;            // 同一時間只打一次
const ROSTER_DOWN_MS = 30 * 1000;
const warnedAt = new Map();           // userId → 上次寫 log 的時間(同一人 10 分鐘只記一次,不洗版)
const empOfUser = new Map();   // userId → { at, emp }

async function hrRoster() {
  if (rosterCache.map && Date.now() - rosterCache.at < ROSTER_CACHE_MS) return rosterCache.map;
  if (Date.now() < rosterDownUntil) return null;
  if (rosterInflight) return rosterInflight;
  rosterInflight = fetchRoster().then((m) => { if (!m) rosterDownUntil = Date.now() + ROSTER_DOWN_MS; return m; })
    .finally(() => { rosterInflight = null; });
  return rosterInflight;
}

async function fetchRoster() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(`${HR_BASE_URL}/api/auth/employees-roster`, { signal: ctrl.signal });
    if (!r.ok) return null;
    const rows = await r.json();
    // 空名單 = HR 那邊不正常(剛開機 / 資料庫沒接上)→ 當成連不上,不可以拿來把所有人踢掉、刪成員資格
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const map = new Map(rows.map((e) => [String(e.emp_id), e.cloud_access || 'none']));
    rosterCache = { at: Date.now(), map };
    return map;
  } catch (_) { return null; } finally { clearTimeout(t); }
}

async function revokedReason(userId) {
  const { query } = require('./db');
  let hit = empOfUser.get(userId);
  if (!hit || Date.now() - hit.at > ROSTER_CACHE_MS) {
    const r = await query('SELECT hr_emp_id FROM users WHERE id = $1', [userId]);
    hit = { at: Date.now(), emp: r.rows[0] ? r.rows[0].hr_emp_id : null };
    empOfUser.set(userId, hit);
  }
  if (!hit.emp) return null;                       // 舊 email 帳號
  const roster = await hrRoster();
  if (!roster) return null;                        // HR 連不上 → 不擋
  const access = roster.get(String(hit.emp));
  if (access === undefined) return 'HR 名單沒有這個人(離職或停用)';
  if (access === 'none') return '記帳雲權限已收回';
  return null;
}


function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'missing or invalid Authorization header' });
  }
  let payload;
  try {
    payload = verifyToken(match[1]);
  } catch (e) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
  req.user = { id: payload.userId, email: payload.email };
  revokedReason(payload.userId).then(async (why) => {
    if (!why) return next();
    const last = warnedAt.get(payload.userId) || 0;
    if (Date.now() - last > 10 * 60 * 1000) { warnedAt.set(payload.userId, Date.now()); console.warn(`[auth] user ${payload.userId} 擋下:${why}`); }
    res.status(401).json({ error: `${why}，請重新登入或找老闆開通` });
  }).catch((e) => {
    console.warn('[auth] 查 HR 權限失敗,照舊放行:', e.message);
    next();
  });
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  requireAuth,
};
