-- ============================================================================
-- 014_tz_normalize.sql
-- D1 / D26：強制 postgres timezone = Asia/Taipei
-- ============================================================================

BEGIN;

-- 改 database 預設 timezone
ALTER DATABASE bookkeeping SET timezone TO 'Asia/Taipei';

-- 當前 session（migration runner 看到的）也設一下
SET timezone = 'Asia/Taipei';

COMMENT ON COLUMN journal_logs.created_at IS 'TIMESTAMPTZ; database tz = Asia/Taipei';
COMMENT ON COLUMN journal_logs.date       IS 'business_day YYYY-MM-DD (Asia/Taipei)';

COMMIT;
