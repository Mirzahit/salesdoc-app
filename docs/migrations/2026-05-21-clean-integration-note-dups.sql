-- 2026-05-21 (четвёртая миграция дня)
-- Чистка дублей в card_history. Аналитик нашёл что для 3 интеграций в card_history
-- создались по 2 одинаковые записи integration_note вместо одной (backfill отработал
-- дважды по части записей). Этот SQL оставляет самую раннюю запись в каждой группе
-- (по attachment_url) и удаляет остальные.
--
-- БЕЗОПАСНО: удаляет только записи с event_type='integration_note' и
-- attachment_url начинающимся на 'integration:'. Никакие другие события не трогаются.

DELETE FROM card_history
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY attachment_url ORDER BY created_at) AS rn
    FROM card_history
    WHERE event_type = 'integration_note'
      AND attachment_url LIKE 'integration:%'
  ) sub
  WHERE rn > 1
);

-- Проверка после чистки: должна вернуться единичная цифра, равная числу интеграций
-- с комментарием. Сейчас должно быть 11.
-- SELECT COUNT(*) FROM card_history WHERE event_type = 'integration_note';
