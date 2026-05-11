// src/routes/auth.js
// POST /auth/register, POST /auth/login, GET /auth/me

'use strict';

const express = require('express');
const { query } = require('../db');
const { hashPassword, verifyPassword, signToken, requireAuth } = require('../auth');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /auth/register
 * body: { email, password, name }
 * 201 { token, user }
 */
router.post('/register', asyncHandler(async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid email' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'password too short (min 6 chars)' });
  }
  if (!name || name.length < 1 || name.length > 100) {
    return res.status(400).json({ error: 'name required (1-100 chars)' });
  }

  const exists = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (exists.rows.length > 0) {
    return res.status(409).json({ error: 'email already registered' });
  }

  const hash = await hashPassword(password);
  const result = await query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, $2, $3)
     RETURNING id, email, name, created_at`,
    [email, hash, name]
  );
  const user = result.rows[0];
  const token = signToken({ userId: user.id, email: user.email });
  res.status(201).json({ token, user });
}));

/**
 * POST /auth/login
 * body: { email, password }
 * 200 { token, user }
 */
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }

  const result = await query(
    `SELECT id, email, password_hash, name FROM users WHERE email = $1`,
    [email]
  );
  const user = result.rows[0];
  if (!user) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'invalid credentials' });
  }

  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

  const token = signToken({ userId: user.id, email: user.email });
  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name },
  });
}));

/**
 * GET /auth/me
 * 回當前登入 user
 */
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT id, email, name, phone, email_verified_at, last_login_at, created_at
       FROM users WHERE id = $1`,
    [req.user.id]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'user not found' });
  }
  res.json({ user: result.rows[0] });
}));

/**
 * POST /auth/change-password
 * body: { current_password, new_password }
 * (M0 階段 2 補:首次登入後改 changeme 預設密碼用)
 */
router.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password and new_password required' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'new_password too short (min 6 chars)' });
  }

  const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'user not found' });
  }
  const ok = await verifyPassword(current_password, result.rows[0].password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'current_password incorrect' });
  }
  const newHash = await hashPassword(new_password);
  await query(
    'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
    [newHash, req.user.id]
  );
  res.json({ ok: true });
}));

module.exports = router;
