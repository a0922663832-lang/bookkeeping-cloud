// src/utils/hmac.js
// HMAC-SHA256 signature verification for webhook /internal/posting.
//
// Inbound request must include:
//   X-Timestamp: <unix ms>
//   X-Signature: sha256=<hex digest>
//
// Signed message format(v1,過渡期還收): "<timestamp>.<raw_body>"
//
// Sender computes: HMAC-SHA256(WEBHOOK_HMAC_SECRET, "<timestamp>.<raw_body>")
// Receiver re-computes and timingSafeEqual compares.
//
// v2(2026-10-11 第二輪 §4.1 / Y6,簽章含網址;與主 repo cloudBookkeepingClient.js 一字不差):
//   v2 簽章字串 = "v2." + timestamp + "." + METHOD + "." + path + "." + rawBody
//     METHOD = 大寫;path = req.path 原樣(不含 query);rawBody = 原始 JSON 字串(req.rawBody)
//   標頭:X-Timestamp 不變;X-Signature: "sha256=<hex>";X-Signature-Version: "2"
//   有 X-Signature-Version: 2 → 只驗 v2;沒有這個標頭 → 驗 v1 並 console.warn('[hmac] 收到 v1 簽章', path)
//   (v1 只簽 "<ts>.<body>",簽好要送 NEST0099 的請求 5 分鐘內改網址就能送進 NEST0001;
//    等線上 log 連續 7 天沒有「收到 v1 簽章」再另開一包拿掉 v1)
//   固定對照向量:secret test-secret、ts 1700000000000、POST、/B/NEST0099/internal/posting、{"a":1}
//     → b29e0e5c43358bd1571397b1c283a3ade17689b975ad5b833776612f8f88eaf8
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

/** v2 簽章字串(純函式,secret 可指定給測試算固定向量用;不傳就用環境變數那把) */
function signatureStringV2(timestamp, method, reqPath, bodyString) {
  return `v2.${timestamp}.${String(method || '').toUpperCase()}.${reqPath}.${bodyString}`;
}

function computeSignatureV2(timestamp, method, reqPath, bodyString, secret) {
  const key = secret === undefined ? HMAC_SECRET : secret;
  return crypto.createHmac('sha256', key)
    .update(signatureStringV2(timestamp, method, reqPath, bodyString))
    .digest('hex');
}

/**
 * Verify request signature.
 * @param headers - req.headers (lowercased keys)
 * @param rawBody - raw request body as string (req.rawBody, set via express.json verify hook)
 * @param method  - req.method(v2 必要)
 * @param reqPath - req.path(v2 必要;不含 query)
 * @returns { valid: boolean, reason?: string, configured: boolean, version?: 1|2 }
 */
function verifyRequest(headers, rawBody, method, reqPath) {
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
  const rawVer = headers['x-signature-version'];
  let version = 1;
  let expected;
  if (rawVer !== undefined && rawVer !== null && String(rawVer).trim() !== '') {
    if (String(rawVer).trim() !== '2') {
      return { valid: false, reason: '簽章版本不認得,拒收', configured: true };
    }
    version = 2;
    if (!method || typeof reqPath !== 'string' || !reqPath) {
      // 呼叫端(路由)沒把網址傳進來 → 驗不了新版簽章;寧可拒收也不要退回舊版(舊版不含網址)
      console.error('[hmac] 收到新版簽章但呼叫端沒傳網址,拒收(要修路由的 verifyRequest 呼叫)');
      return { valid: false, reason: '記帳雲這個入口還不能驗新版簽章,拒收', configured: true };
    }
    expected = computeSignatureV2(ts, method, reqPath, rawBody || '');
  } else {
    expected = computeSignature(ts, rawBody || '');
  }
  const provided = sig.replace(/^sha256=/, '');
  if (expected.length !== provided.length) {
    return { valid: false, reason: 'signature length mismatch', configured: true, version };
  }
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'signature mismatch', configured: true, version };
  }
  // 驗過才記(垃圾請求不灌 log);部署後用這行確認主 repo 是否全部換成 v2
  if (version === 1) console.warn('[hmac] 收到 v1 簽章', reqPath);
  return { valid: true, configured: true, version };
}

module.exports = {
  isConfigured, allowUnsigned, assertStartupConfig,
  computeSignature, computeSignatureV2, signatureStringV2,
  verifyRequest, NOT_CONFIGURED_REASON,
};
