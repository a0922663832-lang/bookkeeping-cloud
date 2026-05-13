-- ============================================================================
-- 009_pending_audit.sql
-- 加 pending_journals 的 audit trail (S7)
-- ============================================================================

BEGIN;

ALTER TABLE pending_journals ADD COLUMN IF NOT EXISTS approved_by_user_id BIGINT REFERENCES users(id);
ALTER TABLE pending_journals ADD COLUMN IF NOT EXISTS approved_at         TIMESTAMPTZ;
ALTER TABLE pending_journals ADD COLUMN IF NOT EXISTS rejected_by_user_id BIGINT REFERENCES users(id);
ALTER TABLE pending_journals ADD COLUMN IF NOT EXISTS rejected_at         TIMESTAMPTZ;
ALTER TABLE pending_journals ADD COLUMN IF NOT EXISTS rejected_reason     TEXT;

CREATE INDEX IF NOT EXISTS idx_pending_journals_approved_by ON pending_journals(approved_by_user_id)
  WHERE approved_by_user_id IS NOT NULL;

COMMIT;
