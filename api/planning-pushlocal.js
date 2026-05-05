// /api/planning-pushlocal — страница-помощник: читает localStorage у тебя в браузере
// и POST'ит в /api/planning. Минует все кэши, SW, баги в основном index.html.
// Просто открой URL → нажми «Залить» → готово.

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Залить Планёрки в облако — SalesDoc</title>
<style>
body{font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;background:#0a0a0a;color:#fff;margin:0;min-height:100vh;padding:24px}
.box{max-width:600px;margin:0 auto;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:28px}
h1{font-size:18px;margin:0 0 6px}
.muted{color:rgba(255,255,255,.55);font-size:13px;line-height:1.55;margin:0 0 18px}
.stat{display:flex;justify-content:space-between;padding:10px 14px;background:rgba(255,255,255,.04);border-radius:10px;margin-bottom:8px;font-size:13px}
.stat b{color:#60A5FA;font-variant-numeric:tabular-nums}
button{display:block;width:100%;padding:14px;font-size:14px;font-weight:700;border:none;border-radius:10px;background:#10B981;color:#fff;cursor:pointer;margin-top:16px;letter-spacing:.3px}
button:hover{background:#059669}
button:disabled{background:rgba(255,255,255,.08);color:rgba(255,255,255,.4);cursor:not-allowed}
.result{margin-top:18px;padding:14px 16px;border-radius:10px;font-size:13px;line-height:1.5;white-space:pre-wrap}
.ok{background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);color:#10B981}
.err{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#EF4444}
pre{background:rgba(0,0,0,.3);padding:10px;border-radius:6px;overflow:auto;font-size:11px;max-height:200px;color:rgba(255,255,255,.7)}
a{color:#60A5FA}
</style>
</head><body>
<div class="box">
<h1>Залить Планёрки из этого браузера в облако</h1>
<p class="muted">Эта страница прочитает твои локальные спринты/задачи/ретро из <code>localStorage</code> и отправит в KV. Если хочешь, чтобы все сотрудники видели именно твои данные — нажми кнопку ниже.</p>

<div id="stats"></div>
<button id="go">Залить в облако</button>
<div id="result"></div>

<p class="muted" style="margin-top:24px">После успешной заливки попроси других сотрудников открыть <a href="/api/reset">/api/reset</a> или просто перезайти в приложение — увидят то же что и ты.</p>
</div>

<script>
(function(){
  function rd(k, def){ try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch(e){ return def; } }
  var sprints = rd('plan_sprints_v1', []);
  var tasks   = rd('plan_tasks_v1', []);
  var retros  = rd('plan_retros_v1', []);
  var stats = document.getElementById('stats');
  stats.innerHTML =
    '<div class="stat"><span>Спринтов в твоём localStorage</span><b>' + (Array.isArray(sprints)?sprints.length:'?') + '</b></div>' +
    '<div class="stat"><span>Задач</span><b>' + (Array.isArray(tasks)?tasks.length:'?') + '</b></div>' +
    '<div class="stat"><span>Заметок ретро</span><b>' + (Array.isArray(retros)?retros.length:'?') + '</b></div>';

  if (Array.isArray(sprints) && sprints.length){
    var preview = sprints.slice(0,5).map(function(s){ return '· ' + (s.name || '(без имени)'); }).join('\\n');
    stats.innerHTML += '<pre>Первые 5:\\n' + preview + '</pre>';
  } else {
    document.getElementById('go').disabled = true;
    stats.innerHTML += '<div class="err result">localStorage пуст — нечего заливать.</div>';
  }

  document.getElementById('go').addEventListener('click', async function(){
    var btn = this;
    var res = document.getElementById('result');
    btn.disabled = true;
    btn.textContent = 'Заливаю...';
    res.innerHTML = '';
    try {
      var r = await fetch('/api/planning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sprints: sprints, tasks: tasks, retros: retros,
          client_updated_at: 0,
          updated_by: 'planning-pushlocal'
        })
      });
      var txt = await r.text();
      if (!r.ok) {
        res.className = 'result err';
        res.textContent = 'Ошибка ' + r.status + ': ' + txt;
        btn.disabled = false;
        btn.textContent = 'Повторить';
        return;
      }
      // Проверим что реально записалось
      var ver = await fetch('/api/planning?_=' + Date.now()).then(function(x){ return x.json(); });
      res.className = 'result ok';
      res.innerHTML = 'Готово.\\nВ KV сейчас: ' + (ver.sprints||[]).length + ' спринт(ов), ' + (ver.tasks||[]).length + ' задач(и), updated_at: ' + (ver.updated_at ? new Date(ver.updated_at).toLocaleString('ru-RU') : '-') + '\\n\\nТеперь попроси других сделать <a href="/api/reset">/api/reset</a> — они увидят твои данные.';
      btn.textContent = 'Готово';
    } catch(e) {
      res.className = 'result err';
      res.textContent = 'Ошибка: ' + e.message;
      btn.disabled = false;
      btn.textContent = 'Повторить';
    }
  });
})();
</script>
</body></html>`);
}
