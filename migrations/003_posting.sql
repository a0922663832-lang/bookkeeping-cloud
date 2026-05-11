-- ============================================================================
-- 003_posting.sql
-- M3 stage 1a: webhook 接收 + Pending Review.
-- 規格書: 公司記帳雲系統_軟體規格書_v1.7.md §5.9 (保守模式) + 金流整合規格書 v1.7 §4
-- ============================================================================
--
-- 加給 journal_logs:
--   external_source / external_id  整合來源識別 (leo_invoice, leo_pos, inline_xxx, ...)
--   is_auto_posted                  是否由 webhook 自動入帳 (vs 手動 POST /journals)
--
-- 加給 books:
--   posting_mode                    auto / review / manual (預設 review 上線首月用)
--
-- 新表:
--   pending_journals                review 模式下待審入帳事件
-- ============================================================================

-- ── journal_logs 加整合欄位 ──────────────────────────────────────────
ALTER TABLE journal_logs ADD COLUMN IF NOT EXISTS external_source VARCHAR(30);
ALTER TABLE journal_logs ADD COLUMN IF NOT EXISTS external_id VARCHAR(100);
ALTER TABLE journal_logs ADD COLUMN IF NOT EXISTS is_auto_posted BOOLEAN NOT NULL DEFAULT FALSE;

-- 冪等用 unique: 同一 book 內 (external_source, external_id) 唯一
CREATE UNIQUE INDEX IF NOT EXISTS uq_journals_external
  ON journal_logs(book_id, external_source, external_id)
  WHERE external_source IS NOT NULL AND external_id IS NOT NULL;


-- ── books 加 posting_mode ────────────────────────────────────────────
ALTER TABLE books ADD COLUMN IF NOT EXISTS posting_mode VARCHAR(10) NOT NULL DEFAULT 'review';

-- 加 CHECK constraint (用 DO block 因為 ALTER TABLE ... ADD CONSTRAINT 沒有 IF NOT EXISTS)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_books_posting_mode'
  ) THEN
    ALTER TABLE books ADD CONSTRAINT chk_books_posting_mode
      CHECK (posting_mode IN ('auto', 'review', 'manual'));
  END IF;
END $$;


-- ── pending_journals 表 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_journals (
  id BIGSERIAL PRIMARY KEY,
  book_id BIGINT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  external_source VARCHAR(30) NOT NULL,
  external_id VARCHAR(100) NOT NULL,
  event_id VARCHAR(100),
    -- 來源系統的 event 識別 (webhook 重試冪等用)
  payload JSONB NOT NULL,
    -- 原始 payload (含完整事件資料,審計用)
  proposed_journal JSONB NOT NULL,
    -- 待寫入 journal_logs 的標準化內容 (type / date / amount / subject_id / ...)
  status VARCHAR(15) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'auto_posted')),
  reviewed_by BIGINT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  resulting_journal_id BIGINT REFERENCES journal_logs(id),
    -- approved 後寫入的 journal id
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 冪等: 同 book 內 (external_source, external_id) 唯一 (含已 reject 的也算)
  UNIQUE (book_id, external_source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_journals_book_status
  ON pending_journals(book_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pending_journals_event
  ON pending_journals(event_id) WHERE event_id IS NOT NULL;
