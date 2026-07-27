-- v825: чек (скрин перевода) у оплаты — путь к файлу в приватном бакете payment-receipts.
-- Применено через Supabase MCP 27.07.2026.
alter table payments add column if not exists receipt_path text;

-- приватный бакет для чеков (public=false; доступ только через service key + signed URL)
insert into storage.buckets (id, name, public)
values ('payment-receipts', 'payment-receipts', false)
on conflict (id) do nothing;
