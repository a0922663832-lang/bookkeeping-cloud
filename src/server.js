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
const reconciliationRoutes = require('./routes/reconciliation');
const { seedDefaultsForBook } = require('./seedDefaults');

const path = require('path');

const PORT = parseInt(process.env.PORT || '3001', 10);
const VERSION = '0.15.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ── Redis ──────────────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 200, 3000),
});
redis.on('error', (err) => console.error('[redis] error:', err.message));

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
  try { status.alerts = require('./alertService').mode(); } catch (e) { status.alerts = 'unknown'; }
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
    docs: 'see docs/money/公司記帳雲系統_軟體規格書_v1.7.md (main repo)',
  });
});

// ── Phase A static UI pages ────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html')));
app.get('/pending', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'pending.html')));
app.get('/journals', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'journals.html')));
app.get('/setup', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'setup.html')));
app.get('/reports', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'reports.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'settings.html')));
app.get('/reconcile', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'reconcile.html')));
app.get('/common.js', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'common.js')));

app.use('/auth', authRoutes);
app.use('/', booksRoutes);
app.use('/', lookupsRoutes);
app.use('/', journalsRoutes);
app.use('/', reportsRoutes);
app.use('/', postingRoutes);
app.use('/', reconciliationRoutes);

app.use((req, res) => {
  res.status(404).json({ error: '找不到這個功能,請重新整理頁面', path: req.path });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.stack || err);
  if (res.headersSent) return;
  // 4xx 由程式自己丟的(err.status)訊息已白話,照回;其他一律不回原始錯誤 / detail(G2)
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '送來的資料格式不對' });
  if (err.code === '23505') return res.status(409).json({ error: '資料重複了,已經有一筆一樣的' });
  if (err.code === '23503') return res.status(400).json({ error: '用到的帳戶或科目不存在,請重新整理再試' });
  if (err.code === '23514') return res.status(400).json({ error: '資料不符合規則,請檢查後再送' });
  res.status(500).json({ error: '系統發生錯誤,已記錄' });
});

async function start() {
  // 主 repo 包 16 B1:正式環境沒設 WEBHOOK_HMAC_SECRET → 拒絕啟動(否則 /internal/* 任何人都能記帳)
  try {
    require('./utils/hmac').assertStartupConfig();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const pool = getPool();
  try {
    await runMigrations(pool);
    await seedAdmin(pool);
    await backfillDefaults(pool);
    await redis.connect();
    httpServer = app.listen(PORT, () => {
      console.log(`[server] bookkeeping cloud v${VERSION} listening on port ${PORT}`);
    });

    // D24: daily close review cron
    try {
      require('./dailyReviewCron').startCron();
    } catch (e) {
      console.error('[daily-review] cron 啟動失敗:', e.message);
    }

    // Phase 0: 每日對帳 cron（04:10 對前一日逐事件比對 LEO 端）
    try {
      require('./reconcileCron').startCron();
    } catch (e) {
      console.error('[recon] cron 啟動失敗:', e.message);
    }
  } catch (e) {
    console.error('[server] failed to start:', e);
    process.exit(1);
  }
}

let httpServer = null;

async function shutdown(signal) {
  console.log(`[server] received ${signal}, shutting down`);
  // G11:先停收新請求、等進行中的請求做完,再關 redis / db
  if (httpServer) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 10000);
      httpServer.close(() => { clearTimeout(t); resolve(); });
    });
  }
  try { await redis.quit(); } catch (e) { /* ignore */ }
  try { await getPool().end(); } catch (e) { /* ignore */ }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
