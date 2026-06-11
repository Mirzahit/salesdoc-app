// /api/cron-import-payments — авто-синхронизация платежей Google Sheets → Supabase.
// Дёргается Vercel Cron по расписанию из vercel.json. Прогоняет реальный импорт
// (dry_run=0) для KZ и KG: новые строки из листов доходов попадают в Supabase,
// откуда их читает дашборд (/api/payments). Дубли исключены уникальным индексом
// payments_sheet_uniq (country, sheet_id, sheet_tab, sheet_row).
//
// Зачем: дашборд с v551 читает платежи только из Supabase, а оплаты вносятся в
// Sheets вручную. Без этого крона новые оплаты не видны до ручного импорта.
//
// ENV: CRON_SECRET (защита от внешних curl; Vercel Cron шлёт его автоматически).

import { importSheetsForCountry } from './payments.js';

// Импорт тянет листы из медленного Apps Script — без этого функция обрывалась по
// дефолтному таймауту, не дойдя до вставки новых строк (Supabase замерзал — v594).
// v620: пробуем поднять лимит до 300с. ВАЖНО: на текущем плане Vercel этот потолок
// клампится до 60с (проверено — крон с config:300 всё равно падал с 504), поэтому
// реальное спасение — синк ПО ОДНОЙ стране за запуск (см. handler ниже), а не лимит.
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  // v592 SEC: fail-closed. Раньше при незаданном CRON_SECRET эндпоинт был открыт всем (импорт платежей).
  const expected = (process.env.CRON_SECRET || '').trim();
  if (!expected) return res.status(503).json({ ok: false, error: 'CRON_SECRET не настроен' });
  const got = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (got !== expected) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  // v620: ДВЕ страны за один запуск (полный синк всех месяцев, v618) не укладывались в
  // 60с — крон падал с 504 каждый час, свежие оплаты вообще не доезжали (узкое место —
  // загрузка 12 листов из медленного Apps Script параллельно). Один полный синк страны
  // в лимит влезает (как ручной импорт, которым сеяли 2025). Поэтому синкаем ПО ОДНОЙ
  // стране за запуск, чередуя по чётности часа: чётный час → KZ, нечётный → KG.
  // Минус: каждая страна обновляется раз в 2 часа (приемлемо для BI-дашборда оплат).
  const country = (new Date().getUTCHours() % 2 === 0) ? 'KZ' : 'KG';
  const ran = [];
  try {
    // monthsBack=0 — полный синк всех месяцев одной страны (правки в старых месяцах —
    // флаг «посажено», суммы — тоже подхватываются, цель v618 сохранена).
    const r = await importSheetsForCountry(country, false, 0);
    ran.push({ country, inserted: r.inserted_count, updated: r.updated_count, failed: r.failed_count });
  } catch (e) {
    ran.push({ country, error: String((e && e.message) || e) });
  }

  const totalInserted = ran.reduce((s, r) => s + (r.inserted || 0), 0);
  return res.status(200).json({ ok: true, country, total_inserted: totalInserted, ran });
}
