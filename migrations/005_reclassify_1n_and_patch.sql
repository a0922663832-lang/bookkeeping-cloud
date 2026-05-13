-- ============================================================================
-- 005_reclassify_1n_and_patch.sql
-- M1 stage 1d: reclassify 1:N 映射 + journal PATCH 支援欄位
-- 建立日期: 2026-05-13
-- 規格書: 公司記帳雲系統_軟體規格書_v1.7.md §3.2.7 + v1.7 paper test M1 漏洞修補
-- ============================================================================
--
-- 場景: 訂金 500 抵「菜色 4101 / 服務費 4109 / 銷售折讓 4191」3 個科目
-- v1.7 之前的 schema 只允許 1 個 target (reclassify_to = single subject_id)
-- v1.7 拍板要支援 1 origin → N targets,每個 target 自己一份 amount
--
-- 設計:
--   journal_logs.subject_id   = 主要 target (display_order=0, 給索引 / 篩選用)
--   journal_logs.amount       = 總額 (= SUM of all target amounts when child has rows)
--   journal_reclassify_targets (新表) = N>=2 時存所有 N 筆 target 細目;
--                                       N=1 時不寫 (兼容舊資料)
--
-- 額外加: journal_logs.edited_at / edited_by_id / edit_count (PATCH 用)
-- ============================================================================

-- ── reclassify 1:N target 子表 ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS journal_reclassify_targets (
  id BIGSERIAL PRIMARY KEY,
  journal_id BIGINT NOT NULL REFERENCES journal_logs(id) ON DELETE CASCADE,
  target_subject_id BIGINT NOT NULL REFERENCES subjects(id),
  amount DECIMAL(15, 2) NOT NULL CHECK (amount > 0),
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jrt_journal ON journal_reclassify_targets(journal_id);
CREATE INDEX IF NOT EXISTS idx_jrt_subject ON journal_reclassify_targets(target_subject_id);

-- ── journal_logs PATCH 追蹤欄位 ──────────────────────────────────────
-- updated_at / updated_by 已存在,但兩者都會被 reverse 修改也動到,
-- 不能區分「真的被 PATCH 過」vs「被 reverse 動了 updated_*」
-- 加 edited_at / edit_count 來精確追蹤
ALTER TABLE journal_logs ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE journal_logs ADD COLUMN IF NOT EXISTS edited_by_id BIGINT REFERENCES users(id);
ALTER TABLE journal_logs ADD COLUMN IF NOT EXISTS edit_count INT NOT NULL DEFAULT 0;
