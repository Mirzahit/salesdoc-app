// ВРЕМЕННЫЙ эндпоинт (v624) — разовая чистка фантомов через importSheetsForCountry.
// Гейт: x-app-token (публичный) + confirm-строка для apply. УДАЛИТЬ после операции.
// GET /api/sync-cleanup?country=KZ              → dry-run (показывает will_delete)
// GET /api/sync-cleanup?country=KZ&apply=YES-DELETE-PHANTOMS-624 → реальная чистка
import { importSheetsForCountry } from './payments.js';

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  const tok = String(req.headers['x-app-token'] || '').trim();
  if (tok !== 'salesdoc-2026-route-secret-9k3xJ7') {
    return res.status(401).json({ ok: false, error: 'bad token' });
  }
  const country = String(req.query.country || 'KZ').toUpperCase();
  const apply = String(req.query.apply || '') === 'YES-DELETE-PHANTOMS-624';
  if (apply) process.env.SYNC_DELETE_ORPHANS = '1';
  try {
    const r = await importSheetsForCountry(country, !apply, 0);
    return res.status(200).json({ mode: apply ? 'APPLY' : 'DRY_RUN', country, result: r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
