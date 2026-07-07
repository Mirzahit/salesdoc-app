// /api/academy — v806: платформа «Академия» (обучение сотрудников).
//
// Routes:
//   GET  ?structure=1        → модули + уроки (БЕЗ карточек и БЕЗ правильных ответов)
//   GET  ?lesson=UUID        → полный урок; из questions вырезан correct (тест проверяет сервер)
//   GET  ?progress=1[&email=]→ прогресс; чужой email доступен только admin/head
//   GET  ?team=1             → все строки прогресса (только admin/head) + lessons_total
//   POST {action:'progress', lesson_id, notes_done?, trainer_score?, trainer_review?}
//   POST {action:'check_test', lesson_id, answers:[int]} → сервер считает балл, зачёт от 80%
//
// Личность — заголовок x-user-email (sbFetch шлёт сам). Известное ограничение проекта:
// заголовок можно подделать с APP_TOKEN (как в employee-access) — приемлемо для внутреннего инструмента.

import { sbSelect, sbUpsert, sbUpdate } from './_supabase.js';
import { checkAuth } from './_auth.js';

export const config = { maxDuration: 30 };

const PASS_SCORE = 80;

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
        if (body.mark_passed) {
          const ls = await sbSelect('academy_lessons', { id: 'eq.' + lessonId, select: 'questions', limit: '1' });
          if (!ls.length) return res.status(404).json({ ok: false, error: 'урок не найден' });
          if (Array.isArray(ls[0].questions) && ls[0].questions.length) {
            return res.status(400).json({ ok: false, error: 'в этом уроке есть тест — зачёт только через тест' });
          }
          markPassed = true;
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
        return res.status(200).json({ ok: true, row: saved[0] });
      }

      if (body.action === 'check_test') {
        const lessons = await sbSelect('academy_lessons', { id: 'eq.' + lessonId, select: 'questions', limit: '1' });
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
        // Правильные индексы не раскрываем — только какие вопросы мимо
        return res.status(200).json({ ok: true, score, passed: saved[0].passed, correct_count: correct, total: questions.length, wrong_indexes: wrong, attempts: saved[0].test_attempts });
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
