-- v1011: оплата пропала из листа «Доходы» — импорт её больше не удаляет, а ставит время пропажи.
-- Применено в Supabase 27.09.2026 16:00 (Бишкек), migration payments_sheet_missing_at, после «ок» CEO.
-- Только добавляет колонку; от неё зависит код v1011 (api/payments.js импорт, api/_finansist_core.js loadBase).
alter table public.payments add column if not exists sheet_missing_at timestamptz;
comment on column public.payments.sheet_missing_at is 'Когда строка пропала из листа «Доходы». null — строка на месте';
