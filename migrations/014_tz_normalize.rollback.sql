-- 014_tz_normalize.rollback.sql
-- 還原 postgres timezone 為 UTC（postgres 預設）
BEGIN;
ALTER DATABASE bookkeeping SET timezone TO 'UTC';
SET timezone = 'UTC';
COMMIT;
