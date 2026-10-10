// src/seedDefaults.js
// 每本帳本的預設科目 / 帳戶(原在 server.js,2026-10-10 搬出來給 POST /books 共用)
// Idempotent: 既有的 skip, 缺的補.

'use strict';

// ── Default subjects (規格書 §A.1 + LEO 拍板 4191 銷售折讓 + 7301 內部轉帳 for transfer) ──
const DEFAULT_SUBJECTS = [
  // t1 收入
  { code: '4101', name: '營業收入', parent_type: 't1', display_order: 10 },
  { code: '4109', name: '服務費收入', parent_type: 't1', display_order: 20 },
  { code: '4191', name: '銷售折讓', parent_type: 't1', display_order: 30 },
  { code: '4197', name: '銷貨退回(前期)', parent_type: 't1', display_order: 40 },
  { code: '4198', name: '違約金收入', parent_type: 't1', display_order: 50 },
  { code: '4408', name: '訂金收入', parent_type: 't1', display_order: 60 },
  // t2 成本
  { code: '5101', name: '食材-肉品', parent_type: 't2', display_order: 110 },
  { code: '5102', name: '食材-海鮮', parent_type: 't2', display_order: 120 },
  { code: '5103', name: '食材-蔬菜', parent_type: 't2', display_order: 130 },
  { code: '5104', name: '食材-米麵', parent_type: 't2', display_order: 140 },
  { code: '5105', name: '食材-調味料', parent_type: 't2', display_order: 150 },
  { code: '5106', name: '食材-其他', parent_type: 't2', display_order: 160 },
  { code: '5197', name: '銷貨退回(沖銷)', parent_type: 't2', display_order: 170 },
  // t3 費用
  { code: '6101', name: '房租', parent_type: 't3', display_order: 210 },
  { code: '6201', name: '水電瓦斯', parent_type: 't3', display_order: 220 },
  { code: '6301', name: '清潔用品', parent_type: 't3', display_order: 230 },
  { code: '6401', name: '修繕維護', parent_type: 't3', display_order: 240 },
  { code: '6501', name: '行銷廣告', parent_type: 't3', display_order: 250 },
  { code: '6506', name: 'INLINE 平台手續費', parent_type: 't3', display_order: 260 },
  { code: '6801', name: '員工薪資', parent_type: 't3', display_order: 270 },
  { code: '6802', name: '勞健保', parent_type: 't3', display_order: 280 },
  { code: '6901', name: '其他費用', parent_type: 't3', display_order: 290 },
  // t4 轉帳 (M1 stage 1b 新增,讓 transfer 有正確 subject)
  { code: '7301', name: '內部轉帳', parent_type: 't4', display_order: 410 },
  // t5 股東權益
  { code: '7101', name: '股東出資', parent_type: 't5', display_order: 510 },
  { code: '7102', name: '股東提款', parent_type: 't5', display_order: 520 },
];

const DEFAULT_ACCOUNTS = [
  { name: '現金袋', type: 'cash', display_order: 10 },
  { name: '玉山銀行', type: 'bank', display_order: 20 },
  { name: 'INLINE 訂金待撥', type: 'virtual', display_order: 30 },
  { name: '應付帳款-臨時', type: 'liability', display_order: 40 },
];

async function ensureSubject(client, bookId, s) {
  const exists = await client.query(
    `SELECT 1 FROM subjects WHERE book_id = $1 AND code = $2`,
    [bookId, s.code]
  );
  if (exists.rows.length > 0) return false;
  await client.query(
    `INSERT INTO subjects (book_id, code, name, parent_type, display_order)
     VALUES ($1, $2, $3, $4, $5)`,
    [bookId, s.code, s.name, s.parent_type, s.display_order]
  );
  return true;
}

async function ensureAccount(client, bookId, a) {
  const exists = await client.query(
    `SELECT 1 FROM ag_accounts WHERE book_id = $1 AND name = $2`,
    [bookId, a.name]
  );
  if (exists.rows.length > 0) return false;
  await client.query(
    `INSERT INTO ag_accounts (book_id, name, type, display_order)
     VALUES ($1, $2, $3, $4)`,
    [bookId, a.name, a.type, a.display_order]
  );
  return true;
}

async function seedDefaultsForBook(client, bookId) {
  let added = 0;
  for (const s of DEFAULT_SUBJECTS) {
    if (await ensureSubject(client, bookId, s)) added++;
  }
  for (const a of DEFAULT_ACCOUNTS) {
    if (await ensureAccount(client, bookId, a)) added++;
  }
  console.log(`[seed] book ${bookId}: inserted ${added} new defaults`);
}

module.exports = { DEFAULT_SUBJECTS, DEFAULT_ACCOUNTS, seedDefaultsForBook };
