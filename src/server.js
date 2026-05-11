// src/server.js
// Bookkeeping cloud · Express entry · M0 stage 2
//
// 啟動順序:
//   1. 連 PostgreSQL pool
//   2. 跑 migrations
//   3. seed admin user + 第一本帳本 (僅首次啟動)
//   4. 連 Redis
//   5. 起 Express on PORT
//
// M0 階段 2 暴露的 endpoints:
//   GET  /                          首頁 info
//   GET  /health                    健康檢查
//   POST /auth/register             註冊
//   POST /auth/login                登入 (回 JWT)
//   GET  /auth/me                   當前 user 資訊 (要 JWT)
//   POST /auth/change-password      改密碼 (要 JWT)
//   GET  /books                     列我的所有 book (要 JWT)
//   POST /books                     建新 book (要 JWT)
//   GET  /B/:bookCode               book 詳情 (要 JWT + 成員)
//   PATCH /B/:bookCode              改 book (要 owner/admin)
//   GET  /B/:bookCode/members       列成員
//   POST /B/:bookCode/members       加成員 (要 owner/admin)
//   PATCH /B/:bookCode/members/:uid 改角色 (要 owner)
//   DELETE /B/:bookCode/members/:uid 移除成員 (要 owner)

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

const PORT = parseInt(process.env.PORT || '3001', 10);
const VERSION = '0.2.0';

// ── Redis ──────────────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 200, 3000),
});

redis.on('error', (err) => {
  console.error('[redis] error:', err.message);
});

// ── Seed (首次啟動建 admin + 第一本帳本) ────────────────────────────
async function seedAdmin(pool) {
  const existing = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(existing.rows[0].count, 10) > 0) {
    console.log('[seed] users already exist, skipping');
    return;
  }
  const email = 'a0922663832@gmail.com';
  const password = process.env.INITIAL_ADMIN_PASSWORD || 'changeme';
  const hash = await bcrypt.hash(password, 10);

  const userRes = await pool.query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [email, hash, 'LEO']
  );
  const userId = userRes.rows[0].id;

  const bookRes = await pool.query(
    `INSERT INTO books (code, name, company_name, currency, fiscal_year_start_month, owner_id)
     VALUES ($1, $2, $3, 'TWD', 1, $4)
     RETURNING id`,
    ['NEST0001', '花現鳥巢', 'Nest Restaurant', userId]
  );
  const bookId = bookRes.rows[0].id;

  await pool.query(
    `INSERT INTO book_members (book_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [bookId, userId]
  );

  console.log(`[seed] created admin (${email}) and book (NEST0001 / 花現鳥巢)`);
  if (password === 'changeme') {
    console.log('[seed] ⚠️  using default password "changeme" — call POST /auth/change-password to change it');
  }
}

// ── Express ────────────────────────────────────────────────────────
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// 健康檢查
app.get('/health', async (req, res) => {
  const status = { status: 'ok', db: 'unknown', redis: 'unknown', version: VERSION };
  try {
    await getPool().query('SELECT 1');
    status.db = 'connected';
  } catch (e) {
    status.db = `error: ${e.message}`;
    status.status = 'degraded';
  }
  try {
    const pong = await redis.ping();
    status.redis = pong === 'PONG' ? 'connected' : `unexpected: ${pong}`;
  } catch (e) {
    status.redis = `error: ${e.message}`;
    status.status = 'degraded';
  }
  res.status(status.status === 'ok' ? 200 : 503).json(status);
});

// 首頁 info
app.get('/', (req, res) => {
  res.json({
    name: 'bookkeeping-cloud',
    version: VERSION,
    stage: 'M0 stage 2',
    endpoints: {
      health: 'GET /health',
      auth: ['POST /auth/register', 'POST /auth/login', 'GET /auth/me', 'POST /auth/change-password'],
      books: ['GET /books', 'POST /books', 'GET /B/:bookCode', 'PATCH /B/:bookCode'],
      members: [
        'GET /B/:bookCode/members',
        'POST /B/:bookCode/members',
        'PATCH /B/:bookCode/members/:userId',
        'DELETE /B/:bookCode/members/:userId',
      ],
    },
    docs: 'see ../Money/公司記帳雲系統_軟體規格書_v1.7.md',
  });
});

// Routes
app.use('/auth', authRoutes);
app.use('/', booksRoutes);

// 404 fallback (JSON, not HTML)
app.use((req, res) => {
  res.status(404).json({ error: 'not found', path: req.path });
});

// Error handler (Express 4 needs explicit 4-arg signature)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.stack || err);
  if (res.headersSent) return;
  // PG unique violation
  if (err.code === '23505') {
    return res.status(409).json({ error: 'conflict (unique constraint)', detail: err.detail });
  }
  // PG FK violation
  if (err.code === '23503') {
    return res.status(400).json({ error: 'foreign key violation', detail: err.detail });
  }
  res.status(500).json({ error: err.message || 'internal server error' });
});

// ── Startup ────────────────────────────────────────────────────────
async function start() {
  const pool = getPool();
  try {
    await runMigrations(pool);
    await seedAdmin(pool);
    await redis.connect();
    app.listen(PORT, () => {
      console.log(`[server] bookkeeping cloud v${VERSION} listening on port ${PORT}`);
      console.log(`[server] try: curl http://localhost:${PORT}/health`);
      console.log(`[server] try: curl http://localhost:${PORT}/`);
    });
  } catch (e) {
    console.error('[server] failed to start:', e);
    process.exit(1);
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`[server] received ${signal}, shutting down`);
  try { await redis.quit(); } catch (e) { /* ignore */ }
  try { await getPool().end(); } catch (e) { /* ignore */ }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
