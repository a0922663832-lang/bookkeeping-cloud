-- ============================================================================
-- 010_system_user_and_staging.sql
-- P1 + Q6：System Bot user (id=0) + NEST0099 staging book (S5)
-- ============================================================================

BEGIN;

-- ── 1. 加 is_service_account 欄位以區分 system bot vs 真人 ─────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_service_account BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 2. 插入 System Bot user (id=0 保留位) ────────────────────────────
-- 注意：BIGSERIAL 從 1 起算，明確 INSERT id=0 不會與後續衝突
INSERT INTO users (id, email, password_hash, name, hr_emp_id, hr_role, cloud_access, is_service_account, created_at, updated_at)
VALUES (0, 'system@bookkeeping.local', NULL, 'System Bot', NULL, 'system', 'admin', TRUE, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- ── 3. 既有 books 把 system bot 加為 admin 成員 ──────────────────────
INSERT INTO book_members (book_id, user_id, role, created_at)
SELECT b.id, 0, 'admin', NOW()
  FROM books b
 WHERE NOT EXISTS (
   SELECT 1 FROM book_members WHERE book_id = b.id AND user_id = 0
 );

-- ── 4. 建 NEST0099 staging book (S5) ──────────────────────────────────
-- owner_id 用 System Bot (id=0)
INSERT INTO books (code, name, company_name, currency, owner_id, posting_mode, created_at, updated_at)
VALUES ('NEST0099', '品園 E2E 測試本', 'NEST E2E Staging', 'TWD', 0, 'auto', NOW(), NOW())
ON CONFLICT (code) DO NOTHING;

-- ── 5. NEST0099 也加 System Bot 成員（如尚未加）──────────────────────
INSERT INTO book_members (book_id, user_id, role, created_at)
SELECT b.id, 0, 'owner', NOW()
  FROM books b
 WHERE b.code = 'NEST0099'
   AND NOT EXISTS (
     SELECT 1 FROM book_members WHERE book_id = b.id AND user_id = 0
   );

-- ── 6. NEST0099 補基本 seed (24 subjects + 4 accounts) ────────────────
-- 為了 idempotency，採用 ON CONFLICT 並依 NEST0001 種子的 minimal 子集
-- 完整 seed 由應用層 seedDefaultSubjectsAndAccounts(book_id) 處理；
-- 此處僅補 M5 用到的關鍵 subject/account 確保 staging 可立刻測

DO $$
DECLARE
  staging_book_id BIGINT;
BEGIN
  SELECT id INTO staging_book_id FROM books WHERE code = 'NEST0099';
  IF staging_book_id IS NOT NULL THEN
    -- 關鍵 subjects (M5 用)
    INSERT INTO subjects (book_id, code, name, parent_type, is_active, created_at, updated_at) VALUES
      (staging_book_id, '4101', '營業收入',      't1', TRUE, NOW(), NOW()),
      (staging_book_id, '4102', 'Candy bar 收入', 't1', TRUE, NOW(), NOW()),
      (staging_book_id, '4107', '外燴收入',      't1', TRUE, NOW(), NOW()),
      (staging_book_id, '4109', '服務費收入',    't1', TRUE, NOW(), NOW()),
      (staging_book_id, '4191', '銷售折讓',      't1', TRUE, NOW(), NOW()),
      (staging_book_id, '4197', '銷貨退回(前期)','t1', TRUE, NOW(), NOW()),
      (staging_book_id, '4408', '訂金收入',      't1', TRUE, NOW(), NOW()),
      (staging_book_id, '6901', '其他費用',      't3', TRUE, NOW(), NOW())
    ON CONFLICT (book_id, code) DO NOTHING;

    -- 關鍵 accounts (M5 用)
    INSERT INTO ag_accounts (book_id, name, type, current_balance, initial_balance, is_active, created_at, updated_at) VALUES
      (staging_book_id, '現金袋',     'cash',    0, 0, TRUE, NOW(), NOW()),
      (staging_book_id, '彰化品圓',   'virtual', 0, 0, TRUE, NOW(), NOW()),
      (staging_book_id, '玉山銀行',   'bank',    0, 0, TRUE, NOW(), NOW())
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
