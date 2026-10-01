// v817: «сегодня» на сервере считалось по Гринвичу — ночью с 00:00 до 05:00 по Алматы
// дата уезжала на вчера (оплаты, сделки, фильтр биллинга). Считаем календарную дату
// в GMT+5; в Казахстане и Кыргызстане перевода часов нет, сдвиг фиксированный.
export function almatyIso(ms) {
  return new Date((ms || Date.now()) + 5 * 3600 * 1000).toISOString().slice(0, 10);
}

// v1015: у Кыргызстана свой пояс — UTC+6 (Бишкек), у Казахстана UTC+5. Маркетинг KG
// считал дни по Алматы, и заявки с 23:00 до 24:00 по Бишкеку падали на следующий день.
// Перевода часов нет ни там, ни там — сдвиг фиксированный.
export const TZ_OFFSET_H = { KG: 6, KZ: 5 };
export function tzOffsetH(country) {
  const c = String(country || 'KG').toUpperCase();
  return TZ_OFFSET_H[c] != null ? TZ_OFFSET_H[c] : 6;
}
// Календарная дата (YYYY-MM-DD) момента ms в поясе страны.
export function localIso(ms, country) {
  const t = (ms == null || ms === '') ? Date.now() : Number(ms);
  return new Date(t + tzOffsetH(country) * 3600 * 1000).toISOString().slice(0, 10);
}
export function bishkekIso(ms) { return localIso(ms, 'KG'); }
function _offStr(country) { const h = tzOffsetH(country); return (h >= 0 ? '+' : '-') + String(Math.abs(h)).padStart(2, '0') + ':00'; }
// Начало дня iso в поясе страны (мс UTC).
export function dayStartMs(iso, country) { return Date.parse(String(iso).slice(0, 10) + 'T00:00:00' + _offStr(country)); }
// Конец дня — начало следующего (не включительно).
export function dayEndMs(iso, country) { return dayStartMs(addDaysIso(iso, 1), country); }
export function addDaysIso(iso, n) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + (Number(n) || 0) * 86400000).toISOString().slice(0, 10);
}
export function monthStartIso(country) { return localIso(Date.now(), country).slice(0, 8) + '01'; }

// v1015: для рекламного кабинета в чужом поясе (America/Los_Angeles, с переводом часов).
// Сдвиг пояса timeZone относительно UTC в минутах в момент utcMs (PDT → -420, PST → -480).
const _fmtCache = new Map();
function _fmt(timeZone) {
  let f = _fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    _fmtCache.set(timeZone, f);
  }
  return f;
}
export function zonedParts(timeZone, utcMs) {
  const p = {};
  _fmt(timeZone).formatToParts(new Date(utcMs)).forEach(x => { if (x.type !== 'literal') p[x.type] = Number(x.value); });
  if (p.hour === 24) p.hour = 0;
  return p; // {year, month(1-12), day, hour, minute, second}
}
export function tzOffsetMinAt(timeZone, utcMs) {
  const p = zonedParts(timeZone, utcMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}
// Местное время (y, m 1-12, d, h) в поясе timeZone → мс UTC. Два прохода — из-за перевода часов.
export function zonedToUtcMs(timeZone, y, m, d, h) {
  const guess = Date.UTC(y, m - 1, d, h || 0);
  const off1 = tzOffsetMinAt(timeZone, guess);
  let t = guess - off1 * 60000;
  const off2 = tzOffsetMinAt(timeZone, t);
  if (off2 !== off1) t = guess - off2 * 60000;
  return t;
}
// Местная дата момента utcMs в поясе timeZone.
export function zonedIso(timeZone, utcMs) {
  const p = zonedParts(timeZone, utcMs);
  return p.year + '-' + String(p.month).padStart(2, '0') + '-' + String(p.day).padStart(2, '0');
}
