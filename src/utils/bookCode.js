// src/utils/bookCode.js
// 產生 8 字元 bookCode, 字元集 ABCDEFGHJKLMNPQRSTUVWXYZ23456789
// (去掉易混淆 0/O/1/I/L), 規格書 §2.3 釘死.

'use strict';

const crypto = require('crypto');

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LENGTH = 8;

function generate() {
  const buf = crypto.randomBytes(LENGTH);
  let code = '';
  for (let i = 0; i < LENGTH; i++) {
    code += CHARS[buf[i] % CHARS.length];
  }
  return code;
}

function isValidFormat(s) {
  // 寬鬆驗證: 接受所有 A-Z 0-9 (含混淆字元 0/1/O/I/L), 因為 seed 或外部資料可能含這些.
  // generate() 仍嚴格用 CHARS (不含混淆字元), 所以新建 bookCode 一定漂亮.
  return typeof s === 'string' && s.length === LENGTH && /^[A-Z0-9]+$/.test(s);
}

module.exports = { generate, isValidFormat, CHARS, LENGTH };
