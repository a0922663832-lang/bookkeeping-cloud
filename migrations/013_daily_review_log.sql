-- ============================================================================
-- 013_daily_review_log.sql
-- A6.2 / D24：每日 auto-posted journal 的事後 ack 流程
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS daily_review_log (
  id                  BIGSERIAL PRIMARY KEY,
  book_id             BIGINT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  review_date         DATE NOT NULL,                 -- 被 review 的營業日（business_day）
  reviewed_by_user_id BIGINT REFERENCES users(id),
  reviewed_at         TIMESTAMPTZ,
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','acked','escalated')),
  journal_log_ids     JSONB NOT NULL,                 -- 例: [5832, 5833]
  total_amount        NUMERIC(14,2),                  -- 當日 auto-post 合計
  ack_note            TEXT,
  escalated_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_daily_review_log ON daily_review_log(book_id, review_date);
CREATE INDEX IF NOT EXISTS idx_daily_review_status ON daily_review_log(status) WHERE status = 'pending';

COMMIT;
