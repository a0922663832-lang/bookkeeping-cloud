-- ============================================================================
-- 006_hr_sso.sql
-- HR SSO: 把 users 表改造成「HR employees 的 shadow」
-- 建立日期: 2026-05-13
-- 規格: ~/.claude/plans/drifting-toasting-corbato.md (決策 #1 + #2)
-- ============================================================================
--
-- 改造:
--   1. 新增 hr_emp_id (HR employees.emp_id 的對應)
--   2. 新增 hr_role / cloud_access 兩個 cache 欄 (每次 login 從 HR 拉新值)
--   3. password_hash / email 改 nullable (HR-sourced user 沒密碼)
--   4. 加 partial unique index 確保同 emp_id 只有一筆
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS hr_emp_id VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS hr_role VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS cloud_access VARCHAR(10);

-- password_hash 改 nullable (HR-sourced 不存 PIN 到雲端)
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- email 改 nullable (HR 員工沒人會註冊 email)
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

-- partial unique: 同 hr_emp_id 只能有一筆 (nullable 不受影響)
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_hr_emp_id
  ON users(hr_emp_id) WHERE hr_emp_id IS NOT NULL;

-- 加 cloud_access CHECK constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_cloud_access'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT chk_users_cloud_access
      CHECK (cloud_access IS NULL OR cloud_access IN ('none','viewer','editor','admin','owner'));
  END IF;
END $$;
