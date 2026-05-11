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
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'missing or invalid Authorization header' });
  }
  try {
    const payload = verifyToken(match[1]);
    req.user = { id: payload.userId, email: payload.email };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  requireAuth,
};
