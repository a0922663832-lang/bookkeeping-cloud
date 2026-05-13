-- ============================================================================
-- 012_invoices.sql
-- B3 / D25：發票對應表，invoice_number nullable 給未來電子發票
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS invoices (
  id                BIGSERIAL PRIMARY KEY,
  book_id           BIGINT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  journal_log_id    BIGINT REFERENCES journal_logs(id),
  external_order_id TEXT,                            -- POS orders.id 反查用
  external_source   TEXT NOT NULL DEFAULT 'leo_pos',
  invoice_number    TEXT,                            -- B3 nullable，手開期間 NULL
  invoice_period    CHAR(6),                         -- YYYYMM (申報期別)
  amount            NUMERIC(14,2) NOT NULL,
  customer_tax_id   VARCHAR(10),                     -- 統編 (8碼) 或 自然人 NULL
  is_void           BOOLEAN NOT NULL DEFAULT FALSE,
  void_at           TIMESTAMPTZ,
  void_reason       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_book_period ON invoices(book_id, invoice_period);
CREATE INDEX IF NOT EXISTS idx_invoices_number ON invoices(book_id, invoice_number)
  WHERE invoice_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_journal ON invoices(journal_log_id)
  WHERE journal_log_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices(external_source, external_order_id);

COMMENT ON COLUMN invoices.invoice_number IS
  'NULL 期間 = 手開發票，會計師依靠 amount + external_order_id 對 POS 報表手動申報；未來電子發票上線填入';

COMMIT;
