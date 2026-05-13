// src/server.js
// Bookkeeping cloud · Express entry · M1 stage 1b
//
// 啟動順序:
//   1. 連 PostgreSQL pool
//   2. 跑 migrations
//   3. seed admin user + 第一本帳本 (僅首次啟動)
//   4. backfillDefaults: 每次啟動補缺的預設 subjects/accounts (idempotent)
//   5. 連 Redis
//   6. 起 Express on PORT

'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const bcrypt = require('bcrypt');
const Redis = require('ioredis');

const { getPool } = require('./db');
const { runMigrations } = require('./migrate');
const authRoutes = require('./routes/auth');
const booksRoutes = require('./routes/books');
const journalsRoutes = require('./routes/journals');
const lookupsRoutes = require('./routes/lookups');
const reportsRoutes = require('./routes/reports');
const postingRoutes = require('./routes/posting');

const path = require('path');

const PORT = parseInt(process.env.PORT || '3001', 10);
const VERSION = '0.12.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ── Redis ──────────────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 200, 3000),
});
redis.on('error', (err) => console.error('[redis] error:', err.message));

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

async function seedAdmin(pool) {
  const existing = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(existing.rows[0].count, 10) > 0) {
    console.log('[seed] users already exist, skipping admin/first-book creation');
    return;
  }
  const email = 'a0922663832@gmail.com';
  const password = process.env.INITIAL_ADMIN_PASSWORD || 'changeme';
  const hash = await bcrypt.hash(password, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userRes = await client.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id`,
      [email, hash, 'LEO']
    );
    const userId = userRes.rows[0].id;

    const bookRes = await client.query(
      `INSERT INTO books (code, name, company_name, currency, fiscal_year_start_month, owner_id)
       VALUES ($1, $2, $3, 'TWD', 1, $4) RETURNING id`,
      ['NEST0001', '花現鳥巢', 'Nest Restaurant', userId]
    );
    const bookId = bookRes.rows[0].id;

    await client.query(
      `INSERT INTO book_members (book_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [bookId, userId]
    );

    await seedDefaultsForBook(client, bookId);

    await client.query('COMMIT');
    console.log(`[seed] created legacy admin (${email}) and book (NEST0001 / 花現鳥巢)`);
    console.log('[seed] ℹ️  HR SSO 模式啟用後，此 admin 僅做為 LEGACY_EMAIL_LOGIN 緊急 backdoor 用');
    console.log('[seed] ℹ️  日常登入請走 HR /attendance 設定的 cloud_access + emp_id + PIN');
    if (password === 'changeme') {
      console.log('[seed] ⚠️  default password "changeme" 還沒改 — 上 production 前先設 INITIAL_ADMIN_PASSWORD env');
    }
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// 每次啟動都跑: 對所有 book 補缺的預設 subjects/accounts.
// Idempotent: 既有的 skip, 缺的補. 用於部署新版時自動補上 DEFAULT_* 新增項.
async function backfillDefaults(pool) {
  const books = await pool.query('SELECT id FROM books');
  for (const row of books.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await seedDefaultsForBook(client, row.id);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`[backfill] book ${row.id} failed:`, e.message);
    } finally {
      client.release();
    }
  }
}

// ── Express ────────────────────────────────────────────────────────
const app = express();
// CSP disabled (Phase A): allow Bootstrap/jQuery/Chart.js CDN + inline <style>/<script>.
// Tighten before commercial launch (whitelist cdn.jsdelivr.net etc).
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
// raw body kept on req.rawBody for HMAC signature verification of webhooks
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

app.get('/health', async (req, res) => {
  const status = { status: 'ok', db: 'unknown', redis: 'unknown', version: VERSION };
  try {
    await getPool().query('SELECT 1');
    status.db = 'connected';
  } catch (e) { status.db = `error: ${e.message}`; status.status = 'degraded'; }
  try {
    const pong = await redis.ping();
    status.redis = pong === 'PONG' ? 'connected' : `unexpected: ${pong}`;
  } catch (e) { status.redis = `error: ${e.message}`; status.status = 'degraded'; }
  res.status(status.status === 'ok' ? 200 : 503).json(status);
});

// API info (was at /). Now / serves login page; this is the machine-readable index.
app.get('/api-info', (req, res) => {
  res.json({
    name: 'bookkeeping-cloud',
    version: VERSION,
    stage: 'HR SSO mode: login proxies LEO HR /api/auth/login, book_members auto from cloud_access',
    endpoints: {
      health: 'GET /health',
      auth: ['POST /auth/register', 'POST /auth/login', 'GET /auth/me', 'POST /auth/change-password'],
      books: ['GET /books', 'POST /books', 'GET /B/:bookCode', 'PATCH /B/:bookCode'],
      members: [
        'GET /B/:bookCode/members', 'POST /B/:bookCode/members',
        'PATCH /B/:bookCode/members/:userId', 'DELETE /B/:bookCode/members/:userId',
      ],
      subjects: [
        'GET /B/:bookCode/subjects', 'POST /B/:bookCode/subjects',
        'PATCH /B/:bookCode/subjects/:id',
      ],
      accounts: [
        'GET /B/:bookCode/accounts', 'POST /B/:bookCode/accounts',
        'PATCH /B/:bookCode/accounts/:id',
      ],
      counterparties: [
        'GET /B/:bookCode/counterparties', 'POST /B/:bookCode/counterparties',
        'PATCH /B/:bookCode/counterparties/:id',
      ],
      journals: [
        'POST /B/:bookCode/journals (支援 reclassify 1:N: body.targets[])',
        'GET /B/:bookCode/journals', 'GET /B/:bookCode/journals/:id',
        'PATCH /B/:bookCode/journals/:id (M1 1d 修改 + 自動重算餘額)',
        'DELETE /B/:bookCode/journals/:id (soft delete via reverse)',
      ],
      reports: [
        'GET /B/:bookCode/reports/dashboard',
        'GET /B/:bookCode/reports/monthly?year=&month=',
        'GET /B/:bookCode/reports/yearly?year=',
        'GET /B/:bookCode/reports/counterparties?from=&to=',
      ],
      posting: [
        'POST /B/:bookCode/internal/posting (X-Posting-Token header)',
        'GET /B/:bookCode/pending-journals?status=',
        'GET /B/:bookCode/pending-journals/:id',
        'POST /B/:bookCode/pending-journals/:id/approve',
        'POST /B/:bookCode/pending-journals/:id/reject',
      ],
    },
    docs: 'see ../Money/公司記帳雲系統_軟體規格書_v1.7.md',
  });
});

// ── Phase A static UI pages ────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html')));
app.get('/pending', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'pending.html')));
app.get('/journals', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'journals.html')));
app.get('/setup', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'setup.html')));
app.get('/reports', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'reports.html')));
// future Phase E (settings) pages will go in PUBLIC_DIR

app.use('/auth', authRoutes);
app.use('/', booksRoutes);
app.use('/', lookupsRoutes);
app.use('/', journalsRoutes);
app.use('/', reportsRoutes);
app.use('/', postingRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'not found', path: req.path });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.stack || err);
  if (res.headersSent) return;
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err.code === '23505') return res.status(409).json({ error: 'conflict (unique constraint)', detail: err.detail });
  if (err.code === '23503') return res.status(400).json({ error: 'foreign key violation', detail: err.detail });
  if (err.code === '23514') return res.status(400).json({ error: 'check constraint failed', detail: err.detail });
  res.status(500).json({ error: err.message || 'internal server error' });
});

async function start() {
  const pool = getPool();
  try {
    await runMigrations(pool);
    await seedAdmin(pool);
    await backfillDefaults(pool);
    await redis.connect();
    app.listen(PORT, () => {
      console.log(`[server] bookkeeping cloud v${VERSION} listening on port ${PORT}`);
    });
  } catch (e) {
    console.error('[server] failed to start:', e);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`[server] received ${signal}, shutting down`);
  try { await redis.quit(); } catch (e) { /* ignore */ }
  try { await getPool().end(); } catch (e) { /* ignore */ }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
