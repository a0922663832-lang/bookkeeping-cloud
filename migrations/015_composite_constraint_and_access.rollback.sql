-- 015_composite_constraint_and_access.rollback.sql
BEGIN;

-- 還原 chk_journal_type_fields (拿掉 composite 分支)
ALTER TABLE journal_logs DROP CONSTRAINT IF EXISTS chk_journal_type_fields;
ALTER TABLE journal_logs ADD CONSTRAINT chk_journal_type_fields CHECK (
  (type = 'expense' AND transfer_out_account_id IS NOT NULL AND transfer_in_account_id IS NULL AND reclassify_from_subject_id IS NULL)
  OR (type = 'income' AND transfer_in_account_id IS NOT NULL AND transfer_out_account_id IS NULL AND reclassify_from_subject_id IS NULL)
  OR (type = 'transfer' AND transfer_out_account_id IS NOT NULL AND transfer_in_account_id IS NOT NULL AND reclassify_from_subject_id IS NULL AND transfer_out_account_id != transfer_in_account_id)
  OR (type = 'reclassify' AND transfer_out_account_id IS NULL AND transfer_in_account_id IS NULL AND reclassify_from_subject_id IS NOT NULL AND reclassify_from_subject_id != subject_id)
);

-- 刪 NEST0001 owner/admin 從 NEST0099 加進去的 row
DELETE FROM book_members
WHERE book_id = (SELECT id FROM books WHERE code = 'NEST0099')
  AND user_id != 0;

COMMIT;
