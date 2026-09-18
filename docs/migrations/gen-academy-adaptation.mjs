// v992: генератор SQL для курса «Адаптация менеджера по продажам».
// Вход: content-a.js и content-b.js (window.SD_DAYS из страницы школы).
// Выход: 2026-09-17-academy-adaptation-content-dN.sql — по файлу на день,
// повторный прогон безопасен (ON CONFLICT (id) DO UPDATE, прогресс не трогается).
//
//   node docs/migrations/gen-academy-adaptation.mjs <content-a.js> <content-b.js>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , A, B] = process.argv;
if (!A || !B) { console.error('нужны пути к content-a.js и content-b.js'); process.exit(1); }

globalThis.window = {};
for (const f of [A, B]) new Function(fs.readFileSync(f, 'utf8'))();
const DAYS = window.SD_DAYS.slice().sort((a, b) => a.num - b.num);

const COURSE = 'c0000000-0000-0000-0000-000000000002';
const pad = (n, w) => String(n).padStart(w, '0');
const modId = d => `a0000000-0000-0000-0002-0000000000${pad(d.num, 2)}`;
const lesId = (d, i) => `b0000000-0000-0000-0002-00000000${pad(d.num, 2)}${pad(i + 1, 2)}`;

// карта «l2-4 → uuid» для внутренних ссылок между уроками
const lmap = {};
DAYS.forEach(d => d.lessons.forEach((l, i) => { lmap[l.id] = lesId(d, i); }));

const Q = '$sd$';
const lit = s => { if (s == null) return 'NULL'; s = String(s); if (s.includes(Q)) throw new Error('в тексте встретился ' + Q); return Q + s + Q; };
const js = v => lit(JSON.stringify(v)) + '::jsonb';

const modTitle = d => d.num >= 1 && d.num <= 7 ? `День ${d.num} · ${d.title}` : `${d.title} · ${d.when}`;

const outDir = path.dirname(fileURLToPath(import.meta.url));
const modRows = [], lesRows = []; // для --apply: те же строки уходят в PostgREST upsert-ом
let lessons = 0, questions = 0, links = 0;
for (const d of DAYS) {
  modRows.push({ id: modId(d), course_id: COURSE, sort: (d.num + 1) * 10, title: modTitle(d), intro: d.intro || null, gate: d.gate || null, active: true });
  const lines = [`-- v992: контент курса «Адаптация» — ${modTitle(d)}. Сгенерировано gen-academy-adaptation.mjs`];
  lines.push(`INSERT INTO academy_modules (id, course_id, sort, title, intro, gate, active) VALUES
 (${lit(modId(d))}, ${lit(COURSE)}, ${(d.num + 1) * 10}, ${lit(modTitle(d))}, ${lit(d.intro || null)}, ${d.gate ? js(d.gate) : 'NULL'}, true)
ON CONFLICT (id) DO UPDATE SET course_id = EXCLUDED.course_id, sort = EXCLUDED.sort, title = EXCLUDED.title, intro = EXCLUDED.intro, gate = EXCLUDED.gate, active = EXCLUDED.active;`);
  d.lessons.forEach((l, i) => {
    lessons++; questions += l.quiz.length; links += l.links.length;
    const body = l.body.replace(/href="#(l[\d-]+)"|href="#d\d+\/(l[\d-]+)"/g, (m, a, b) => {
      const id = lmap[a || b]; if (!id) throw new Error('битая внутренняя ссылка ' + m); return `href="#acad/${id}"`;
    }).replace(/[❌✅]\s?/g, ''); // правило проекта: без эмоджи в интерфейсе
    const qs = l.quiz.map(q => ({ q: q.q, options: q.a, correct: q.c }));
    lesRows.push({ id: lesId(d, i), module_id: modId(d), sort: (i + 1) * 10, title: l.title, duration_label: l.minutes + ' мин', cards: [], trainer: null, questions: qs, body_html: body.trim(), links: l.links || [], pass_score: l.exam ? 100 : null, ack_text: l.ack || null, active: true });
    lines.push(`INSERT INTO academy_lessons (id, module_id, sort, title, duration_label, cards, trainer, questions, body_html, links, pass_score, ack_text, active) VALUES
 (${lit(lesId(d, i))}, ${lit(modId(d))}, ${(i + 1) * 10}, ${lit(l.title)}, ${lit(l.minutes + ' мин')}, '[]'::jsonb, NULL, ${js(qs)}, ${lit(body.trim())}, ${js(l.links || [])}, ${l.exam ? 100 : 'NULL'}, ${lit(l.ack || null)}, true)
ON CONFLICT (id) DO UPDATE SET module_id = EXCLUDED.module_id, sort = EXCLUDED.sort, title = EXCLUDED.title, duration_label = EXCLUDED.duration_label, questions = EXCLUDED.questions, body_html = EXCLUDED.body_html, links = EXCLUDED.links, pass_score = EXCLUDED.pass_score, ack_text = EXCLUDED.ack_text, active = EXCLUDED.active;`);
  });
  const file = path.join(outDir, `2026-09-17-academy-adaptation-content-d${d.num}.sql`);
  fs.writeFileSync(file, lines.join('\n\n') + '\n');
  console.log(path.basename(file), (fs.statSync(file).size / 1024).toFixed(1) + ' KB');
}
console.log(`дней ${DAYS.length}, уроков ${lessons}, вопросов ${questions}, ссылок ${links}`);

// --apply: залить те же строки в Supabase через PostgREST (ключи из .env.local в корне репо)
if (process.argv.includes('--apply')) {
  const env = {};
  for (const line of fs.readFileSync(path.join(outDir, '..', '..', '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  // переменные окружения перекрывают .env.local (в pull-е с Vercel SUPABASE_URL бывает пустым)
  const url = process.env.SUPABASE_URL || env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY || env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('нет SUPABASE_URL / SUPABASE_SECRET_KEY в .env.local');
  const upsert = async (table, rows) => {
    const r = await fetch(`${url}/rest/v1/${table}?on_conflict=id`, {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows)
    });
    if (!r.ok) throw new Error(`${table}: ${r.status} ${await r.text()}`);
    console.log(`${table}: записано ${rows.length}`);
  };
  await upsert('academy_modules', modRows);
  await upsert('academy_lessons', lesRows);
}
