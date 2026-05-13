-- ============================================================================
-- 010_system_user_and_staging.sql
-- P1 + Q6：System Bot user (id=0) + NEST0099 staging book (S5)
-- ============================================================================

BEGIN;

-- ── 1. 加 is_service_account 欄位 ────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_service_account BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 2. 插入 System Bot user (id=0 保留位) ────────────────────────────
INSERT INTO users (id, email, password_hash, name, hr_emp_id, hr_role, cloud_access, is_service_account, created_at, updated_at)
VALUES (0, 'system@bookkeeping.local', NULL, 'System Bot', NULL, 'system', 'admin', TRUE, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- ── 3. 既有 books 把 system bot 加為 admin 成員 ──────────────────────
INSERT INTO book_members (book_id, user_id, role, joined_at)
SELECT b.id, 0, 'admin', NOW()
  FROM books b
 WHERE NOT EXISTS (
   SELECT 1 FROM book_members WHERE book_id = b.id AND user_id = 0
 );

-- ── 4. 建 NEST0099 staging book ──────────────────────────────────────
INSERT INTO books (code, name, company_name, currency, owner_id, posting_mode, created_at, updated_at)
VALUES ('NEST0099', '品園 E2E 測試本', 'NEST E2E Staging', 'TWD', 0, 'auto', NOW(), NOW())
ON CONFLICT (code) DO NOTHING;

-- ── 5. NEST0099 加 System Bot 為 owner ───────────────────────────────
INSERT INTO book_members (book_id, user_id, role, joined_at)
SELECT b.id, 0, 'owner', NOW()
  FROM books b
 WHERE b.code = 'NEST0099'
   AND NOT EXISTS (
     SELECT 1 FROM book_members WHERE book_id = b.id AND user_id = 0
   );

-- ── 6. NEST0099 補 M5 用到的 subjects + accounts (WHERE NOT EXISTS) ──
DO $$
DECLARE
  staging_book_id BIGINT;
BEGIN
  SELECT id INTO staging_book_id FROM books WHERE code = 'NEST0099';
  IF staging_book_id IS NULL THEN RETURN; END IF;

  -- Subjects (id auto-allocated; WHERE NOT EXISTS by code per book)
  INSERT INTO subjects (book_id, code, name, parent_type, is_active)
  SELECT staging_book_id, code, name, parent_type, TRUE
  FROM (VALUES
    ('4101', '營業收入',      't1'),
    ('4102', 'Candy bar 收入', 't1'),
    ('4107', '外燴收入',      't1'),
    ('4109', '服務費收入',    't1'),
    ('4191', '銷售折讓',      't1'),
    ('4197', '銷貨退回(前期)','t1'),
    ('4408', '訂金收入',      't1'),
    ('6901', '其他費用',      't3')
  ) AS s(code, name, parent_type)
  WHERE NOT EXISTS (
    SELECT 1 FROM subjects WHERE book_id = staging_book_id AND code = s.code
  );

  -- ag_accounts (WHERE NOT EXISTS by name per book)
  INSERT INTO ag_accounts (book_id, name, type, current_balance, initial_balance, is_active)
  SELECT staging_book_id, name, type, 0, 0, TRUE
  FROM (VALUES
    ('現金袋',   'cash'),
    ('彰化品圓', 'virtual'),
    ('玉山銀行', 'bank')
  ) AS a(name, type)
  WHERE NOT EXISTS (
    SELECT 1 FROM ag_accounts WHERE book_id = staging_book_id AND name = a.name
  );
END $$;

COMMIT;
