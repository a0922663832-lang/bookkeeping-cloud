-- 016_reconciliation.sql
-- 記帳雲總計畫 Phase 0：對帳中心 v1（紙測 F2/F3/F10）
--
-- recon_results：每日逐事件比對結果。bucket 三分類：
--   settled    = 對平（雲端已入帳 / 已退回有交代）
--   in_transit = 在途（outbox 排隊中 / 雲端待審）— 不是差異，不告警（F10）
--   diff       = 真差異（漏排入 / 推丟 / dead）— 告警 + 可補推
--
-- repush_requests：對帳頁「補推」按鈕排入，LEO 端 cron 每 5 分鐘領取執行（F3）。

CREATE TABLE IF NOT EXISTS recon_results (
  id              SERIAL PRIMARY KEY,
  book_id         INTEGER NOT NULL REFERENCES books(id),
  recon_date      DATE NOT NULL,
  external_source TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  event_type      TEXT,
  leo_amount      NUMERIC(14,2),
  leo_status      TEXT,                          -- LEO 端 bookkeeping_status (null/pending/sending/sent/dead)
  cloud_status    TEXT NOT NULL,                 -- posted / pending_review / rejected / missing
  bucket          TEXT NOT NULL CHECK (bucket IN ('settled', 'in_transit', 'diff')),
  detail          TEXT,
  run_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (book_id, recon_date, external_source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_recon_results_date ON recon_results (book_id, recon_date, bucket);

CREATE TABLE IF NOT EXISTS repush_requests (
  id              SERIAL PRIMARY KEY,
  book_id         INTEGER NOT NULL REFERENCES books(id),
  external_source TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  requested_by    INTEGER REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'requested'
                  CHECK (status IN ('requested', 'picked', 'done', 'failed')),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  picked_at       TIMESTAMPTZ,
  done_at         TIMESTAMPTZ,
  result_note     TEXT
);

-- 同一事件同時只能有一張未完成的補推請求
CREATE UNIQUE INDEX IF NOT EXISTS idx_repush_open
  ON repush_requests (book_id, external_id)
  WHERE status IN ('requested', 'picked');
