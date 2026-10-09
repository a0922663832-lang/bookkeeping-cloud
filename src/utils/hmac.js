// src/utils/hmac.js
// HMAC-SHA256 signature verification for webhook /internal/posting.
//
// Inbound request must include:
//   X-Timestamp: <unix ms>
//   X-Signature: sha256=<hex digest>
//
// Signed message format: "<timestamp>.<raw_body>"
//
// Sender computes: HMAC-SHA256(WEBHOOK_HMAC_SECRET, "<timestamp>.<raw_body>")
// Receiver re-computes and timingSafeEqual compares.
//
// Replay protection: |Date.now() - timestamp| must be < MAX_AGE_MS.
//
// 沒設 WEBHOOK_HMAC_SECRET(2026-10-09 主 repo 全專案重掃 包 16 B1):
//   以前 = 全部放行(dev mode)—— 遠端 .env 哪天少了這行(1Panel 清過 .env),
//   /internal/posting、/internal/supersede、status-check 就變成區網任何裝置都能直接記帳 / 沖銷正式帳本,而且不報錯。
//   現在:
//   - NODE_ENV=production 沒設 → 拒絕啟動(assertStartupConfig,server.js 開機時呼叫)
//   - 其他環境沒設 → 一律拒收;只有明確設 HMAC_ALLOW_UNSIGNED=1(本機開發)才放行

'use strict';

const crypto = require('crypto');

const HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET || '';
const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const NOT_CONFIGURED_REASON = '記帳雲沒有設定簽章密鑰(WEBHOOK_HMAC_SECRET),拒收機器對機器的請求';

function isConfigured() {
  return HMAC_SECRET.length > 0;
}

/** 沒設密鑰時要不要放行:只有「不是正式環境」而且明確開了 HMAC_ALLOW_UNSIGNED=1 才放行 */
function allowUnsigned() {
  return !isConfigured()
    && process.env.NODE_ENV !== 'production'
    && process.env.HMAC_ALLOW_UNSIGNED === '1';
}

/**
 * 開機檢查:正式環境沒設密鑰 → 丟錯(server.js 接到就 process.exit(1)),比照 auth.js 對 JWT 預設值的做法。
 * 非正式環境沒設 → 只大聲警告(所有機器對機器請求會被拒,除非 HMAC_ALLOW_UNSIGNED=1)。
 */
function assertStartupConfig() {
  if (isConfigured()) return { ok: true };
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[hmac] FATAL: WEBHOOK_HMAC_SECRET 沒設定,正式環境拒絕啟動(否則任何人都能直接記帳 / 沖銷)');
  }
  if (allowUnsigned()) {
    console.warn('[hmac] ⚠ WEBHOOK_HMAC_SECRET 沒設定,HMAC_ALLOW_UNSIGNED=1 → 開發模式放行未簽章請求(正式環境絕對不要這樣設)');
    return { ok: true, unsigned: true };
  }
  console.warn('[hmac] ⚠ WEBHOOK_HMAC_SECRET 沒設定 → /internal/* 機器對機器請求一律拒收');
  return { ok: true, rejecting: true };
}

function computeSignature(timestamp, bodyString) {
  const message = `${timestamp}.${bodyString}`;
  return crypto.createHmac('sha256', HMAC_SECRET).update(message).digest('hex');
}

/**
 * Verify request signature.
 * @param headers - req.headers (lowercased keys)
 * @param rawBody - raw request body as string (req.rawBody, set via express.json verify hook)
 * @returns { valid: boolean, reason?: string, configured: boolean }
 */
function verifyRequest(headers, rawBody) {
  if (!isConfigured()) {
    if (allowUnsigned()) return { valid: true, reason: 'HMAC not configured (dev mode, HMAC_ALLOW_UNSIGNED=1)', configured: false };
    return { valid: false, reason: NOT_CONFIGURED_REASON, configured: false };
  }
  const ts = headers['x-timestamp'];
  const sig = headers['x-signature'];
  if (!ts || !sig) {
    return { valid: false, reason: 'missing X-Timestamp or X-Signature header', configured: true };
  }
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) {
    return { valid: false, reason: 'invalid X-Timestamp (not a number)', configured: true };
  }
  const age = Math.abs(Date.now() - tsNum);
  if (age > MAX_AGE_MS) {
    return {
      valid: false,
      reason: `timestamp out of window (age=${age}ms, max=${MAX_AGE_MS}ms)`,
      configured: true,
    };
  }
  const expected = computeSignature(ts, rawBody || '');
  const provided = sig.replace(/^sha256=/, '');
  if (expected.length !== provided.length) {
    return { valid: false, reason: 'signature length mismatch', configured: true };
  }
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'signature mismatch', configured: true };
  }
  return { valid: true, configured: true };
}

module.exports = { isConfigured, allowUnsigned, assertStartupConfig, computeSignature, verifyRequest, NOT_CONFIGURED_REASON };
