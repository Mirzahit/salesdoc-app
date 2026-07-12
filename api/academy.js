// /api/academy — v806: платформа «Академия» (обучение сотрудников).
//
// Routes:
//   GET  ?structure=1        → модули + уроки (БЕЗ карточек и БЕЗ правильных ответов)
//   GET  ?lesson=UUID        → полный урок; из questions вырезан correct (тест проверяет сервер)
//   GET  ?progress=1[&email=]→ прогресс; чужой email доступен только admin/head
//   GET  ?team=1             → все строки прогресса (только admin/head) + lessons_total
//   GET  ?rating=1           → «Баллы мощности»: доска месяца + история победителей (все авторизованные)
//   POST {action:'progress', lesson_id, notes_done?, trainer_score?, trainer_review?}
//   POST {action:'check_test', lesson_id, answers:[int]} → сервер считает балл, зачёт от 80%
//
// v816: рейтинг «Баллы мощности». Начисления ТОЛЬКО здесь, журнал academy_points,
// идемпотентность на UNIQUE(user_email,dedup_key). Сбой журнала не роняет прогресс.
//
// Личность — заголовок x-user-email (sbFetch шлёт сам). Известное ограничение проекта:
// заголовок можно подделать с APP_TOKEN (как в employee-access) — приемлемо для внутреннего инструмента.

import { sbSelect, sbUpsert, sbUpdate, sbInsertIgnoreDup } from './_supabase.js';
import { checkAuth } from './_auth.js';

export const config = { maxDuration: 30 };

const PASS_SCORE = 80;

// ===== v816: «Баллы мощности» =====
// Месяц гонки и неделя регулярности — по Алматы (UTC+5). Без сдвига зачёт в 02:00
// ночи 1-го числа упал бы в прошлый месяц (UTC-ловушка проекта).
const ALMATY_MS = 5 * 3600 * 1000;
function almatyMonth() { return new Date(Date.now() + ALMATY_MS).toISOString().slice(0, 7); }
function almatyIsoWeek() {
  const d = new Date(Date.now() + ALMATY_MS);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return date.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

const POINTS = { test_pass: 10, test_first_try: 5, lesson_pass: 5, module_pass: 20, module_tempo: 10, weekly: 5 };

// PostgREST режет любой ответ на 1000 строк (ловили в v620 на payments) — журнал баллов
// растёт бесконечно, поэтому рейтинг читает его постранично со стабильным порядком.
async function sbSelectAll(table, params) {
  const out = [];
  const page = 1000;
  for (let off = 0; ; off += page) {
    const rows = await sbSelect(table, Object.assign({}, params, {
      order: params.order || 'created_at.asc', limit: String(page), offset: String(off)
    }));
    out.push.apply(out, rows);
    if (rows.length < page) break;
  }
  return out;
}

// Фиксированное начисление. Возвращает points, если строка реально вставлена,
// 0 — если такое начисление уже было (дубль отброшен констрейнтом) или журнал упал.
async function award(email, rule, refId, dedupKey, points, meta) {
  try {
    const inserted = await sbInsertIgnoreDup('academy_points', {
      user_email: email, rule, ref_id: refId || null, month: almatyMonth(),
      dedup_key: dedupKey, points, meta: meta || null
    }, 'user_email,dedup_key');
    return inserted.length ? points : 0;
  } catch (e) { console.error('[academy award]', rule, dedupKey, e.message); return 0; }
}

// Тренажёр: до 10 баллов за урок по лучшей оценке за всё время. Начисляем помесячной
// дельтой: строка текущего месяца перезаписывается ростом, прошлые месяцы заморожены.
async function awardTrainer(email, lessonId, bestEver) {
  try {
    const month = almatyMonth();
    const best = Math.max(0, Math.min(10, bestEver || 0));
    if (!best) return 0;
    const rows = await sbSelect('academy_points', {
      user_email: 'eq.' + email, rule: 'eq.trainer', ref_id: 'eq.' + lessonId, select: 'month,points'
    });
    const past = rows.filter(r => r.month !== month).reduce((s, r) => s + (r.points || 0), 0);
    const delta = best - past;
    if (delta <= 0) return 0;
    const curRow = rows.find(r => r.month === month);
    if (curRow && (curRow.points || 0) >= delta) return 0;
    await sbUpsert('academy_points', {
      user_email: email, rule: 'trainer', ref_id: lessonId, month,
      dedup_key: 'trainer:' + lessonId + ':' + month, points: delta, meta: { best }
    }, 'user_email,dedup_key');
    return delta - (curRow ? (curRow.points || 0) : 0);
  } catch (e) { console.error('[academy trainer]', lessonId, e.message); return 0; }
}

// Бонус за модуль: все уроки сданы → +20; если уложился в 7 дней → ещё +10.
// Темп считаем по created_at строк журнала (test_pass/lesson_pass) — updated_at прогресса
// перетирается и не годится. У уроков, сданных до запуска фичи, журнальных строк нет —
// тогда темп честно не начисляем.
async function checkModuleBonus(email, moduleId) {
  try {
    if (!moduleId) return 0;
    const lessons = await sbSelect('academy_lessons', { module_id: 'eq.' + moduleId, active: 'eq.true', select: 'id' });
    if (!lessons.length) return 0;
    const ids = lessons.map(l => l.id);
    const prog = await sbSelect('academy_progress', {
      user_email: 'eq.' + email, lesson_id: 'in.(' + ids.join(',') + ')', passed: 'eq.true', select: 'lesson_id'
    });
    if (new Set(prog.map(p => p.lesson_id)).size < ids.length) return 0;
    let got = await award(email, 'module_pass', moduleId, 'module_pass:' + moduleId, POINTS.module_pass);
    if (got > 0) {
      const jr = await sbSelect('academy_points', {
        user_email: 'eq.' + email, rule: 'in.(test_pass,lesson_pass)', ref_id: 'in.(' + ids.join(',') + ')', select: 'ref_id,created_at'
      });
      if (new Set(jr.map(r => r.ref_id)).size >= ids.length) {
        const times = jr.map(r => new Date(r.created_at).getTime());
        if (Math.max.apply(null, times) - Math.min.apply(null, times) <= 7 * 86400000) {
          got += await award(email, 'module_tempo', moduleId, 'module_tempo:' + moduleId, POINTS.module_tempo);
        }
      }
    }
    return got;
  } catch (e) { console.error('[academy module]', moduleId, e.message); return 0; }
}

// Общие начисления за зачёт урока: регулярность недели + бонус модуля
async function awardOnPass(email, moduleId) {
  const wk = almatyIsoWeek();
  let sum = await award(email, 'weekly', wk, 'weekly:' + wk, POINTS.weekly);
  sum += await checkModuleBonus(email, moduleId);
  return sum;
}

// v808: видео уроков — приватный бакет academy-videos. Плеер получает временную подписанную
// ссылку (2 часа), загрузка — прямым PUT в Storage по подписанному upload-URL (мимо лимита
// тела запроса Vercel 4.5МБ). Публичных ссылок на видео не существует.
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SECRET_KEY || '';

async function storageFetch(path, body) {
  const r = await fetch(`${SB_URL}/storage/v1${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SB_KEY}`, 'apikey': SB_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

function callerEmail(req) {
  return String(req.headers['x-user-email'] || '').trim().toLowerCase();
}

async function isHead(email) {
  if (!email) return false;
  try {
    const rows = await sbSelect('employees', { email: 'eq.' + email, select: 'role,active', limit: '1' });
    return rows.length > 0 && rows[0].active !== false && ['admin', 'head'].includes(String(rows[0].role || '').toLowerCase());
  } catch (_) { return false; }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', c => chunks += c);
    req.on('end', () => { try { resolve(JSON.parse(chunks || '{}')); } catch { resolve({}); } });
  });
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  const email = callerEmail(req);

  try {
    if (req.method === 'GET') {
      const q = req.query || {};

      if (q.structure === '1') {
        // v808: курсы → модули → уроки (вид GetCourse). Неактивный курс = карточка «скоро».
        const [courses, mods, lessons] = await Promise.all([
          sbSelect('academy_courses', { order: 'sort.asc' }),
          sbSelect('academy_modules', { active: 'eq.true', order: 'sort.asc' }),
          sbSelect('academy_lessons', { active: 'eq.true', order: 'sort.asc', select: 'id,module_id,sort,title,duration_label,trainer,questions,video_path' })
        ]);
        const byMod = {};
        lessons.forEach(l => {
          (byMod[l.module_id] = byMod[l.module_id] || []).push({
            id: l.id, sort: l.sort, title: l.title, duration_label: l.duration_label,
            has_trainer: !!l.trainer,
            has_video: !!l.video_path,
            questions_count: Array.isArray(l.questions) ? l.questions.length : 0
          });
        });
        const byCourse = {};
        // Модуль без course_id (забыли привязать в Supabase) не должен молча исчезать —
        // докидываем его в первый активный курс и оставляем след в логах
        const fallbackCourse = courses.find(c => c.active !== false) || courses[0];
        mods.forEach(m => {
          let cid = m.course_id;
          if (!cid || !courses.some(c => c.id === cid)) {
            console.warn('[api/academy] модуль без курса, показан в первом активном:', m.id, m.title);
            cid = fallbackCourse ? fallbackCourse.id : cid;
          }
          (byCourse[cid] = byCourse[cid] || []).push({ id: m.id, sort: m.sort, title: m.title, lessons: byMod[m.id] || [] });
        });
        return res.status(200).json({
          ok: true,
          courses: courses.map(c => ({
            id: c.id, sort: c.sort, title: c.title, subtitle: c.subtitle, audience: c.audience,
            roles: c.roles || null, active: c.active !== false,
            modules: byCourse[c.id] || []
          }))
        });
      }

      if (q.lesson) {
        const rows = await sbSelect('academy_lessons', { id: 'eq.' + q.lesson, limit: '1' });
        if (!rows.length) return res.status(404).json({ ok: false, error: 'урок не найден' });
        const l = rows[0];
        return res.status(200).json({
          ok: true,
          lesson: {
            id: l.id, module_id: l.module_id, title: l.title, duration_label: l.duration_label,
            cards: l.cards || [],
            trainer: l.trainer || null,
            has_video: !!l.video_path, // v808: сам путь не отдаём — плеер берёт подписанную ссылку через ?video=
            // Правильные ответы наружу не отдаём — проверка только в check_test
            questions: (l.questions || []).map(it => ({ q: it.q, options: it.options }))
          }
        });
      }

      // v808: подписанная ссылка на видео урока (2 часа), только для авторизованных
      if (q.video) {
        const rows = await sbSelect('academy_lessons', { id: 'eq.' + q.video, select: 'video_path', limit: '1' });
        if (!rows.length || !rows[0].video_path) return res.status(404).json({ ok: false, error: 'у урока нет видео' });
        const { json } = await storageFetch('/object/sign/academy-videos/' + rows[0].video_path, { expiresIn: 7200 });
        if (!json.signedURL) return res.status(500).json({ ok: false, error: 'не удалось подписать видео' });
        return res.status(200).json({ ok: true, url: SB_URL + '/storage/v1' + json.signedURL });
      }

      if (q.progress === '1') {
        let target = email;
        if (q.email && q.email !== email) {
          if (!(await isHead(email))) return res.status(403).json({ ok: false, error: 'чужой прогресс доступен только руководителю' });
          target = String(q.email).trim().toLowerCase();
        }
        if (!target) return res.status(400).json({ ok: false, error: 'нет email — обратитесь к администратору' });
        const rows = await sbSelect('academy_progress', { user_email: 'eq.' + target });
        return res.status(200).json({ ok: true, rows });
      }

      if (q.team === '1') {
        if (!(await isHead(email))) return res.status(403).json({ ok: false, error: 'только для руководителей' });
        const [rows, lessons] = await Promise.all([
          sbSelect('academy_progress', { order: 'updated_at.desc', limit: '2000' }),
          sbSelect('academy_lessons', { active: 'eq.true', select: 'id' })
        ]);
        return res.status(200).json({ ok: true, rows, lessons_total: lessons.length });
      }

      // v816: «Баллы мощности» — доска текущего месяца + история победителей.
      // Доступно всем авторизованным: рейтинг видят все, это часть соревнования.
      if (q.rating === '1') {
        const month = almatyMonth();
        const [points, emps] = await Promise.all([
          sbSelectAll('academy_points', { select: 'user_email,rule,points,month,created_at' }),
          sbSelect('employees', { select: 'email,name,role,active' })
        ]);
        const empBy = {};
        emps.forEach(e => { if (e.email) empBy[String(e.email).toLowerCase()] = e; });
        const agg = {};      // текущий месяц: email → {total, by_rule}
        const monthly = {};  // все месяцы: month → email → total (для истории)
        points.forEach(p => {
          const em = String(p.user_email || '').toLowerCase();
          if (!em) return;
          (monthly[p.month] = monthly[p.month] || {});
          monthly[p.month][em] = (monthly[p.month][em] || 0) + (p.points || 0);
          if (p.month === month) {
            const a = (agg[em] = agg[em] || { total: 0, by_rule: {} });
            a.total += p.points || 0;
            a.by_rule[p.rule] = (a.by_rule[p.rule] || 0) + (p.points || 0);
          }
        });
        // В доске только действующие сотрудники; в истории — все (победы не стираются)
        const board = Object.keys(agg)
          .filter(em => { const e = empBy[em]; return e && e.active !== false; })
          .map(em => ({
            email: em, name: empBy[em].name || em, role: empBy[em].role || null,
            total: agg[em].total, by_rule: agg[em].by_rule
          }))
          .sort((a, b) => b.total - a.total);
        const history = Object.keys(monthly).filter(m => m < month).sort().reverse().slice(0, 12).map(m => ({
          month: m,
          top: Object.keys(monthly[m])
            .map(em => ({ email: em, name: (empBy[em] && empBy[em].name) || em, total: monthly[m][em] }))
            .sort((a, b) => b.total - a.total).slice(0, 3)
        }));
        const myIdx = board.findIndex(b => b.email === email);
        return res.status(200).json({
          ok: true, month, board,
          me: myIdx >= 0 ? Object.assign({ place: myIdx + 1 }, board[myIdx]) : null,
          history
        });
      }

      return res.status(400).json({ ok: false, error: 'неизвестный запрос' });
    }

    if (req.method === 'POST') {
      if (!email) return res.status(400).json({ ok: false, error: 'нет email — обратитесь к администратору' });
      const body = await readBody(req);
      const lessonId = String(body.lesson_id || '');
      if (!lessonId) return res.status(400).json({ ok: false, error: 'нужен lesson_id' });

      // v808: прогресс читаем только там, где он нужен (upload_sign/set_video работают
      // с lesson_id и падали бы на select с невалидным uuid до своей ветки)
      let cur = null;
      if (body.action === 'progress' || body.action === 'check_test') {
        const existing = await sbSelect('academy_progress', {
          user_email: 'eq.' + email, lesson_id: 'eq.' + lessonId, limit: '1'
        });
        cur = existing[0] || null;
      }

      if (body.action === 'progress') {
        // mark_passed: зачёт урока БЕЗ теста (видео/конспект). Проверяем на сервере,
        // что теста действительно нет — иначе тест обходился бы одной кнопкой.
        let markPassed = false;
        let lessonModuleId = null;
        if (body.mark_passed) {
          const ls = await sbSelect('academy_lessons', { id: 'eq.' + lessonId, select: 'questions,module_id', limit: '1' });
          if (!ls.length) return res.status(404).json({ ok: false, error: 'урок не найден' });
          if (Array.isArray(ls[0].questions) && ls[0].questions.length) {
            return res.status(400).json({ ok: false, error: 'в этом уроке есть тест — зачёт только через тест' });
          }
          markPassed = true;
          lessonModuleId = ls[0].module_id || null;
        }
        const row = {
          user_email: email,
          lesson_id: lessonId,
          notes_done: body.notes_done != null ? !!body.notes_done : (cur ? cur.notes_done : false),
          trainer_score: body.trainer_score != null ? Math.max(0, Math.min(10, parseInt(body.trainer_score, 10) || 0)) : (cur ? cur.trainer_score : null),
          trainer_review: body.trainer_review != null ? String(body.trainer_review).slice(0, 4000) : (cur ? cur.trainer_review : null),
          test_score: cur ? cur.test_score : null,
          test_attempts: cur ? cur.test_attempts : 0,
          passed: markPassed || (cur ? cur.passed : false),
          updated_at: new Date().toISOString()
        };
        const saved = await sbUpsert('academy_progress', row, 'user_email,lesson_id');

        // v816: баллы. Зачёт без теста — как сдача урока; тренажёр — дельтой от best-ever.
        let pointsAwarded = 0;
        if (markPassed && !(cur && cur.passed)) {
          pointsAwarded += await award(email, 'lesson_pass', lessonId, 'lesson_pass:' + lessonId, POINTS.lesson_pass);
          pointsAwarded += await awardOnPass(email, lessonModuleId);
        }
        if (body.trainer_score != null) {
          // Баллы тренажёра — только если у урока тренажёр действительно есть, иначе
          // curl-ом можно было бы собрать по +10 за каждый урок академии
          const ls2 = await sbSelect('academy_lessons', { id: 'eq.' + lessonId, select: 'trainer', limit: '1' });
          if (ls2.length && ls2[0].trainer) {
            const bestEver = Math.max((cur && cur.trainer_score) || 0, row.trainer_score || 0);
            pointsAwarded += await awardTrainer(email, lessonId, bestEver);
          }
        }
        return res.status(200).json({ ok: true, row: saved[0], points_awarded: pointsAwarded });
      }

      if (body.action === 'check_test') {
        const lessons = await sbSelect('academy_lessons', { id: 'eq.' + lessonId, select: 'questions,module_id', limit: '1' });
        if (!lessons.length) return res.status(404).json({ ok: false, error: 'урок не найден' });
        const questions = lessons[0].questions || [];
        const answers = Array.isArray(body.answers) ? body.answers : [];
        if (!questions.length) return res.status(400).json({ ok: false, error: 'в уроке нет теста' });
        if (answers.length !== questions.length) return res.status(400).json({ ok: false, error: 'ответы не на все вопросы' });

        let correct = 0;
        const wrong = [];
        questions.forEach((it, i) => {
          if (Number(answers[i]) === Number(it.correct)) correct++;
          else wrong.push(i);
        });
        const score = Math.round(correct / questions.length * 100);
        const passedNow = score >= PASS_SCORE;

        const row = {
          user_email: email,
          lesson_id: lessonId,
          notes_done: cur ? cur.notes_done : true,
          trainer_score: cur ? cur.trainer_score : null,
          trainer_review: cur ? cur.trainer_review : null,
          test_score: score,
          test_attempts: (cur ? cur.test_attempts : 0) + 1,
          passed: (cur && cur.passed) || passedNow, // sticky: раз сдал — не сбрасывается
          updated_at: new Date().toISOString()
        };
        const saved = await sbUpsert('academy_progress', row, 'user_email,lesson_id');

        // v816: баллы за сдачу теста (только при переходе в passed, повтор не начисляет)
        let pointsAwarded = 0;
        if (passedNow && !(cur && cur.passed)) {
          pointsAwarded += await award(email, 'test_pass', lessonId, 'test_pass:' + lessonId, POINTS.test_pass);
          if (row.test_attempts === 1) {
            pointsAwarded += await award(email, 'test_first_try', lessonId, 'test_first_try:' + lessonId, POINTS.test_first_try);
          }
          pointsAwarded += await awardOnPass(email, lessons[0].module_id || null);
        }
        // Правильные индексы не раскрываем — только какие вопросы мимо
        return res.status(200).json({ ok: true, score, passed: saved[0].passed, correct_count: correct, total: questions.length, wrong_indexes: wrong, attempts: saved[0].test_attempts, points_awarded: pointsAwarded });
      }

      // v808: подписанный upload-URL для загрузки видео (только руководители).
      // Браузер шлёт файл PUT-ом прямо в Storage — мимо Vercel.
      if (body.action === 'upload_sign') {
        if (!(await isHead(email))) return res.status(403).json({ ok: false, error: 'загрузка видео — только руководителям' });
        const raw = String(body.path || '').trim();
        if (!raw) return res.status(400).json({ ok: false, error: 'нужен path' });
        const path = raw.replace(/[^a-zA-Z0-9/_.-]/g, '_').replace(/\.\./g, '_').slice(0, 200);
        const { json } = await storageFetch('/object/upload/sign/academy-videos/' + path, {});
        if (!json.url) return res.status(500).json({ ok: false, error: 'не удалось подписать загрузку', detail: json });
        return res.status(200).json({ ok: true, upload_url: SB_URL + '/storage/v1' + json.url, path });
      }

      // v808: привязать загруженное видео к уроку (только руководители)
      if (body.action === 'set_video') {
        if (!(await isHead(email))) return res.status(403).json({ ok: false, error: 'только руководителям' });
        const vp = body.video_path == null ? null : String(body.video_path).slice(0, 200);
        const upd = await sbUpdate('academy_lessons', { id: 'eq.' + lessonId }, { video_path: vp });
        if (!upd.length) return res.status(404).json({ ok: false, error: 'урок не найден' });
        return res.status(200).json({ ok: true, lesson_id: lessonId, video_path: upd[0].video_path });
      }

      return res.status(400).json({ ok: false, error: 'неизвестный action' });
    }

    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('[api/academy]', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
