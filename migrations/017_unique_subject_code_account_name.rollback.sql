-- rollback for 017_unique_subject_code_account_name.sql
-- 手動執行用(migrate.js 不會跑 .rollback. 檔);跑完記得 DELETE FROM schema_migrations WHERE filename = '017_unique_subject_code_account_name.sql';
-- 不寫 BEGIN / COMMIT(B8)。

DROP INDEX IF EXISTS uniq_ag_accounts_book_name;
DROP INDEX IF EXISTS uniq_subjects_book_code;
