// src/server.js
// Bookkeeping cloud · Express entry · M0 stage 1
//
// 啟動順序:
//   1. 連 PostgreSQL pool
//   2. 跑 migrations
//   3. seed admin user + 第一本帳本 (僅首次啟動)
//   4. 連 Redis
//   5. 起 Express on PORT
//
// M0 階段 1 只暴露一個 endpoint: GET /health

'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const bcrypt = require('bcrypt');
const Redis = require('ioredis');

const { getPool } = require('./db');
const { runMigrations } = require('./migrate');

const PORT = parseInt(process.env.PORT || '3001', 10);
const VERSION = '0.1.0';

// ── Redis 用 lazy connect, 避免啟動順序問題 ────────────────────────
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 200, 3000),
});

redis.on('error', (err) => {
  console.error('[redis] error:', err.message);
});

// ── Seed (M0 階段 1: 首次啟動建 admin + 第一本帳本) ─────────────────
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
    `INSERT INTO book_members (book_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [bookId, userId]
  );

  console.log(`[seed] created admin (${email}) and book (NEST0001 / 花現鳥巢)`);
  if (password === 'changeme') {
    console.log('[seed] ⚠️  using default password "changeme" — change it ASAP in M0 stage 2');
  }
}

// ── Express ────────────────────────────────────────────────────────
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

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

app.get('/', (req, res) => {
  res.json({
    name: 'bookkeeping-cloud',
    version: VERSION,
    docs: 'see ../Money/公司記帳雲系統_軟體規格書_v1.7.md',
  });
});

// ── Startup ────────────────────────────────────────────────────────
async function start() {
  const pool = getPool();
  try {
    await runMigrations(pool);
    await seedAdmin(pool);
    await redis.connect();
    app.listen(PORT, () => {
      console.log(`[server] bookkeeping cloud listening on port ${PORT}`);
      console.log(`[server] try: curl http://localhost:${PORT}/health`);
    });
  } catch (e) {
    console.error('[server] failed to start:', e);
    process.exit(1);
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`[server] received ${signal}, shutting down`);
  try {
    await redis.quit();
  } catch (e) { /* ignore */ }
  try {
    await getPool().end();
  } catch (e) { /* ignore */ }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
