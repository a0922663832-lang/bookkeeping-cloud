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
  return typeof s === 'string' && s.length === LENGTH && /^[A-Z2-9]+$/.test(s);
}

module.exports = { generate, isValidFormat, CHARS, LENGTH };
