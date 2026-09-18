// v992: вытащить из сгенерированных SQL-файлов курса upsert-ы отдельных уроков,
// чтобы залить в Supabase только изменённые (через MCP execute_sql).
//   node docs/migrations/pick-academy-lessons.mjs <out.sql> <lessonId> [<lessonId> ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const [, , outFile, ...ids] = process.argv;
if (!outFile || !ids.length) { console.error('нужны выходной файл и id уроков'); process.exit(1); }

const files = fs.readdirSync(dir).filter(f => /^2026-09-17-academy-adaptation-content-d\d\.sql$/.test(f));
const all = files.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
const stmts = all.split(/\n\n(?=INSERT INTO )/);
const out = [];
for (const id of ids) {
  const s = stmts.find(x => x.startsWith('INSERT INTO academy_lessons') && x.includes('($sd$' + id + '$sd$'));
  if (!s) throw new Error('урок не найден: ' + id);
  out.push(s.trim());
}
fs.writeFileSync(outFile, out.join('\n\n') + '\n');
console.log(ids.length + ' уроков → ' + outFile);
