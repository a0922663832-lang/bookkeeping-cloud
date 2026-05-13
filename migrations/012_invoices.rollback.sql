-- 012_invoices.rollback.sql
BEGIN;
DROP INDEX IF EXISTS idx_invoices_order;
DROP INDEX IF EXISTS idx_invoices_journal;
DROP INDEX IF EXISTS idx_invoices_number;
DROP INDEX IF EXISTS idx_invoices_book_period;
DROP TABLE IF EXISTS invoices;
COMMIT;
