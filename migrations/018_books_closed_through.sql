-- 018_books_closed_through.sql
-- 2026-10-11 記帳雲第二輪 §4.8 / Y26:關帳。LEO 10/11 拍板「都修」(含加這個欄位)。
-- closed_through = 這天(含)以前的帳不能再動;NULL = 沒關帳(預設,部署後線上全部是 NULL)。
-- 只有老闆能在設定頁改(src/routes/books.js PATCH /B/:code);擋點在 src/routes/posting.js assertNotClosed。
--
-- 不寫 BEGIN / COMMIT:src/migrate.js 會自己包 transaction(B8)。
-- rollback 檔(018_*.rollback.sql)被 migrate.js 的 `.rollback.` 過濾掉,不會被當正向 migration 跑。

ALTER TABLE books ADD COLUMN IF NOT EXISTS closed_through DATE;
