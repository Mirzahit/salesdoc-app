-- v992: контент курса «Адаптация» — После допуска · месяц 1 и дальше. Сгенерировано gen-academy-adaptation.mjs

INSERT INTO academy_modules (id, course_id, sort, title, intro, gate, active) VALUES
 ($sd$a0000000-0000-0000-0002-000000000008$sd$, $sd$c0000000-0000-0000-0000-000000000002$sd$, 90, $sd$После допуска · месяц 1 и дальше$sd$, $sd$Что происходит после экзамена: как считается доход, пять грейдов от испытательного срока до РОПа и шкала бонуса за план.$sd$, NULL, true)
ON CONFLICT (id) DO UPDATE SET course_id = EXCLUDED.course_id, sort = EXCLUDED.sort, title = EXCLUDED.title, intro = EXCLUDED.intro, gate = EXCLUDED.gate, active = EXCLUDED.active;

INSERT INTO academy_lessons (id, module_id, sort, title, duration_label, cards, trainer, questions, body_html, links, pass_score, ack_text, active) VALUES
 ($sd$b0000000-0000-0000-0002-000000000801$sd$, $sd$a0000000-0000-0000-0002-000000000008$sd$, 10, $sd$Первый месяц: нормативы и контроль$sd$, $sd$10 мин$sd$, '[]'::jsonb, NULL, $sd$[{"q":"Что докладывает менеджер на утренней планёрке?","options":["Погоду","Приоритетные сделки и шаги к целевому действию, проваленные сделки и план реанимации","Только сумму продаж","Ничего, слушает РОПа"],"correct":1},{"q":"Что РОП делает еженедельно с твоими звонками?","options":["Ничего","Прослушивает 5 звонков и ставит балл по скрипту","Удаляет записи","Отправляет клиентам"],"correct":1},{"q":"Где фиксируется факт дня по 4 KPI?","options":["В личных заметках","В «Светофоре»","В Loom","В договоре"],"correct":1},{"q":"Через сколько принимается решение о переходе с испытательного срока?","options":["Через 1 месяц","Через 3 месяца","Через год","Сразу после экзамена"],"correct":1}]$sd$::jsonb, $sd$<p>После допуска нормативы действуют в полном объёме с первого дня — те же, что в Карте менеджера (день 2, урок 1). Планы испытательного срока — в таблице грейдов («Старт», урок 4). Здесь — только точки контроля: где и как РОП смотрит на твою работу.</p>
<h4>Утренняя планёрка</h4>
<p>Формат: удалённо или лично. Доклад по плану продаж на сегодня, короткие доклады каждого менеджера по регламенту «вопросы от РОПа»: приоритетные сделки и планируемые шаги к целевому действию; проваленные сделки, причина по мнению менеджера, план реанимации. Разбор одной сложной ситуации, отработка возражений в парах, мотивация, назначение наставников из «звёзд».</p>
<h4>«Светофор» — факт дня</h4>
<p>Четыре KPI по дням месяца: встречи, звонки, лицензии, продажи. План, факт, процент и темп (R-r) — видно, укладываешься ли в месяц. Заполняется в день работы, цифры совпадают с CRM.</p>
<h4>Что проверяет РОП</h4>
<table class="tbl"><thead><tr><th>Когда</th><th>Что</th><th>Инструмент</th></tr></thead><tbody>
<tr><td>Ежедневно</td><td>Отчёт в WhatsApp и «Светофор» = данные CRM</td><td>Карта менеджера</td></tr>
<tr><td>Еженедельно</td><td>Балл по чек-листу качества CRM</td><td>День 2, урок 3</td></tr>
<tr><td>Еженедельно</td><td>Прослушка 5 звонков и экспресс-проверка скрипта на 5 баллов</td><td>День 7, урок 2</td></tr>
<tr><td>Ежемесячно</td><td>Аттестация по 4 скриптам, итог по KPI, расчёт дохода</td><td>«Старт», урок 3</td></tr>
<tr><td>Через 3 месяца</td><td>Решение о переходе на грейд «Менеджер по продажам»</td><td>«Старт», урок 4</td></tr>
</tbody></table>$sd$, $sd$[{"t":"Планёрка · каждое утро","u":"https://docs.google.com/spreadsheets/d/1CK2-Xab7sVRtd8oAaYQw_teg1WHB1I2OFks3lse13ss/edit"},{"t":"Светофор · факт дня","u":"https://docs.google.com/spreadsheets/d/1wW8iLwK-ibfXXRPoTkXAU2LfyTQHPu8Gw6m4FSoPeqY/edit"},{"t":"Ежедневный отчёт «Челлендж»","u":"https://docs.google.com/spreadsheets/d/1F8IGYybgkn2oHZcFf42ilEbV-Gc2SlCbmv--jOWS5Fo/edit"}]$sd$::jsonb, NULL, NULL, true)
ON CONFLICT (id) DO UPDATE SET module_id = EXCLUDED.module_id, sort = EXCLUDED.sort, title = EXCLUDED.title, duration_label = EXCLUDED.duration_label, questions = EXCLUDED.questions, body_html = EXCLUDED.body_html, links = EXCLUDED.links, pass_score = EXCLUDED.pass_score, ack_text = EXCLUDED.ack_text, active = EXCLUDED.active;
