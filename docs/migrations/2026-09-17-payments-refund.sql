-- v989: статья «Возврат …» — единственная с отрицательной суммой (деньги вернули клиенту).
-- Применено в Supabase 17.09.2026 (migration payments_refund_negative_amount).
ALTER TABLE public.payments DROP CONSTRAINT payments_amount_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_amount_check
  CHECK (amount > 0 OR (amount < 0 AND lower(category_raw) LIKE 'возврат%'));
