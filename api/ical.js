// v787: ICS-лента задач для подписки в Google Calendar (и любом другом календаре).
// GET /api/ical?token=APP_TOKEN[&assignee=Имя]
// Google Calendar не умеет слать заголовки — токен принимаем query-параметром
// (APP_TOKEN и так лежит в клиентском бандле, это shared-secret внутреннего инструмента).
// Отдаёт открытые задачи (+закрытые за последние 7 дней, чтобы «выполнено» не исчезало из виду сразу).

import { sbSelect } from './_supabase.js';

function pad(n) { return n < 10 ? '0' + n : '' + n; }

// ISO → формат iCalendar UTC: 20260703T090000Z
function icsDt(iso) {
  const d = new Date(iso);
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate())
    + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
}
// Для задач «весь день» — только дата (в TZ приложения UTC+5, deadline_at хранится как полночь локали)
function icsDate(iso) {
  const d = new Date(new Date(iso).getTime() + 5 * 3600 * 1000); // Asia/Almaty
  return '' + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
}
// Экранирование текста по RFC 5545
function icsEsc(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

export default async function handler(req, res) {
  const q = req.query || {};
  const expected = (process.env.APP_TOKEN || '').trim();
  if (!expected || (q.token || '').toString().trim() !== expected) {
    return res.status(401).send('unauthorized');
  }

  const assignee = (q.assignee || '').toString().trim();

  // Открытые задачи + закрытые за 7 дней
  const params = { order: 'deadline_at.asc', limit: '500' };
  if (assignee) params['assignee_operator'] = 'eq.' + assignee;
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  params['or'] = `(status.eq.open,and(status.eq.done,closed_at.gte.${weekAgo}))`;

  let tasks = [];
  try {
    tasks = await sbSelect('tasks', params);
  } catch (e) {
    return res.status(500).send('tasks load failed');
  }

  const now = icsDt(new Date().toISOString());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SalesDoc//Tasks//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsEsc(assignee ? ('SalesDoc — задачи ' + assignee) : 'SalesDoc — задачи команды'),
    'X-WR-TIMEZONE:Asia/Almaty'
  ];

  const FLAG_RU = { red: 'Срочно и важно', yellow: 'Важно', green: 'Срочно', gray: 'Не срочно' };

  tasks.forEach(t => {
    if (!t.deadline_at) return;
    const done = t.status === 'done';
    const title = (done ? '[Готово] ' : '') + (t.text || 'Задача')
      + (t.contact_name ? ' · ' + t.contact_name : '');
    const descParts = [];
    if (t.description) descParts.push(t.description);
    if (t.eisenhower && FLAG_RU[t.eisenhower]) descParts.push('Флажок: ' + FLAG_RU[t.eisenhower]);
    if (t.assignee_operator) descParts.push('Ответственный: ' + t.assignee_operator);
    if (t.client_id) descParts.push('Клиент: ' + t.client_id);
    descParts.push('Из SalesDoc — менять там: https://salesdoc-app.vercel.app/#calendar');

    lines.push('BEGIN:VEVENT');
    lines.push('UID:sd-task-' + t.id + '@salesdoc.io');
    lines.push('DTSTAMP:' + now);
    if (t.is_all_day) {
      lines.push('DTSTART;VALUE=DATE:' + icsDate(t.deadline_at));
    } else {
      lines.push('DTSTART:' + icsDt(t.deadline_at));
      const end = t.deadline_end_at || new Date(new Date(t.deadline_at).getTime() + 45 * 60000).toISOString();
      lines.push('DTEND:' + icsDt(end));
    }
    lines.push('SUMMARY:' + icsEsc(title));
    lines.push('DESCRIPTION:' + icsEsc(descParts.join('\n')));
    lines.push('STATUS:' + (done ? 'COMPLETED' : 'CONFIRMED'));
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300'); // Google опрашивает сам, раз в несколько часов
  return res.status(200).send(lines.join('\r\n'));
}
