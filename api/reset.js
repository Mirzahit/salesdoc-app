// /api/reset — одноразовая страница самоочистки браузера для застрявших клиентов.
// Открой URL: https://salesdoc-app.vercel.app/api/reset
// Скрипт сам:
//   1) сделает unregister всем Service Worker'ам
//   2) удалит все Cache Storage
//   3) очистит localStorage и sessionStorage
//   4) удалит cookie текущего домена
//   5) через 2 секунды редирект на /
// После этого браузер скачает приложение полностью свежим.

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Сброс кэша — SalesDoc</title>
<style>
  body { font-family: -apple-system, system-ui, Segoe UI, Roboto, sans-serif; background:#0a0a0a; color:#fff; margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; }
  .box { max-width: 460px; width:100%; background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08); border-radius:14px; padding:28px; }
  h1 { font-size:18px; margin:0 0 6px; font-weight:700; }
  p { font-size:13px; color:rgba(255,255,255,.65); line-height:1.55; margin:0 0 16px; }
  ul { list-style:none; padding:0; margin:0 0 16px; font-size:13px; }
  li { padding:6px 0; color:rgba(255,255,255,.55); }
  li.ok { color:#10B981; }
  li.err { color:#EF4444; }
  li::before { content:'·  '; color:rgba(255,255,255,.3); }
  li.ok::before { content:'✓  '; }
  li.err::before { content:'✕  '; }
  .done { color:#10B981; font-weight:600; font-size:14px; margin-top:12px; }
  .err-final { color:#EF4444; font-weight:600; font-size:14px; margin-top:12px; }
  a { color:#60A5FA; text-decoration:none; font-weight:600; }
  a:hover { text-decoration:underline; }
</style>
</head><body>
<div class="box">
  <h1>Сброс кэша SalesDoc</h1>
  <p>Сейчас браузер очистит старые данные приложения и скачает свежую версию. Это разовая операция.</p>
  <ul id="log"></ul>
  <div id="final"></div>
</div>
<script>
(async function(){
  var log = document.getElementById('log');
  var fin = document.getElementById('final');
  function step(text, ok){
    var li = document.createElement('li');
    li.className = ok === true ? 'ok' : (ok === false ? 'err' : '');
    li.textContent = text;
    log.appendChild(li);
  }
  try {
    if ('serviceWorker' in navigator) {
      var regs = await navigator.serviceWorker.getRegistrations();
      for (var i=0;i<regs.length;i++) { try { await regs[i].unregister(); } catch(e){} }
      step('Service Worker'+(regs.length===1?'':'ы')+' удалён'+(regs.length===1?'':'ы')+' ('+regs.length+')', true);
    } else {
      step('Service Worker недоступен в этом браузере', true);
    }
  } catch(e){ step('Не удалось снять SW: '+e.message, false); }

  try {
    if ('caches' in window) {
      var keys = await caches.keys();
      for (var k=0;k<keys.length;k++) { try { await caches.delete(keys[k]); } catch(e){} }
      step('Кэш очищен ('+keys.length+' хранилищ)', true);
    } else {
      step('Cache API недоступен', true);
    }
  } catch(e){ step('Не удалось очистить кэш: '+e.message, false); }

  try {
    var n1 = localStorage.length;
    localStorage.clear();
    step('localStorage очищен ('+n1+' записей)', true);
  } catch(e){ step('localStorage: '+e.message, false); }

  try {
    var n2 = sessionStorage.length;
    sessionStorage.clear();
    step('sessionStorage очищен ('+n2+' записей)', true);
  } catch(e){ step('sessionStorage: '+e.message, false); }

  try {
    var ck = (document.cookie || '').split(';');
    var killed = 0;
    for (var c=0;c<ck.length;c++){
      var name = ck[c].split('=')[0].trim();
      if (!name) continue;
      document.cookie = name+'=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
      killed++;
    }
    step('Cookies удалены ('+killed+')', true);
  } catch(e){ step('Cookies: '+e.message, false); }

  fin.className = 'done';
  fin.innerHTML = 'Готово. Открываю приложение... <a href="/">если не открылось — кликни сюда</a>';
  setTimeout(function(){ try { window.location.replace('/'); } catch(e){ window.location.href = '/'; } }, 2000);
})();
</script>
</body></html>`);
}
