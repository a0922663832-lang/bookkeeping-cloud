// src/routes/auth.js
// HR SSO 模式 (2026-05-13, plan: drifting-toasting-corbato.md):
//   - POST /auth/login  代打 HR /api/auth/login (port 3000), 不存 PIN
//   - POST /auth/register → 410 Gone (帳號全由 HR 管)
//   - POST /auth/change-password → 410 Gone (改 PIN 回 HR /attendance)
//   - GET  /auth/me 不變
//
// LEGACY_EMAIL_LOGIN=true 時保留 bcrypt email+password 後門 (給 dev / 緊急)

'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { hashPassword, verifyPassword, signToken, requireAuth, roleForCloudAccess, hrVerFromLogin, forgetUser } = require('../auth');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

const HR_BASE_URL = process.env.HR_BASE_URL || 'http://10.0.1.168:3000';
const LEGACY_EMAIL_LOGIN = process.env.LEGACY_EMAIL_LOGIN === 'true';
const DEFAULT_BOOK_CODE = process.env.HR_DEFAULT_BOOK_CODE || 'NEST0001';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_CLOUD_ACCESS = new Set(['none', 'viewer', 'editor', 'admin', 'owner']);

// ─── HR proxy login ─────────────────────────────────────────────────
// device_id(2026-10-10 記帳雲重掃 Y16):HR 鎖「編號 + 裝置」;以前雲端代打不帶裝置代號,
// HR 只看得到雲端這一個來源位址 → 任何人在登入頁對老闆的編號亂打 5 次,老闆 10 分鐘進不了記帳雲。
// 現在把前端 localStorage 產的裝置代號轉給 HR(只收英數 - _,最多 64 字;不合格就不帶,HR 退回看來源位址)。
function cleanDeviceId(v) {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : undefined;
}

async function hrLogin(emp_id, pin, device_id) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const body = { emp_id, pin };
    if (device_id) body.device_id = device_id;
    const r = await fetch(`${HR_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data, retryAfter: r.headers && r.headers.get ? r.headers.get('retry-after') : null };
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      return { status: 504, data: {} };
    }
    return { status: 502, data: {} };
  }
}

/**
 * HR 429 → 等幾秒。HR 文案長這樣「密碼錯太多次，請 N 分鐘後再試…」(lib/hr/loginGuard.js lockedLoginMsg);
 * 有 Retry-After 標頭優先;都看不懂 → 10 分鐘(HR 鎖的長度)。
 */
function retryAfterSec(retryAfterHeader, msg) {
  const h = Number(retryAfterHeader);
  if (Number.isFinite(h) && h > 0) return Math.ceil(h);
  const s = String(msg || '');
  const min = s.match(/(\d+)\s*分鐘/);
  if (min) return Number(min[1]) * 60;
  const sec = s.match(/(\d+)\s*秒/);
  if (sec) return Number(sec[1]);
  return 600;
}

/**
 * Upsert user row keyed by hr_emp_id + sync cloud_access + upsert book_members.
 * Returns the cloud user record { id, name, email, hr_emp_id, cloud_access }.
 */
async function upsertHrUser(hrEmp) {
  return withTransaction(async (client) => {
    // 1. upsert users (手動 update-then-insert，因為 hr_emp_id unique 是 partial index
    //    ON CONFLICT 不認 partial index)
    let user;
    const updRes = await client.query(
      `UPDATE users SET name = $2, hr_role = $3, cloud_access = $4,
                        last_login_at = NOW(), updated_at = NOW()
        WHERE hr_emp_id = $1
        RETURNING id, name, email, hr_emp_id, cloud_access`,
      [hrEmp.emp_id, hrEmp.name || hrEmp.emp_id, hrEmp.role || null, hrEmp.cloud_access]
    );
    if (updRes.rows.length > 0) {
      user = updRes.rows[0];
    } else {
      const insRes = await client.query(
        `INSERT INTO users (hr_emp_id, name, hr_role, cloud_access, last_login_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
         RETURNING id, name, email, hr_emp_id, cloud_access`,
        [hrEmp.emp_id, hrEmp.name || hrEmp.emp_id, hrEmp.role || null, hrEmp.cloud_access]
      );
      user = insRes.rows[0];
    }

    // 2. upsert book_members for default book (if cloud_access not 'none')
    // book_members(book_id, user_id) 是真實 UNIQUE (非 partial)，ON CONFLICT 可用
    if (hrEmp.cloud_access && hrEmp.cloud_access !== 'none') {
      const bookRes = await client.query(
        `SELECT id FROM books WHERE code = $1 AND is_active = TRUE LIMIT 1`,
        [DEFAULT_BOOK_CODE]
      );
      if (bookRes.rows.length > 0) {
        const bookId = bookRes.rows[0].id;
        await client.query(
          `INSERT INTO book_members (book_id, user_id, role, joined_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (book_id, user_id)
           DO UPDATE SET role = EXCLUDED.role`,
          [bookId, user.id, hrEmp.cloud_access]
        );
      }
    }
    return user;
  });
}

/**
 * POST /auth/login
 * 主路徑 (HR SSO): body { emp_id, pin } → 代打 HR → upsert → 簽 cloud JWT
 * 緊急 backdoor (LEGACY_EMAIL_LOGIN=true): body { email, password } → bcrypt 本地驗
 */
router.post('/login', asyncHandler(async (req, res) => {
  const b = req.body || {};

  // ── LEGACY backdoor: email + password (bcrypt) ──
  if (LEGACY_EMAIL_LOGIN && b.email && b.password) {
    const result = await query(
      `SELECT id, email, password_hash, name FROM users WHERE email = $1 AND password_hash IS NOT NULL`,
      [b.email]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'invalid credentials' });
    const ok = await verifyPassword(b.password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    const token = signToken({ userId: user.id, email: user.email });
    return res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, source: 'legacy' },
    });
  }

  // ── 主路徑: HR SSO ──
  const okType = (v) => typeof v === 'string' || typeof v === 'number';
  const emp_id = okType(b.emp_id) ? String(b.emp_id).trim() : '';
  const pin = okType(b.pin) ? String(b.pin) : '';
  if (!emp_id || !pin) {
    return res.status(400).json({ error: '請選擇員工並輸入密碼' });
  }

  const { status, data: hrData, retryAfter } = await hrLogin(emp_id, pin, cleanDeviceId(b.device_id));
  if (status === 502 || status === 504) {
    return res.status(status).json({ error: '人資系統連不上,請稍後再試' });
  }
  if (status === 429) {
    const sec = retryAfterSec(retryAfter, hrData && hrData.error);
    res.set('Retry-After', String(sec));
    return res.status(429).json({
      error: `這個編號嘗試太多次,請 ${Math.max(1, Math.ceil(sec / 60))} 分鐘後再試`,
      retry_after_sec: sec,
    });
  }
  if (status === 401) {
    // HR 的文案已經是白話(「編號或密碼不對」「帳號已停用…」「還沒設密碼…」)
    return res.status(401).json({ error: (hrData && typeof hrData.error === 'string' && hrData.error) || '編號或密碼不對' });
  }
  if (status !== 200 || !hrData || !hrData.emp_id) {
    console.warn(`[auth] HR 登入回應看不懂:HTTP ${status}`);
    return res.status(502).json({ error: '人資系統回應異常,請稍後再試' });
  }

  const cloud_access = hrData.cloud_access || 'none';
  if (!VALID_CLOUD_ACCESS.has(cloud_access) || !roleForCloudAccess(cloud_access)) {
    return res.status(403).json({
      error: '你還沒開通記帳雲權限,請找老闆在人資系統開通',
      emp_id: hrData.emp_id,
    });
  }

  const user = await upsertHrUser({
    emp_id: hrData.emp_id,
    name: hrData.name,
    role: hrData.role,
    cloud_access,
  });
  forgetUser(user.id);   // 下一個請求重新比對 HR 名單、同步各帳本角色(含 NEST0099 鏡射)

  // hv = HR 的密碼版本(改 PIN 會 +1);之後每個請求跟 HR 名單的 ver 比,不同就請他重新登入(Y15)。
  // HR 沒給 → 不放進 token → 不比對。
  const tokenPayload = { userId: user.id, email: user.email };
  const hv = hrVerFromLogin(hrData);
  if (hv !== undefined) tokenPayload.hv = hv;
  const token = signToken(tokenPayload);
  res.json({
    token,
    user: {
      id: user.id,
      hr_emp_id: user.hr_emp_id,
      name: user.name,
      cloud_access,
      source: 'hr_sso',
    },
  });
}));

/**
 * GET /auth/employees-roster
 * 給登入頁 dropdown 用。Proxy HR /api/auth/employees-roster + filter cloud_access != 'none'.
 * 公開 (no auth) — 內網 LAN only.
 */
router.get('/employees-roster', asyncHandler(async (req, res) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(`${HR_BASE_URL}/api/auth/employees-roster`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) {
      return res.status(502).json({ error: '人資系統的員工名單暫時拿不到,請稍後再試' });
    }
    const rows = await r.json();
    if (!Array.isArray(rows)) {
      return res.status(502).json({ error: '人資系統的員工名單暫時拿不到,請稍後再試' });
    }
    // 只回有 cloud_access != 'none' (含 viewer/editor/admin/owner) 的員工(不回 ver:瀏覽器用不到)
    const filtered = rows.filter((e) =>
      e.cloud_access && e.cloud_access !== 'none' && VALID_CLOUD_ACCESS.has(e.cloud_access)
    ).map((e) => ({
      emp_id: e.emp_id,
      name: e.name,
      dept: e.dept || null,
      cloud_access: e.cloud_access,
    }));
    res.json({ employees: filtered });
  } catch (e) {
    clearTimeout(timer);
    console.warn('[auth] 拿 HR 名單失敗:', e.message);
    res.status(e.name === 'AbortError' ? 504 : 502).json({ error: '人資系統連不上,員工名單暫時拿不到,請稍後再試' });
  }
}));

/**
 * GET /auth/me
 * 回當前登入 user (含 HR shadow fields)
 */
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT id, email, name, phone, hr_emp_id, hr_role, cloud_access,
            email_verified_at, last_login_at, created_at
       FROM users WHERE id = $1`,
    [req.user.id]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: '找不到這個帳號,請重新登入' });
  }
  res.json({ user: result.rows[0] });
}));

// ─── 410 Gone: HR-managed features moved to LEO /attendance ──

router.post('/register', (_req, res) => {
  res.status(410).json({
    error: '註冊功能停用 — 帳號由 LEO HR 系統統一管理，請聯絡 super_admin',
    moved_to: `${HR_BASE_URL}/attendance`,
  });
});

router.post('/change-password', (_req, res) => {
  res.status(410).json({
    error: '改密碼功能停用 — PIN 由 super_admin 在 LEO HR /attendance 頁統一管理',
    moved_to: `${HR_BASE_URL}/attendance`,
  });
});

module.exports = router;
module.exports._internals = { retryAfterSec, cleanDeviceId };
