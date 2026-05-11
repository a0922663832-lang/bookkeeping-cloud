// src/db.js
// PostgreSQL connection pool + transaction helper.
// 仿 monorepo lib/db.js 的 ctx.tx() 設計, 但走原生 pg.

'use strict';

const { Pool } = require('pg');

let _pool = null;

function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
    });
    _pool.on('error', (err) => {
      console.error('[db] unexpected pool error:', err);
    });
  }
  return _pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

/**
 * 在 transaction 內執行 fn(client). fn 拋錯則 ROLLBACK, 否則 COMMIT.
 * fn 拿到的 client 有 .query() method, 跟 pool.query() 用法相同.
 */
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { getPool, query, withTransaction };
