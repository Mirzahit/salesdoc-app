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

export default async function handler(req, res) {
  // Защита от внешних curl. Vercel Cron шлёт Authorization: Bearer <CRON_SECRET>.
  const expected = (process.env.CRON_SECRET || '').trim();
  if (expected) {
    const got = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    if (got !== expected) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const ran = [];
  for (const country of ['KZ', 'KG']) {
    try {
      const r = await importSheetsForCountry(country, false);
      ran.push({ country, inserted: r.inserted_count, failed: r.failed_count });
    } catch (e) {
      ran.push({ country, error: String((e && e.message) || e) });
    }
  }

  const totalInserted = ran.reduce((s, r) => s + (r.inserted || 0), 0);
  return res.status(200).json({ ok: true, total_inserted: totalInserted, ran });
}
