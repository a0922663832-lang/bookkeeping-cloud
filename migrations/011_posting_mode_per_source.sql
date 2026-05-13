-- ============================================================================
-- 011_posting_mode_per_source.sql
-- N7 + D13：posting_mode 升級為 per-source per-event_type 解析
-- ============================================================================

BEGIN;

ALTER TABLE books ADD COLUMN IF NOT EXISTS posting_mode_per_source JSONB NOT NULL DEFAULT '{}'::jsonb;

-- D13 細化：NEST0001 production 預設
UPDATE books SET posting_mode_per_source = '{
  "leo_pos":     { "pos_shift_settled": "auto",  "pos_deposit_offset": "review" },
  "leo_expense": "review"
}'::jsonb
WHERE code = 'NEST0001'
  AND posting_mode_per_source = '{}'::jsonb;

-- NEST0099 staging 全 auto 加速測試
UPDATE books SET posting_mode_per_source = '{
  "leo_pos":     { "pos_shift_settled": "auto",  "pos_deposit_offset": "auto" },
  "leo_expense": "auto"
}'::jsonb
WHERE code = 'NEST0099'
  AND posting_mode_per_source = '{}'::jsonb;

COMMIT;
