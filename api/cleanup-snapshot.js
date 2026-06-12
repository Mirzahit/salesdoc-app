// TEMP v623 (УДАЛИТЬ ПОСЛЕ ЧИСТКИ): разовое удаление строк 2026 года из старого снимка
// (sheet_id 11ErpSR…). Снимок грузился ради истории 2025; его 2026-строки задваивали
// текущую «Доходы 2026» (1WJJRqPv…) на дашборде. Скоуп ЖЁСТКО ЗАШИТ (никаких параметров
// от клиента → нечего инъектить). Gate: x-app-token (header). По умолчанию PREVIEW —
// удаляет только при ?confirm=DELETE-2026-SNAPSHOT. 2025 не трогается (paid_at >= 2026-01-01).
import { sbSelect, sbDelete } from './_supabase.js';
import { checkAuth } from './_auth.js';

const SNAPSHOT_SHEET_ID = '11ErpSR9fJ_T0ggWBrHjRB35cMs4yl84HedSO1Tf4Z08';
const FILTER = {
  country: 'eq.KZ',
  sheet_id: 'eq.' + SNAPSHOT_SHEET_ID,
  paid_at: 'gte.2026-01-01'
};

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
    const rows = await sbSelect('payments', Object.assign(
      { select: 'paid_at,amount,company_name', order: 'paid_at.asc', limit: '2000' }, FILTER
    ));
    const total = rows.length;
    const sum = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const byMonth = {};
    rows.forEach(r => { const m = (r.paid_at || '').slice(0, 7); byMonth[m] = (byMonth[m] || 0) + 1; });

    if (String(req.query.confirm || '') !== 'DELETE-2026-SNAPSHOT') {
      return res.status(200).json({
        mode: 'preview', would_delete: total, sum, by_month: byMonth,
        sample: rows.slice(0, 10).map(r => ({ paid_at: r.paid_at, amount: r.amount, company_name: r.company_name }))
      });
    }

    const deleted = await sbDelete('payments', FILTER);
    return res.status(200).json({ mode: 'deleted', deleted_count: Array.isArray(deleted) ? deleted.length : total, sum });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
