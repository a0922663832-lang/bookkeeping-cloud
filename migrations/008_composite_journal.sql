-- ============================================================================
-- 008_composite_journal.sql
-- 加 composite journal type (N legs)，含 N1/P2/P13/Q11/Q15 + A6.1 觸發者識別
-- ============================================================================

BEGIN;

-- ── 1. journal_logs 加新欄位 ──────────────────────────────────────────
ALTER TABLE journal_logs ADD COLUMN IF NOT EXISTS is_composite BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE journal_logs ADD COLUMN IF NOT EXISTS reverses_id BIGINT REFERENCES journal_logs(id);
ALTER TABLE journal_logs ADD COLUMN IF NOT EXISTS original_date DATE;
COMMENT ON COLUMN journal_logs.original_date IS
  'For reverse journals, the date of the original journal being reversed. NULL for non-reverse.';

-- A6.1 / D23：webhook 觸發者識別
ALTER TABLE journal_logs ADD COLUMN IF NOT EXISTS triggered_by_external_emp_id TEXT;
ALTER TABLE journal_logs ADD COLUMN IF NOT EXISTS webhook_log_id BIGINT;
-- 暫不加 FK constraint 因 webhook_logs_inbound 存在於 003_posting 但 cross-schema 加 FK 風險高，
-- 用應用層保證一致性。

-- ── 2. type 允許 'composite' ──────────────────────────────────────────
ALTER TABLE journal_logs DROP CONSTRAINT IF EXISTS journal_logs_type_check;
ALTER TABLE journal_logs ADD CONSTRAINT journal_logs_type_check
  CHECK (type IN ('expense', 'income', 'transfer', 'reclassify', 'composite'));

-- ── 3. amount 對 composite 允許 0（純 reclassify 風 composite 場景）──
ALTER TABLE journal_logs DROP CONSTRAINT IF EXISTS journal_logs_amount_check;
ALTER TABLE journal_logs ADD CONSTRAINT journal_logs_amount_check
  CHECK (
    (is_composite = FALSE AND amount > 0) OR
    (is_composite = TRUE  AND amount >= 0)
  );

-- ── 4. journal_legs 新表 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS journal_legs (
  id              BIGSERIAL PRIMARY KEY,
  -- N1：移除 ON DELETE CASCADE；journal_logs 走 reverse pattern，禁硬刪
  journal_log_id  BIGINT NOT NULL REFERENCES journal_logs(id),
  leg_no          INT NOT NULL,
  kind            VARCHAR(10) NOT NULL CHECK (kind IN ('subject','account')),
  subject_id      BIGINT REFERENCES subjects(id),
  account_id      BIGINT REFERENCES ag_accounts(id),
  amount          NUMERIC(14,2) NOT NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (kind = 'subject' AND subject_id IS NOT NULL AND account_id IS NULL)
    OR (kind = 'account' AND account_id IS NOT NULL AND subject_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_journal_legs_journal ON journal_legs(journal_log_id);
CREATE INDEX IF NOT EXISTS idx_journal_legs_subject ON journal_legs(subject_id)
  WHERE subject_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_legs_account ON journal_legs(account_id)
  WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_journal_legs_no ON journal_legs(journal_log_id, leg_no);

-- ── 5. journal_logs 其他索引（reverses_id / triggered_by）──────────────
CREATE INDEX IF NOT EXISTS idx_journal_logs_reverses ON journal_logs(reverses_id)
  WHERE reverses_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_logs_triggered_by ON journal_logs(triggered_by_external_emp_id)
  WHERE triggered_by_external_emp_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_logs_is_composite ON journal_logs(is_composite)
  WHERE is_composite = TRUE;

-- ── 6. reverse_audit_log 表（D14）────────────────────────────────────
CREATE TABLE IF NOT EXISTS reverse_audit_log (
  id                  BIGSERIAL PRIMARY KEY,
  original_journal_id BIGINT NOT NULL REFERENCES journal_logs(id),
  reverse_journal_id  BIGINT NOT NULL REFERENCES journal_logs(id),
  reversed_by_user_id BIGINT NOT NULL REFERENCES users(id),
  reversed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reverse_audit_original ON reverse_audit_log(original_journal_id);

COMMIT;
