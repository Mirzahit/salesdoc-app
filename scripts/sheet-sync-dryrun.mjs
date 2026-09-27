// Пробный прогон сопоставления «лист Доходы ↔ база» ТОЛЬКО НА ЧТЕНИЕ (v1011, CEO 27.09.2026).
// Лист читается через скрипт Google тем же кодом, что у импорта; оплаты — из /api/payments прода.
// Ничего не пишет. Запуск:  node scripts/sheet-sync-dryrun.mjs [KG] [--show=suyor]
import { readFileSync } from 'node:fs';
try { for (const l of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch (_) {}
const { _sheetSyncInternals: X } = await import('../api/payments.js');
const { planTabSync, contentKey } = await import('../api/_sheet_sync.js');
const country = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'KG';
const show = (process.argv.find(a => a.startsWith('--show=')) || '').slice(7).toLowerCase();
const cfg = X.config[country];
const H = { 'x-app-token': 'salesdoc-2026-route-secret-9k3xJ7', 'x-user-email': 'office@salesdoc.io' };
const all = (await (await fetch('https://salesdoc-app.vercel.app/api/payments?country=' + country, { headers: H })).json()).payments;
const db = all.filter(p => p.source === 'sheets_import' && p.sheet_id === cfg.sheet_id);
const curMi = new Date().getMonth();
const total = { same: 0, moved: 0, edited: 0, inserts: 0, newlyMissing: 0, release: 0, untouched: 0 };
for (let mi = 0; mi <= curMi; mi++) {
  const tab = cfg.months[mi];
  let data; try { data = await X.fetchSheet(tab, cfg); } catch (e) { console.log(tab, 'лист не прочитался:', e.message); continue; }
  const rows = data.rows || [];
  let headerIdx = -1; for (let i = 0; i < rows.length; i++) if (rows[i] && String(rows[i][1] || '').trim() === 'Компания') { headerIdx = i; break; }
  const hdr = headerIdx >= 0 ? rows[headerIdx] : null, start = headerIdx >= 0 ? headerIdx + 1 : 4;
  const S = [], phys = new Set();
  rows.slice(start).forEach((row, idx) => { const abs = start + idx + 1; if (row && row[1] != null && String(row[1]).trim() !== '') phys.add(abs); const p = X.parseRow(row, headerIdx, hdr, cfg, tab, mi, abs); if (p) S.push(p); });
  const E = db.filter(p => p.sheet_tab === tab);
  const r = planTabSync(S, E, phys);
  const c = { same: r.pairs.filter(p => p.how === 'same').length, moved: r.pairs.filter(p => p.how === 'moved').length, edited: r.pairs.filter(p => p.how === 'edited').length, inserts: r.inserts.length, newlyMissing: r.newlyMissing.length, release: r.release.length, untouched: r.untouched.length };
  Object.keys(total).forEach(k => total[k] += c[k]);
  console.log(tab.padEnd(9), 'в листе', String(S.length).padStart(3), '| в базе', String(E.length).padStart(3), '| на месте', c.same, '| переезд', c.moved, '| правка', c.edited, '| новых', c.inserts, '| пропало', c.newlyMissing, '| не разобралась', c.untouched, r.guard ? '| ЗАЩИТА: вкладку не трогаем' : '');
  for (const p of r.pairs.filter(p => p.how !== 'same')) console.log('    ', p.how, p.e.company_name, p.e.paid_at, p.e.amount, 'строка', p.e.sheet_row, '→', p.s.sheet_row, p.how === 'edited' ? '(было ' + p.e.amount + ', стало ' + p.s.amount + ')' : '');
  for (const s of r.inserts) console.log('     новая', s.company_name, s.paid_at, s.amount, 'строка', s.sheet_row);
  for (const e of r.newlyMissing) console.log('     пропала', e.company_name, e.paid_at, e.amount, 'строка', e.sheet_row, e.receipt_path ? '(с чеком)' : '');
  if (show) { const sh = S.filter(s => String(s.company_name).toLowerCase().includes(show)); const eh = E.filter(e => String(e.company_name).toLowerCase().includes(show)); if (sh.length || eh.length) { console.log('     «' + show + '» в листе:', sh.map(s => s.sheet_row + ':' + s.paid_at + ':' + s.amount).join(', ') || '—'); console.log('     «' + show + '» в базе: ', eh.map(e => e.sheet_row + ':' + e.paid_at + ':' + e.amount).join(', ') || '—'); console.log('     итог:', r.pairs.filter(p => String(p.e.company_name).toLowerCase().includes(show)).map(p => p.how + '@' + p.s.sheet_row).join(', '), '| пропало', r.missing.filter(e => String(e.company_name).toLowerCase().includes(show)).length); } }
}
console.log('ИТОГО', JSON.stringify(total));
