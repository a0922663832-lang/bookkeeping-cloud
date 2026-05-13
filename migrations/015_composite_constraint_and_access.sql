-- ============================================================================
-- 015_composite_constraint_and_access.sql
-- 修正 chk_journal_type_fields 允許 composite type；NEST0099 staging 開放給
-- NEST0001 owner/admin 一同存取（便於 smoke test）
-- ============================================================================

BEGIN;

-- ── 1. 放寬 chk_journal_type_fields 加上 composite 分支 ─────────────
ALTER TABLE journal_logs DROP CONSTRAINT IF EXISTS chk_journal_type_fields;
ALTER TABLE journal_logs ADD CONSTRAINT chk_journal_type_fields CHECK (
  (type = 'expense'
    AND transfer_out_account_id IS NOT NULL
    AND transfer_in_account_id IS NULL
    AND reclassify_from_subject_id IS NULL
    AND is_composite = FALSE)
  OR
  (type = 'income'
    AND transfer_in_account_id IS NOT NULL
    AND transfer_out_account_id IS NULL
    AND reclassify_from_subject_id IS NULL
    AND is_composite = FALSE)
  OR
  (type = 'transfer'
    AND transfer_out_account_id IS NOT NULL
    AND transfer_in_account_id IS NOT NULL
    AND reclassify_from_subject_id IS NULL
    AND transfer_out_account_id != transfer_in_account_id
    AND is_composite = FALSE)
  OR
  (type = 'reclassify'
    AND transfer_out_account_id IS NULL
    AND transfer_in_account_id IS NULL
    AND reclassify_from_subject_id IS NOT NULL
    AND reclassify_from_subject_id != subject_id
    AND is_composite = FALSE)
  OR
  (type = 'composite'
    AND is_composite = TRUE
    AND transfer_out_account_id IS NULL
    AND transfer_in_account_id IS NULL
    AND reclassify_from_subject_id IS NULL)
);

-- ── 2. 把 NEST0001 所有 owner/admin/editor 加進 NEST0099 ───────────
INSERT INTO book_members (book_id, user_id, role, joined_at)
SELECT
  (SELECT id FROM books WHERE code = 'NEST0099') AS book_id,
  bm.user_id,
  bm.role,
  NOW()
FROM book_members bm
JOIN books b ON b.id = bm.book_id
WHERE b.code = 'NEST0001'
  AND bm.role IN ('owner', 'admin', 'editor')
  AND NOT EXISTS (
    SELECT 1 FROM book_members bm2
    JOIN books b2 ON b2.id = bm2.book_id
    WHERE b2.code = 'NEST0099' AND bm2.user_id = bm.user_id
  );

COMMIT;
