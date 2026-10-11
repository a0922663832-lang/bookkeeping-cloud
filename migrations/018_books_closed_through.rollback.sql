-- rollback for 018_books_closed_through.sql
-- 手動執行用(migrate.js 不會跑 .rollback. 檔);跑完記得 DELETE FROM schema_migrations WHERE filename = '018_books_closed_through.sql';
-- ⚠ 先把程式退回 0.15.0 再跑(新程式每個記帳入口都會讀這個欄位,欄位不在會整個 500)。
-- 不寫 BEGIN / COMMIT(B8)。

ALTER TABLE books DROP COLUMN IF EXISTS closed_through;
