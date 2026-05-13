-- 008_composite_journal.rollback.sql
-- Forward 對應 008_composite_journal.sql
-- WARNING: 已有 production composite journal / reverse_audit_log 資料時不可執行；
--   要降版需先 export → rollback → restore，見 docs/migration_downgrade_sop.md

BEGIN;

DROP TABLE IF EXISTS reverse_audit_log;
DROP INDEX IF EXISTS idx_journal_logs_is_composite;
DROP INDEX IF EXISTS idx_journal_logs_triggered_by;
DROP INDEX IF EXISTS idx_journal_logs_reverses;
DROP INDEX IF EXISTS uniq_journal_legs_no;
DROP INDEX IF EXISTS idx_journal_legs_account;
DROP INDEX IF EXISTS idx_journal_legs_subject;
DROP INDEX IF EXISTS idx_journal_legs_journal;
DROP TABLE IF EXISTS journal_legs;

-- 還原 amount / type constraint
ALTER TABLE journal_logs DROP CONSTRAINT IF EXISTS journal_logs_amount_check;
ALTER TABLE journal_logs ADD CONSTRAINT journal_logs_amount_check CHECK (amount > 0);
ALTER TABLE journal_logs DROP CONSTRAINT IF EXISTS journal_logs_type_check;
ALTER TABLE journal_logs ADD CONSTRAINT journal_logs_type_check
  CHECK (type IN ('expense', 'income', 'transfer', 'reclassify'));

ALTER TABLE journal_logs DROP COLUMN IF EXISTS webhook_log_id;
ALTER TABLE journal_logs DROP COLUMN IF EXISTS triggered_by_external_emp_id;
ALTER TABLE journal_logs DROP COLUMN IF EXISTS original_date;
ALTER TABLE journal_logs DROP COLUMN IF EXISTS reverses_id;
ALTER TABLE journal_logs DROP COLUMN IF EXISTS is_composite;

COMMIT;
