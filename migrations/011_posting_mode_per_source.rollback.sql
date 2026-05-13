-- 011_posting_mode_per_source.rollback.sql
BEGIN;
ALTER TABLE books DROP COLUMN IF EXISTS posting_mode_per_source;
COMMIT;
