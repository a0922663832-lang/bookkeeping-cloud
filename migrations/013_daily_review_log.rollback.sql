-- 013_daily_review_log.rollback.sql
BEGIN;
DROP INDEX IF EXISTS idx_daily_review_status;
DROP INDEX IF EXISTS uniq_daily_review_log;
DROP TABLE IF EXISTS daily_review_log;
COMMIT;
