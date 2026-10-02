import './_preview_guard.js'; // v1017: в превью-сборке запись наружу отключена (см. файл)
// v1015: один разбор телефона на весь сервер. Раньше в amo.js жило четыре копии,
// и все под Казахстан: кыргызский номер 996… (12 цифр) обрезался до 11, а «0555…»
// превращался в «70555…». Теперь оба формата:
//   полный международный (принимается при любой стране): 996 + 9 цифр, 7 + 10 цифр;
//   местные формы — только своей страны (countryHint):
//     KG: «0555123456» → 996555123456; «555123456» → 996555123456
//     KZ: «87011234567» → 77011234567; «7011234567» → 77011234567
// Номер с «+» (или «00») обязан быть полным международным: «+7747967614» — пропущена цифра.
// Без страны принимаются местные формы обеих. Плохой номер (опечатка, тест) → null.
export function normalizePhone(raw, countryHint) {
  const s = String(raw == null ? '' : raw).trim();
  let d = s.replace(/\D/g, '');
  let intl = s.startsWith('+');
  if (d.startsWith('00')) { d = d.slice(2); intl = true; }
  if (!d) return null;
  if (d.length === 12 && d.startsWith('996')) return d;
  if (d.length === 11 && d.startsWith('7')) return d;
  if (intl) return null;
  const c = String(countryHint || '').toUpperCase();
  const kg = !c || c === 'KG', kz = !c || c === 'KZ';
  if (kg && d.length === 10 && d.startsWith('0')) return '996' + d.slice(1);
  if (kg && d.length === 9) return '996' + d;
  if (kz && d.length === 11 && d.startsWith('8')) return '7' + d.slice(1);
  if (kz && d.length === 10 && !d.startsWith('0')) return '7' + d;
  return null;
}
