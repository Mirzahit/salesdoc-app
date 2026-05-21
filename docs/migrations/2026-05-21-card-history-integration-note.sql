-- 2026-05-21 (третья миграция дня)
-- Расширяем CHECK constraint event_type в card_history — добавляем 'integration_note'.
-- Без этого комментарии от интеграторов не могут попасть в общую ленту истории клиента.

ALTER TABLE card_history DROP CONSTRAINT IF EXISTS card_history_event_type_check;
ALTER TABLE card_history ADD CONSTRAINT card_history_event_type_check
  CHECK (event_type IN ('call','whatsapp','note','stage_change','file','system','integration_note'));
