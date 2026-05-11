-- ============================================================================
-- 004_hardening.sql
-- M1 stage 1c (journal reverse) + M3 stage 1b (HMAC + webhook log).
-- ============================================================================

-- M1 stage 1c: journal 反向沖銷追蹤 (DELETE = create reverse row, not hard delete)
ALTER TABLE journal_logs ADD COLUMN IF NOT EXISTS reverses_id BIGINT REFERENCES journal_logs(id);
ALTER TABLE journal_logs ADD COLUMN IF NOT EXISTS reversed_by_id BIGINT REFERENCES journal_logs(id);

CREATE INDEX IF NOT EXISTS idx_journals_reverses
  ON journal_logs(reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journals_reversed_by
  ON journal_logs(reversed_by_id) WHERE reversed_by_id IS NOT NULL;


-- M3 stage 1b: webhook 入站 log (audit + debug, every /internal/posting hit recorded)
CREATE TABLE IF NOT EXISTS webhook_logs_inbound (
  id BIGSERIAL PRIMARY KEY,
  book_id BIGINT REFERENCES books(id) ON DELETE CASCADE,
  external_source VARCHAR(30),
  event_id VARCHAR(100),
  request_path VARCHAR(255),
  request_headers JSONB,
  request_body JSONB,
  response_status INT,
  response_body JSONB,
  hmac_valid BOOLEAN,
  client_ip VARCHAR(45),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_book_src
  ON webhook_logs_inbound(book_id, external_source, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_received
  ON webhook_logs_inbound(received_at DESC);
