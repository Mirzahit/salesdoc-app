// TEMP (удалить после проверки v622): ручной запуск синка одной страны, чтобы убедиться,
// что вставка новых строк работает (та же операция, что часовой крон, идемпотентна).
// Gate: x-app-token (HEADER). ?country=KZ|KG
import { importSheetsForCountry } from './payments.js';
import { checkAuth } from './_auth.js';

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  const c = String(req.query.country || 'KZ').toUpperCase();
  if (c !== 'KZ' && c !== 'KG') return res.status(400).json({ ok: false, error: 'country KZ|KG' });
  try {
    const r = await importSheetsForCountry(c, false, 0);
    return res.status(200).json({ ok: true, country: c, result: r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
