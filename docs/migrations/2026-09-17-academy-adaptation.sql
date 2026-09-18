-- v992: курс «Адаптация менеджера по продажам» в Академии.
-- Урок получает готовую разметку (body_html), ссылки на оригиналы, свой порог теста
-- (экзамен = 100) и лист ознакомления; модуль — вводный текст и зачёт дня с наставником
-- (пока только текст; состояния зачёта — следующий релиз); прогресс — отметку ознакомления.
-- Контент заливается отдельными файлами 2026-09-17-academy-adaptation-content-dN.sql,
-- которые генерирует docs/migrations/gen-academy-adaptation.mjs.

ALTER TABLE academy_lessons
  ADD COLUMN IF NOT EXISTS body_html  TEXT,
  ADD COLUMN IF NOT EXISTS links      JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS pass_score INT,
  ADD COLUMN IF NOT EXISTS ack_text   TEXT;

ALTER TABLE academy_modules
  ADD COLUMN IF NOT EXISTS gate  JSONB,
  ADD COLUMN IF NOT EXISTS intro TEXT;

ALTER TABLE academy_progress
  ADD COLUMN IF NOT EXISTS ack_at TIMESTAMPTZ;

INSERT INTO academy_courses (id, sort, title, subtitle, audience, roles, active) VALUES
 ('c0000000-0000-0000-0000-000000000002', 20, 'Адаптация менеджера по продажам',
  '7 дней: регламенты, продукт, скрипты, экзамен', 'Новые менеджеры и РОП', '["manager","rop"]'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title, subtitle = EXCLUDED.subtitle, audience = EXCLUDED.audience,
  roles = EXCLUDED.roles, active = EXCLUDED.active;
