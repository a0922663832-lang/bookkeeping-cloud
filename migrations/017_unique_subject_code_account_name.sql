-- 017_unique_subject_code_account_name.sql
-- 2026-10-10 記帳雲重掃 Y18 / LEO 拍板 7:科目代碼、帳戶名稱同一本帳不准重複。
-- 推送(POS 收班、訂金、薪資…)靠代碼 / 名稱找主檔,重複時會隨便挑一筆 → 報表對不起來。
-- 程式(src/routes/lookups.js)先擋並給白話訊息;這裡是最後防線。
--
-- ⚠ 部署前一定要先查線上有沒有已經重複的(施工計畫 §4.6 STOP gate):
--   SELECT book_id, code, COUNT(*) FROM subjects WHERE code IS NOT NULL AND code <> '' GROUP BY 1,2 HAVING COUNT(*) > 1;
--   SELECT book_id, name, COUNT(*) FROM ag_accounts GROUP BY 1,2 HAVING COUNT(*) > 1;
--   有任何一列 → 這支 migration 會失敗 → app 起不來。先請 LEO 決定改哪一筆,0 列才部署。
--
-- 不寫 BEGIN / COMMIT:src/migrate.js 會自己包 transaction(B8)。
-- rollback 檔(017_*.rollback.sql)被 migrate.js 的 `.rollback.` 過濾掉,不會被當正向 migration 跑。

CREATE UNIQUE INDEX IF NOT EXISTS uniq_subjects_book_code
  ON subjects (book_id, code)
  WHERE code IS NOT NULL AND code <> '';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_ag_accounts_book_name
  ON ag_accounts (book_id, name);
