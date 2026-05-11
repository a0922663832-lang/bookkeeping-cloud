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
// If WEBHOOK_HMAC_SECRET is not set, verification is bypassed (dev mode).

'use strict';

const crypto = require('crypto');

const HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET || '';
const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

function isConfigured() {
  return HMAC_SECRET.length > 0;
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
    return { valid: true, reason: 'HMAC not configured (dev mode)', configured: false };
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

module.exports = { isConfigured, computeSignature, verifyRequest };
