-- ============================================================================
-- 002_core_engine.sql
-- 公司記帳雲系統 · 核心引擎 4 張表
-- 建立日期: 2026-05-11
-- 規格書: ../../Money/公司記帳雲系統_軟體規格書_v1.7.md §3.2.4 ~ §3.2.7
-- ============================================================================

-- ── ag_accounts (資金帳戶) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ag_accounts (
  id BIGSERIAL PRIMARY KEY,
  book_id BIGINT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name VARCHAR(50) NOT NULL,
  type VARCHAR(20) NOT NULL,
    -- cash / bank / digital_bank / time_deposit / investment /
    -- income_account / liability / asset / virtual
  linked_counterparty_id BIGINT,
    -- v1.4: 應付帳款/應收帳款帳戶與 counterparty 綁定。FK 加在 counterparties 表建好後
  display_order INT NOT NULL DEFAULT 0,
  initial_balance DECIMAL(15, 2) NOT NULL DEFAULT 0,
  current_balance DECIMAL(15, 2) NOT NULL DEFAULT 0,
  note TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ag_accounts_book ON ag_accounts(book_id, is_active, display_order);


-- ── subjects (收支分類 / 會計科目) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS subjects (
  id BIGSERIAL PRIMARY KEY,
  book_id BIGINT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  code VARCHAR(10),
  name VARCHAR(50) NOT NULL,
  parent_type VARCHAR(2) NOT NULL CHECK (parent_type IN ('t1', 't2', 't3', 't4', 't5')),
    -- t1=收入 / t2=成本 / t3=費用 / t4=轉帳 / t5=股東權益
  parent_id BIGINT REFERENCES subjects(id),
  display_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subjects_book_type ON subjects(book_id, parent_type, is_active);
CREATE INDEX IF NOT EXISTS idx_subjects_book_parent ON subjects(book_id, parent_id);


-- ── counterparties (收支對象) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS counterparties (
  id BIGSERIAL PRIMARY KEY,
  book_id BIGINT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  name_normalized VARCHAR(100),
    -- v1.3: 標準化名稱,vendor 字串映射比對用
  type VARCHAR(10) NOT NULL CHECK (type IN ('income', 'expense', 'both')),
  category VARCHAR(50),
  tax_id VARCHAR(8),
  contact VARCHAR(100),
  display_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_temporary BOOLEAN NOT NULL DEFAULT FALSE,
    -- v1.3: 臨時供應商旗標
  promote_count INT NOT NULL DEFAULT 0,
    -- v1.3: 累計引用次數
  auto_promote_threshold INT NOT NULL DEFAULT 5,
    -- v1.3: 升級提醒門檻
  promoted_at TIMESTAMPTZ,
    -- v1.3: 升級為正式時間戳
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_counterparties_book ON counterparties(book_id, is_active, display_order);
CREATE INDEX IF NOT EXISTS idx_counterparties_normalized ON counterparties(book_id, name_normalized, is_active);
CREATE INDEX IF NOT EXISTS idx_counterparties_temp_promote ON counterparties(book_id, is_temporary, promote_count);

-- 補上 ag_accounts.linked_counterparty_id 的 FK (counterparties 表現在建好了)
ALTER TABLE ag_accounts
  ADD CONSTRAINT fk_ag_accounts_counterparty
  FOREIGN KEY (linked_counterparty_id) REFERENCES counterparties(id);


-- ── journal_logs (記帳記錄,核心表) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS journal_logs (
  id BIGSERIAL PRIMARY KEY,
  book_id BIGINT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  type VARCHAR(10) NOT NULL CHECK (type IN ('expense', 'income', 'transfer', 'reclassify')),
  amount DECIMAL(15, 2) NOT NULL CHECK (amount > 0),
  subject_id BIGINT NOT NULL REFERENCES subjects(id),
    -- type=reclassify 時表示目標科目 (reclassify_to)
  reclassify_from_subject_id BIGINT REFERENCES subjects(id),
    -- v1.2: type=reclassify 時必填,表示原科目
  transfer_out_account_id BIGINT REFERENCES ag_accounts(id),
    -- type=expense/transfer 時必填
  transfer_in_account_id BIGINT REFERENCES ag_accounts(id),
    -- type=income/transfer 時必填
  counterparty_id BIGINT REFERENCES counterparties(id),
  summary VARCHAR(200),
  note TEXT,
  auto_journal_id BIGINT,
    -- v2 才會用 (autoJournals 表還沒建)
  correction_of_id BIGINT REFERENCES journal_logs(id),
    -- v1.5: 修正鏈,扁平結構,所有修正都指原始 journal
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),

  -- 業務規則 (規格書 §3.2.7 釘死的 type 對欄位組合)
  CONSTRAINT chk_journal_type_fields CHECK (
    (type = 'expense'
      AND transfer_out_account_id IS NOT NULL
      AND transfer_in_account_id IS NULL
      AND reclassify_from_subject_id IS NULL)
    OR
    (type = 'income'
      AND transfer_in_account_id IS NOT NULL
      AND transfer_out_account_id IS NULL
      AND reclassify_from_subject_id IS NULL)
    OR
    (type = 'transfer'
      AND transfer_out_account_id IS NOT NULL
      AND transfer_in_account_id IS NOT NULL
      AND reclassify_from_subject_id IS NULL
      AND transfer_out_account_id != transfer_in_account_id)
    OR
    (type = 'reclassify'
      AND transfer_out_account_id IS NULL
      AND transfer_in_account_id IS NULL
      AND reclassify_from_subject_id IS NOT NULL
      AND reclassify_from_subject_id != subject_id)
  )
);

CREATE INDEX IF NOT EXISTS idx_journals_book_date ON journal_logs(book_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_journals_subject ON journal_logs(book_id, subject_id, date);
CREATE INDEX IF NOT EXISTS idx_journals_out_account ON journal_logs(book_id, transfer_out_account_id, date);
CREATE INDEX IF NOT EXISTS idx_journals_in_account ON journal_logs(book_id, transfer_in_account_id, date);
CREATE INDEX IF NOT EXISTS idx_journals_counterparty ON journal_logs(book_id, counterparty_id, date);
CREATE INDEX IF NOT EXISTS idx_journals_correction ON journal_logs(correction_of_id) WHERE correction_of_id IS NOT NULL;
