-- 009_pending_audit.rollback.sql
BEGIN;
DROP INDEX IF EXISTS idx_pending_journals_approved_by;
ALTER TABLE pending_journals DROP COLUMN IF EXISTS rejected_reason;
ALTER TABLE pending_journals DROP COLUMN IF EXISTS rejected_at;
ALTER TABLE pending_journals DROP COLUMN IF EXISTS rejected_by_user_id;
ALTER TABLE pending_journals DROP COLUMN IF EXISTS approved_at;
ALTER TABLE pending_journals DROP COLUMN IF EXISTS approved_by_user_id;
COMMIT;
