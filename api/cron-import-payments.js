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
// v620: полный синк ВСЕХ месяцев по двум странам (v618) перестал укладываться в 60с —
// крон падал с 504 каждый час, свежие оплаты не доезжали в базу. Поднимаем лимит до 300с
// (Vercel допускает на всех планах), чтобы синк гарантированно дорабатывал до конца.
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  // v592 SEC: fail-closed. Раньше при незаданном CRON_SECRET эндпоинт был открыт всем (импорт платежей).
  const expected = (process.env.CRON_SECRET || '').trim();
  if (!expected) return res.status(503).json({ ok: false, error: 'CRON_SECRET не настроен' });
  const got = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (got !== expected) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const ran = [];
  for (const country of ['KZ', 'KG']) {
    try {
      // v618: monthsBack=0 — полный синк ВСЕХ месяцев. Раньше окно было 2 мес из-за таймаута
      // последовательной загрузки, но правки в старых месяцах (флаг «посажено», суммы) тогда
      // не доходили в Supabase. Теперь листы тянутся параллельно (см. importSheetsForCountry),
      // так что полный синк укладывается в maxDuration и любые изменения подхватываются.
      const r = await importSheetsForCountry(country, false, 0);
      ran.push({ country, inserted: r.inserted_count, failed: r.failed_count });
    } catch (e) {
      ran.push({ country, error: String((e && e.message) || e) });
    }
  }

  const totalInserted = ran.reduce((s, r) => s + (r.inserted || 0), 0);
  return res.status(200).json({ ok: true, total_inserted: totalInserted, ran });
}
