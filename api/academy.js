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

import { sbSelect, sbUpsert } from './_supabase.js';
import { checkAuth } from './_auth.js';

export const config = { maxDuration: 30 };

const PASS_SCORE = 80;

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
        const [mods, lessons] = await Promise.all([
          sbSelect('academy_modules', { active: 'eq.true', order: 'sort.asc' }),
          sbSelect('academy_lessons', { active: 'eq.true', order: 'sort.asc', select: 'id,module_id,sort,title,duration_label,trainer,questions' })
        ]);
        const byMod = {};
        lessons.forEach(l => {
          (byMod[l.module_id] = byMod[l.module_id] || []).push({
            id: l.id, sort: l.sort, title: l.title, duration_label: l.duration_label,
            has_trainer: !!l.trainer,
            questions_count: Array.isArray(l.questions) ? l.questions.length : 0
          });
        });
        return res.status(200).json({
          ok: true,
          modules: mods.map(m => ({ id: m.id, sort: m.sort, title: m.title, lessons: byMod[m.id] || [] }))
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
            // Правильные ответы наружу не отдаём — проверка только в check_test
            questions: (l.questions || []).map(it => ({ q: it.q, options: it.options }))
          }
        });
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

      const existing = await sbSelect('academy_progress', {
        user_email: 'eq.' + email, lesson_id: 'eq.' + lessonId, limit: '1'
      });
      const cur = existing[0] || null;

      if (body.action === 'progress') {
        const row = {
          user_email: email,
          lesson_id: lessonId,
          notes_done: body.notes_done != null ? !!body.notes_done : (cur ? cur.notes_done : false),
          trainer_score: body.trainer_score != null ? Math.max(0, Math.min(10, parseInt(body.trainer_score, 10) || 0)) : (cur ? cur.trainer_score : null),
          trainer_review: body.trainer_review != null ? String(body.trainer_review).slice(0, 4000) : (cur ? cur.trainer_review : null),
          test_score: cur ? cur.test_score : null,
          test_attempts: cur ? cur.test_attempts : 0,
          passed: cur ? cur.passed : false,
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

      return res.status(400).json({ ok: false, error: 'неизвестный action' });
    }

    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('[api/academy]', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
