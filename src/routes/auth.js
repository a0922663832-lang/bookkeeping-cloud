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
const { hashPassword, verifyPassword, signToken, requireAuth } = require('../auth');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

const HR_BASE_URL = process.env.HR_BASE_URL || 'http://10.0.1.168:3000';
const LEGACY_EMAIL_LOGIN = process.env.LEGACY_EMAIL_LOGIN === 'true';
const DEFAULT_BOOK_CODE = process.env.HR_DEFAULT_BOOK_CODE || 'NEST0001';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_CLOUD_ACCESS = new Set(['none', 'viewer', 'editor', 'admin', 'owner']);

// ─── HR proxy login ─────────────────────────────────────────────────
async function hrLogin(emp_id, pin) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`${HR_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emp_id, pin }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      return { status: 504, data: { error: 'HR upstream timeout' } };
    }
    return { status: 502, data: { error: 'HR upstream unreachable: ' + e.message } };
  }
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
  const emp_id = b.emp_id;
  const pin = b.pin;
  if (!emp_id || !pin) {
    return res.status(400).json({ error: 'emp_id and pin required' });
  }

  const { status, data: hrData } = await hrLogin(emp_id, pin);
  if (status === 502 || status === 504) {
    return res.status(status).json({ error: hrData.error || 'HR upstream error' });
  }
  if (status === 401) {
    return res.status(401).json({ error: hrData.error || 'HR rejected credentials' });
  }
  if (status !== 200 || !hrData || !hrData.emp_id) {
    return res.status(500).json({ error: 'unexpected HR response', hr_status: status });
  }

  const cloud_access = hrData.cloud_access || 'none';
  if (!VALID_CLOUD_ACCESS.has(cloud_access) || cloud_access === 'none') {
    return res.status(403).json({
      error: '未開通記帳雲端權限。請聯絡 super_admin 在 HR /attendance 頁面開通。',
      emp_id: hrData.emp_id,
    });
  }

  const user = await upsertHrUser({
    emp_id: hrData.emp_id,
    name: hrData.name,
    role: hrData.role,
    cloud_access,
  });

  const token = signToken({ userId: user.id, email: user.email });
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
    return res.status(404).json({ error: 'user not found' });
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
