-- 2026-09-14 (v964) — теги клиентов на сервере. Раньше жили в localStorage браузера каждого
-- оператора (crm_client_tags) — у каждого своя картина, CEO не видел ничего.
-- Ключ — client_id (не имя), теги видны всем. Применено к проду через MCP apply_migration.

CREATE TABLE IF NOT EXISTS client_tags (
  client_id  TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,                       -- risk | problem | working | ok | произвольный
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_client_tags_tag ON client_tags (tag);

-- Автопауза: настройка в app_settings (key='autopause', value={"enabled":false,"days":30}).
-- Пока enabled=false — крон только считает кандидатов и ничего не меняет.
INSERT INTO app_settings (key, value)
VALUES ('autopause', '{"enabled": false, "days": 30}'::jsonb)
ON CONFLICT (key) DO NOTHING;
