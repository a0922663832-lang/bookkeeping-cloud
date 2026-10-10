// src/alertService.js
// 記帳雲的單一告警出口(2026-10-10 施工計畫 §4.7 / Y36①)
//
// 有設 NTFY_URL → 推 ntfy(手機會跳);沒設 → 只寫 console.warn,
// 而且 mode() 回 'console-only',讓 /health 看得出「告警其實沒有人收得到」。
//
// 對外:
//   notify(title, text, level)  title/text 白話中文;level = 'info' | 'warn' | 'error'(預設 warn)
//   warn(key, data) / error(key, data)  給 dailyReviewCron 用的簡寫(key = 事件代號,data = 細節物件)
//   mode()                      'ntfy' | 'console-only'
//   stats()                     { mode, sent, failed, last_error }
//
// 永遠不 throw、不 reject:告警失敗不能把排程拖垮。

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PRIORITY = { info: 'default', warn: 'high', error: 'urgent' };
const TAGS = { info: 'information_source', warn: 'warning', error: 'rotating_light' };

const counters = { sent: 0, failed: 0, last_error: null };
// 同一個 dedup_key 6 小時內只推一次(排程重跑、啟動補跑不要洗版)
const DEDUP_MS = 6 * 3600 * 1000;
const recent = new Map();

function ntfyUrl() {
  return process.env.NTFY_URL || '';
}

function mode() {
  return ntfyUrl() ? 'ntfy' : 'console-only';
}

// ntfy 的標題放在 HTTP header,只能 ASCII → 中文用 RFC 2047 encoded-word,ntfy 會解回 UTF-8
function encodeHeader(s) {
  const str = String(s || '');
  if (/^[\x20-\x7e]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

function postNtfy(url, title, text, level) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, err) => {
      if (settled) return;
      settled = true;
      if (ok) counters.sent++; else { counters.failed++; counters.last_error = err || 'unknown'; }
      resolve(ok);
    };
    try {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      const body = Buffer.from(String(text || ''), 'utf8');
      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          Title: encodeHeader(title),
          Priority: PRIORITY[level] || 'high',
          Tags: TAGS[level] || 'warning',
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': body.length,
        },
        timeout: 8000,
      }, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) done(true);
        else {
          console.warn(`[alert] ntfy 回應 ${res.statusCode}`);
          done(false, `ntfy HTTP ${res.statusCode}`);
        }
      });
      req.on('error', (e) => { console.warn('[alert] ntfy 推送失敗:', e.message); done(false, e.message); });
      req.on('timeout', () => { req.destroy(); done(false, 'timeout'); });
      req.write(body);
      req.end();
    } catch (e) {
      console.warn('[alert] ntfy 推送失敗:', e.message);
      done(false, e.message);
    }
  });
}

/** 發一則告警。回 Promise<boolean>(true = 已推到 ntfy;console-only 或失敗 = false),不會 reject */
async function notify(title, text, level = 'warn') {
  const lv = PRIORITY[level] ? level : 'warn';
  const logger = lv === 'error' ? console.error : console.warn;
  logger(`[ALERT][${lv}] ${title}: ${text}`);
  const url = ntfyUrl();
  if (!url) return false;
  try {
    return await postNtfy(url, title, text, lv);
  } catch (e) {
    return false;
  }
}

function dedupHit(key) {
  if (!key) return false;
  const now = Date.now();
  for (const [k, t] of recent) if (now - t > DEDUP_MS) recent.delete(k);
  if (recent.has(key)) return true;
  recent.set(key, now);
  return false;
}

// dailyReviewCron 的事件代號 → 白話標題
const KEY_TITLES = {
  daily_review_pending: '有一天的自動入帳等你覆核',
  daily_review_escalated: '自動入帳超過 7 天沒人覆核',
};

function describe(key, data) {
  const d = data || {};
  if (key === 'daily_review_pending') {
    return `${d.bookCode || ''} ${d.review_date || ''} 營業日有 ${d.count} 筆自動入帳、合計 $${d.total_amount}，請到「每日覆核」確認。`;
  }
  if (key === 'daily_review_escalated') {
    return `營業日 ${d.review_date || ''} 的自動入帳已超過 7 天沒人覆核，請盡快處理。`;
  }
  return JSON.stringify(d);
}

function viaKey(level) {
  return (key, data) => {
    const dk = data && data.dedup_key ? `${key}:${data.dedup_key}` : null;
    if (dedupHit(dk)) return Promise.resolve(false);
    return notify(KEY_TITLES[key] || String(key), describe(key, data), level);
  };
}

const warn = viaKey('warn');
const error = viaKey('error');

function stats() {
  return { mode: mode(), sent: counters.sent, failed: counters.failed, last_error: counters.last_error };
}

module.exports = { notify, warn, error, mode, stats, _encodeHeader: encodeHeader };
