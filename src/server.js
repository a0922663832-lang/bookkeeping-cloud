// src/server.js
// Bookkeeping cloud · Express entry · M1 stage 1a
//
// 啟動順序:
//   1. 連 PostgreSQL pool
//   2. 跑 migrations
//   3. seed admin user + 第一本帳本 + 預設科目/帳戶 (僅首次啟動)
//   4. 連 Redis
//   5. 起 Express on PORT

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

const PORT = parseInt(process.env.PORT || '3001', 10);
const VERSION = '0.3.0';

// ── Redis ──────────────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 200, 3000),
});
redis.on('error', (err) => console.error('[redis] error:', err.message));

// ── Default subjects (規格書 §A.1 + LEO 拍板 4191 銷售折讓) ────────
// 餐飲業常用,LEO 可後續自加.
const DEFAULT_SUBJECTS = [
  // t1 收入
  { code: '4101', name: '營業收入', parent_type: 't1', display_order: 10 },
  { code: '4109', name: '服務費收入', parent_type: 't1', display_order: 20 },
  { code: '4191', name: '銷售折讓', parent_type: 't1', display_order: 30 }, // LEO 拍板 (沖收入)
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

  // t5 股東權益
  { code: '7101', name: '股東出資', parent_type: 't5', display_order: 510 },
  { code: '7102', name: '股東提款', parent_type: 't5', display_order: 520 },
];

// ── Default ag_accounts (現金袋 / 玉山銀行 / INLINE 待撥 / 應付帳款-臨時) ──
const DEFAULT_ACCOUNTS = [
  { name: '現金袋', type: 'cash', display_order: 10 },
  { name: '玉山銀行', type: 'bank', display_order: 20 },
  { name: 'INLINE 訂金待撥', type: 'virtual', display_order: 30 },
  { name: '應付帳款-臨時', type: 'liability', display_order: 40 },
];

async function seedDefaultsForBook(client, bookId) {
  for (const s of DEFAULT_SUBJECTS) {
    await client.query(
      `INSERT INTO subjects (book_id, code, name, parent_type, display_order)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [bookId, s.code, s.name, s.parent_type, s.display_order]
    );
  }
  for (const a of DEFAULT_ACCOUNTS) {
    await client.query(
      `INSERT INTO ag_accounts (book_id, name, type, display_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [bookId, a.name, a.type, a.display_order]
    );
  }
  console.log(`[seed] inserted ${DEFAULT_SUBJECTS.length} subjects and ${DEFAULT_ACCOUNTS.length} accounts for book ${bookId}`);
}

// ── Seed (首次啟動建 admin + 第一本帳本 + 預設資料) ────────────────
async function seedAdmin(pool) {
  const existing = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(existing.rows[0].count, 10) > 0) {
    console.log('[seed] users already exist, skipping');
    return;
  }
  const email = 'a0922663832@gmail.com';
  const password = process.env.INITIAL_ADMIN_PASSWORD || 'changeme';
  const hash = await bcrypt.hash(password, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userRes = await client.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3) RETURNING id`,
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
    console.log(`[seed] created admin (${email}) and book (NEST0001 / 花現鳥巢)`);
    if (password === 'changeme') {
      console.log('[seed] ⚠️  using default password "changeme" — call POST /auth/change-password to change it');
    }
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// 補:對既有 book seed 預設資料 (給 M0 已建好的 book 補 M1 階段 1a 的 subjects/accounts).
async function backfillExistingBooks(pool) {
  const books = await pool.query('SELECT id FROM books');
  for (const row of books.rows) {
    const subjectCount = await pool.query(
      'SELECT COUNT(*) FROM subjects WHERE book_id = $1',
      [row.id]
    );
    if (parseInt(subjectCount.rows[0].count, 10) === 0) {
      console.log(`[backfill] book ${row.id} has no subjects, seeding defaults`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await seedDefaultsForBook(client, row.id);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
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
  } catch (e) { status.db = `error: ${e.message}`; status.status = 'degraded'; }
  try {
    const pong = await redis.ping();
    status.redis = pong === 'PONG' ? 'connected' : `unexpected: ${pong}`;
  } catch (e) { status.redis = `error: ${e.message}`; status.status = 'degraded'; }
  res.status(status.status === 'ok' ? 200 : 503).json(status);
});

app.get('/', (req, res) => {
  res.json({
    name: 'bookkeeping-cloud',
    version: VERSION,
    stage: 'M1 stage 1a',
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
      lookups: [
        'GET /B/:bookCode/subjects',
        'GET /B/:bookCode/accounts',
        'GET /B/:bookCode/counterparties',
      ],
      journals: [
        'POST /B/:bookCode/journals',
        'GET /B/:bookCode/journals',
        'GET /B/:bookCode/journals/:id',
      ],
    },
    docs: 'see ../Money/公司記帳雲系統_軟體規格書_v1.7.md',
  });
});

app.use('/auth', authRoutes);
app.use('/', booksRoutes);
app.use('/', lookupsRoutes);
app.use('/', journalsRoutes);

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
  if (err.code === '23514') return res.status(400).json({ error: 'check constraint failed (likely invalid type/field combo)', detail: err.detail });
  res.status(500).json({ error: err.message || 'internal server error' });
});

// ── Startup ────────────────────────────────────────────────────────
async function start() {
  const pool = getPool();
  try {
    await runMigrations(pool);
    await seedAdmin(pool);
    await backfillExistingBooks(pool);
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

async function shutdown(signal) {
  console.log(`[server] received ${signal}, shutting down`);
  try { await redis.quit(); } catch (e) { /* ignore */ }
  try { await getPool().end(); } catch (e) { /* ignore */ }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
