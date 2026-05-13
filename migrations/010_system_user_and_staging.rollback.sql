-- 010_system_user_and_staging.rollback.sql
-- WARNING: 若 NEST0099 已有 journal_logs / journal_legs 等 production 資料，先 export 再 rollback
BEGIN;

-- 刪 NEST0099 相關 book_members + book
DELETE FROM book_members WHERE book_id IN (SELECT id FROM books WHERE code = 'NEST0099');
DELETE FROM ag_accounts  WHERE book_id IN (SELECT id FROM books WHERE code = 'NEST0099');
DELETE FROM subjects     WHERE book_id IN (SELECT id FROM books WHERE code = 'NEST0099');
DELETE FROM books        WHERE code = 'NEST0099';

-- 刪 system bot 從所有 books 成員
DELETE FROM book_members WHERE user_id = 0;

-- 刪 System Bot user
DELETE FROM users WHERE id = 0;

ALTER TABLE users DROP COLUMN IF EXISTS is_service_account;

COMMIT;
