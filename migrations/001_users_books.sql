-- ============================================================================
-- 001_users_books.sql
-- 公司記帳雲系統 · 第一個 migration
-- 建立日期: 2026-05-11
-- 規格書: ../../Money/公司記帳雲系統_軟體規格書_v1.7.md §3.2.1 / §3.2.2 / §3.2.3
-- ============================================================================
--
-- 建立 3 張多租戶基礎表:
--   users          - 使用者帳號
--   books          - 帳本 (= 店, 一店一本)
--   book_members   - 帳本成員與角色
--
-- Seed admin user 與第一本帳本不在這個 migration, 改寫在 src/server.js seedAdmin()
-- 用 bcrypt 即時 hash 密碼, 避免 hardcode hash 進 SQL.
-- ============================================================================

-- ── users ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(20),
  email_verified_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ── books ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS books (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(8) UNIQUE NOT NULL,
  name VARCHAR(50) NOT NULL,
  company_name VARCHAR(100),
  tax_id VARCHAR(8),
  currency VARCHAR(3) NOT NULL DEFAULT 'TWD',
  fiscal_year_start_month INT NOT NULL DEFAULT 1
    CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  subscription_type VARCHAR(20) NOT NULL DEFAULT 'free',
  subscription_expire_at DATE,
  owner_id BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_books_owner_id ON books(owner_id);


-- ── book_members ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS book_members (
  id BIGSERIAL PRIMARY KEY,
  book_id BIGINT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL
    CHECK (role IN ('owner','admin','editor','viewer')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (book_id, user_id)
);
