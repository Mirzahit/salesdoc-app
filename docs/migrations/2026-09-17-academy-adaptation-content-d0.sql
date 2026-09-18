-- v992: контент курса «Адаптация» — Старт · перед первым днём. Сгенерировано gen-academy-adaptation.mjs

INSERT INTO academy_modules (id, course_id, sort, title, intro, gate, active) VALUES
 ($sd$a0000000-0000-0000-0002-000000000000$sd$, $sd$c0000000-0000-0000-0000-000000000002$sd$, 10, $sd$Старт · перед первым днём$sd$, $sd$Как устроена школа, что считается результатом — и как считается твоя зарплата: калькулятор, грейды, шкала бонуса. С подтверждением ознакомления.$sd$, NULL, true)
ON CONFLICT (id) DO UPDATE SET course_id = EXCLUDED.course_id, sort = EXCLUDED.sort, title = EXCLUDED.title, intro = EXCLUDED.intro, gate = EXCLUDED.gate, active = EXCLUDED.active;

INSERT INTO academy_lessons (id, module_id, sort, title, duration_label, cards, trainer, questions, body_html, links, pass_score, ack_text, active) VALUES
 ($sd$b0000000-0000-0000-0002-000000000001$sd$, $sd$a0000000-0000-0000-0002-000000000000$sd$, 10, $sd$Как работает школа$sd$, $sd$5 мин$sd$, '[]'::jsonb, NULL, $sd$[]$sd$::jsonb, $sd$<p>Семь дней, каждый день — 3–5 уроков и один зачёт. Урок — это выжимка из регламента компании плюс ссылка на оригинал. В конце урока — проверка из нескольких вопросов: она открывает следующий урок.</p>
<h4>Правила</h4>
<ul>
<li><b>Читай оригиналы.</b> Здесь — суть. Скрипты, чек-листы и таблицы нужно открыть и пройти руками.</li>
<li><b>Проверка — 80 %.</b> Чтобы урок засчитался, нужно ответить правильно минимум на 4 из 5. Пересдавать можно сколько угодно.</li>
<li><b>Зачёт принимает наставник.</b> Когда все уроки дня пройдены, нажми «Сдаю зачёт» и позови наставника. Он отметит «Зачтено» или «На доработку» — и откроется следующий день.</li>
<li><b>Прогресс сохраняется.</b> Наставник и РОП видят, на каком ты дне и что сдано.</li>
</ul>
<div class="callout"><b>Конечная станция.</b> Ты работаешь первоклассно, когда: стабильно закрываешь месячный план по «Светофору», держишь норму дня — 30 звонков, 3 демо, 2 КП, — у тебя ноль просроченных задач в CRM, ты ведёшь демо без наставника, закрываешь возражения по цене через ROI и приносишь отзывы клиентов.</div>$sd$, $sd$[{"t":"Адаптация · 7 дней","u":"https://docs.google.com/spreadsheets/d/1yWhWhz5WjgrRNJbmlEEVNYUX-PLW0oZFonoBxceoWq8/edit"},{"t":"Система адаптации · с ролёвками","u":"https://docs.google.com/document/d/17jj15c91WLh-98y21qjY6WSmDPXk84RTjkLeYg8C49Q/edit"},{"t":"Видео презентаций · плейлист YouTube","u":"https://youtube.com/playlist?list=PLh4oaxt-37pxM6bRL_paHB9TnvNq5Zzhy"}]$sd$::jsonb, NULL, NULL, true)
ON CONFLICT (id) DO UPDATE SET module_id = EXCLUDED.module_id, sort = EXCLUDED.sort, title = EXCLUDED.title, duration_label = EXCLUDED.duration_label, questions = EXCLUDED.questions, body_html = EXCLUDED.body_html, links = EXCLUDED.links, pass_score = EXCLUDED.pass_score, ack_text = EXCLUDED.ack_text, active = EXCLUDED.active;

INSERT INTO academy_lessons (id, module_id, sort, title, duration_label, cards, trainer, questions, body_html, links, pass_score, ack_text, active) VALUES
 ($sd$b0000000-0000-0000-0002-000000000002$sd$, $sd$a0000000-0000-0000-0002-000000000000$sd$, 20, $sd$Семь дней на одной странице$sd$, $sd$5 мин$sd$, '[]'::jsonb, NULL, $sd$[]$sd$::jsonb, $sd$<table class="tbl"><thead><tr><th>День</th><th>Тема</th><th>Что сдаёшь наставнику</th></tr></thead><tbody>
<tr><td>1</td><td>Принципы, оргсхема, рабочее место</td><td>Миссия «как клиенту», 10 секунд приветствия, поток клиента по оргсхеме</td></tr>
<tr><td>2</td><td>Рабочий день, воронка, CRM</td><td>Свой план дня, тестовая сделка, «взял в работу» vs «квалификация»</td></tr>
<tr><td>3</td><td>Продукт: база</td><td>Продукт за 60 секунд, разбор кейса, ответ на «у нас 1С»</td></tr>
<tr><td>4</td><td>Продукт: глубина, цена, ROI</td><td>5-минутная презентация, 3 возражения, расчёт ROI</td></tr>
<tr><td>5</td><td>Воронка и касания</td><td>Путь клиента своими словами, 3 follow-up</td></tr>
<tr><td>6</td><td>Скрипты и демо</td><td>4 ролёвки, тестовая сделка по всей воронке</td></tr>
<tr><td>7</td><td>Экзамен</td><td>Тест по продукту, большая ролёвка, CRM → допуск или 2 дня доработки</td></tr>
</tbody></table>
<p>После допуска начинается боевой режим: полные нормативы с первого дня, еженедельный балл по CRM и прослушка 5 звонков.</p>$sd$, $sd$[]$sd$::jsonb, NULL, NULL, true)
ON CONFLICT (id) DO UPDATE SET module_id = EXCLUDED.module_id, sort = EXCLUDED.sort, title = EXCLUDED.title, duration_label = EXCLUDED.duration_label, questions = EXCLUDED.questions, body_html = EXCLUDED.body_html, links = EXCLUDED.links, pass_score = EXCLUDED.pass_score, ack_text = EXCLUDED.ack_text, active = EXCLUDED.active;

INSERT INTO academy_lessons (id, module_id, sort, title, duration_label, cards, trainer, questions, body_html, links, pass_score, ack_text, active) VALUES
 ($sd$b0000000-0000-0000-0002-000000000003$sd$, $sd$a0000000-0000-0000-0002-000000000000$sd$, 30, $sd$Из чего складывается доход: калькулятор мотивации$sd$, $sd$15 мин$sd$, '[]'::jsonb, NULL, $sd$[{"q":"Четыре слагаемых дохода менеджера:","options":["Оклад + отпускные + премия + подарки","Оклад + премия KPI + бонус за план − отрицательные KPI","Оклад + бонус","Только процент с продаж"],"correct":1},{"q":"Какой вес у KPI 3 (CRM и отчётность)?","options":["10 %","20 %","40 %","60 %"],"correct":1},{"q":"KPI выполнен на 28 %. Сколько начислено по нему?","options":["28 % от премии","Половина","0","Полная премия"],"correct":2},{"q":"В примере из калькулятора самая большая часть дохода — это…","options":["Оклад","Премия KPI","Бонус за план продаж","Отрицательные KPI"],"correct":2},{"q":"Что относится к отрицательным KPI?","options":["Мало звонков","Опоздание, нет отчёта, жалоба клиента","Низкий средний чек","Отпуск"],"correct":1}]$sd$::jsonb, $sd$<p>Доход менеджера за месяц — четыре слагаемых. Калькулятор в таблице считает их автоматически: заполняются только план и факт.</p>
<div class="flow"><span class="node">Оклад грейда</span><span class="arr">+</span><span class="node">Премия KPI</span><span class="arr">+</span><span class="node me">Бонус за план продаж</span><span class="arr">−</span><span class="node">Отрицательные KPI</span></div>
<h4>Премия KPI — три показателя с весами</h4>
<table class="tbl"><thead><tr><th>KPI</th><th>Что считаем</th><th>Вес (ставит РОП)</th></tr></thead><tbody>
<tr><td><b>KPI 1</b></td><td>Исходящие звонки + сдача тестов и скрипта, в месяц</td><td>40 %</td></tr>
<tr><td><b>KPI 2</b></td><td>Количество встреч (демо), в месяц</td><td>40 %</td></tr>
<tr><td><b>KPI 3</b></td><td>CRM и отчётность — балл по чек-листу</td><td>20 %</td></tr>
</tbody></table>
<p>Потенциальная премия по KPI = премия грейда × вес. Начислено = потенциальная × % выполнения. <b>Ниже 50 % выполнения показатель не оплачивается</b> — в примере ниже KPI 2 на 28 % дал 0.</p>
<h4>Разбор примера из калькулятора</h4>
<table class="tbl"><thead><tr><th>Строка</th><th>План</th><th>Факт</th><th>%</th><th>Начислено</th></tr></thead><tbody>
<tr><td>Оклад грейда</td><td colspan="3">23 рабочих дня по плану, 23 по факту</td><td><b>40 000</b></td></tr>
<tr><td>KPI 1 · звонки и тесты</td><td>346</td><td>335</td><td>96,8 %</td><td>12 000 × 96,8 % = <b>11 618</b></td></tr>
<tr><td>KPI 2 · встречи</td><td>46</td><td>13</td><td>28,3 %</td><td><b>0</b> — ниже 50 %</td></tr>
<tr><td>KPI 3 · CRM</td><td>100</td><td>100</td><td>100 %</td><td>6 000 × 100 % = <b>6 000</b></td></tr>
<tr><td>Продажи</td><td>1 000 000</td><td>1 178 350</td><td>117,8 %</td><td>1 178 350 × 9,5 % = <b>111 943</b></td></tr>
<tr><td>Отрицательные KPI</td><td colspan="3">опоздание · нет отчёта · жалоба клиента — по 0</td><td><b>0</b></td></tr>
<tr><td><b>Итого за месяц</b></td><td colspan="3"></td><td><b>169 562</b></td></tr>
</tbody></table>
<div class="callout">Обрати внимание: 13 встреч вместо 46 стоили менеджеру 12 000 премии — больше, чем вся премия за звонки. Бонус за план (111 943) больше оклада и премии вместе: главное в доходе — продажи, а к ним ведут встречи.</div>
<h4>Отрицательные KPI</h4>
<ul><li>Опоздание</li><li>Нет отчёта</li><li>Жалоба клиента</li></ul>
<p>Каждое нарушение уменьшает бонус на фиксированную сумму (в калькуляторе — поле «Сумма уменьшения бонуса»). Штрафы и надбавки по чек-листу CRM — в дне 2.</p>$sd$, $sd$[{"t":"Калькулятор мотивации + система грейдов v7","u":"https://docs.google.com/spreadsheets/d/1TxsG_X50luEsCGcjvLp2bkFCxTKAyNq6T4lCmEpA34A/edit"}]$sd$::jsonb, NULL, NULL, true)
ON CONFLICT (id) DO UPDATE SET module_id = EXCLUDED.module_id, sort = EXCLUDED.sort, title = EXCLUDED.title, duration_label = EXCLUDED.duration_label, questions = EXCLUDED.questions, body_html = EXCLUDED.body_html, links = EXCLUDED.links, pass_score = EXCLUDED.pass_score, ack_text = EXCLUDED.ack_text, active = EXCLUDED.active;

INSERT INTO academy_lessons (id, module_id, sort, title, duration_label, cards, trainer, questions, body_html, links, pass_score, ack_text, active) VALUES
 ($sd$b0000000-0000-0000-0002-000000000004$sd$, $sd$a0000000-0000-0000-0002-000000000000$sd$, 40, $sd$Система грейдов: пять ступеней$sd$, $sd$20 мин$sd$, '[]'::jsonb, NULL, $sd$[{"q":"Сколько грейдов в справочнике отдела продаж?","options":["3","4","5","7"],"correct":2},{"q":"План продаж менеджера на испытательном сроке:","options":["300 000","500 000","1 000 000","3 000 000"],"correct":1},{"q":"Что нужно для перехода с испытательного срока на грейд «Менеджер»?","options":["Полгода стажа","Обучение 5П, тесты по продукту и CRM, 20 встреч, CRM на 5 клиентов, положительная ОС наставника","План 3 000 000","Сертификат по переговорам"],"correct":1},{"q":"Сколько встреч в месяц — план грейда «Менеджер по продажам»?","options":["20","40","60","100"],"correct":2},{"q":"Какой доп. бонус у Главного менеджера?","options":["ДМС для семьи","Корпоративный фитнес-абонемент","Автомобиль","Нет"],"correct":1},{"q":"Что должен вести Главный менеджер по условиям грейда?","options":["Бухгалтерию","Внутренние мини-обучения","Найм","Таргет"],"correct":1}]$sd$::jsonb, $sd$<p>Справочник грейдов отдела продаж «Зейд Плюс». Каждая ступень — свой оклад, премия, планы по KPI и продажам, процент бонуса и условия перехода по принципу <b>«Могу — хочу — делаю»</b>.</p>
<h4>Деньги и планы по грейдам</h4>
<table class="tbl"><thead><tr><th>Грейд</th><th>Оклад</th><th>Премия KPI</th><th>KPI 1 · звонки</th><th>KPI 2 · встречи</th><th>KPI 3 · CRM</th><th>План продаж</th><th>Мелкие / средние компании (лицензии)</th><th>Бонус от плана</th><th>Доп. бонус</th></tr></thead><tbody>
<tr><td><b>Менеджер (испытательный срок)</b></td><td>15 000</td><td>15 000</td><td>300</td><td>20</td><td>95</td><td>500 000</td><td>1 000 / 4 000</td><td>4 %</td><td>—</td></tr>
<tr><td><b>Менеджер по продажам</b></td><td>30 000</td><td>30 000</td><td>600</td><td>60</td><td>100</td><td>1 000 000</td><td>4 000 / 11 000</td><td>9,5 %</td><td>—</td></tr>
<tr><td><b>Главный менеджер</b></td><td>30 000</td><td>30 000</td><td>600</td><td>60</td><td>100</td><td>3 000 000</td><td>6 000 / 14 000</td><td>5 %</td><td>Корп. фитнес-абонемент</td></tr>
<tr><td><b>РОП (испытательный срок)</b></td><td>30 000</td><td>30 000</td><td colspan="3">Найм 2 менеджеров · ролевая встреча с руководителем (демо + закрытие на КЭВ) · адаптация 2 менеджеров</td><td>1 000 000</td><td>—</td><td>—</td><td>—</td></tr>
<tr><td><b>РОП</b></td><td>42 500</td><td>42 500</td><td colspan="3">Адаптация новичка за 14 дней / текучесть · 10 встреч с ключевыми клиентами · качество CRM отдела ≥ 95 %</td><td>10 000 000</td><td>10 000 / 30 000</td><td>3 %</td><td>Фитнес для семьи, корп. ДМС</td></tr>
</tbody></table>
<p>Колонка «Мелкие / средние компании» — разбивка плана по типам клиентов, как в справочнике.</p>
<h4>Условия перехода: «Могу — хочу — делаю»</h4>
<table class="tbl"><thead><tr><th>Грейд</th><th>Стаж в команде</th><th>Проф. знания</th><th>Готовность к задачам следующего грейда</th><th>Подтверждённый результат</th><th>Доп. условие</th></tr></thead><tbody>
<tr><td><b>Испытательный срок</b></td><td>0</td><td>Пройдено обучение 5П, тест по продукту и CRM</td><td>Готов принимать входящие, проводить первичную диагностику</td><td>Провёл 20 встреч, заполнил CRM на 5 клиентов, прошёл адаптацию</td><td>Позитивная обратная связь от наставника</td></tr>
<tr><td><b>Менеджер по продажам</b></td><td>1 мес</td><td>Тест по скриптам, работа с возражениями, просмотр 10 разборов встреч</td><td>Готов вести сделки до оплаты, планировать свою загрузку</td><td>План выполнен хотя бы 1 месяц, воронка корректна, нет грубых ошибок</td><td>Вовремя закрывает все задачи</td></tr>
<tr><td><b>Главный менеджер</b></td><td>12 мес</td><td>Сертификат по переговорам, ведёт внутренние мини-обучения, прочитано 2 книги по продажам, тест по сложным кейсам</td><td>Готов вести сложные сделки, участвовать в доработке скриптов и регламентов</td><td>Средний чек выше на 20 %, CRM без ошибок, конверсия встреча → сделка 20 %+, минимум 2 идеи по улучшению</td><td>Помогал команде в кризисной ситуации, успешно вёл сложные переговоры, проявляет инициативу</td></tr>
<tr><td><b>РОП (испытательный срок)</b></td><td>1–3 мес</td><td>Изучена продуктовая линейка, обучение по воронке SalesDoc, скрипты квалификация → демо → закрытие, базовые материалы по управлению продажами и CRM</td><td>Готов управлять командой из 2 менеджеров, проводить ролевые встречи и разбор звонков, контролировать воронку и задачи в CRM, внедрять скрипты и стандарты</td><td>Наняты 2 менеджера, прошли адаптацию и начали работу по воронке; запущена CRM-воронка; проведены первые квалификации и демо</td><td>Предложены идеи по улучшению продаж, внедрены первые стандарты, настроена базовая отчётность</td></tr>
<tr><td><b>РОП</b></td><td>24 мес</td><td>Сам провёл внутренний тренинг, систематизация ошибок, создание обучающих материалов</td><td>Готов управлять частью команды, внедрять системные улучшения</td><td>Рост по всем KPI в своей мини-группе, внедрены улучшения, подтверждено лидерство</td><td>Является опорой для команды и руководителя</td></tr>
</tbody></table>
<div class="callout">Маршрут замыкается: тот, кто прошёл эту школу и вышел на план, принимает зачёты у следующего. Ведение мини-обучений — условие грейда «Главный менеджер».</div>$sd$, $sd$[{"t":"Справочник система грейдов","u":"https://docs.google.com/spreadsheets/d/1TxsG_X50luEsCGcjvLp2bkFCxTKAyNq6T4lCmEpA34A/edit?gid=1605247468#gid=1605247468"},{"t":"Нематериальная мотивация","u":"https://docs.google.com/spreadsheets/d/1zZqiN3jgJYr1gqCllp6zVr0evJNlrEmdYAMKRoSsYXY/edit"}]$sd$::jsonb, NULL, NULL, true)
ON CONFLICT (id) DO UPDATE SET module_id = EXCLUDED.module_id, sort = EXCLUDED.sort, title = EXCLUDED.title, duration_label = EXCLUDED.duration_label, questions = EXCLUDED.questions, body_html = EXCLUDED.body_html, links = EXCLUDED.links, pass_score = EXCLUDED.pass_score, ack_text = EXCLUDED.ack_text, active = EXCLUDED.active;

INSERT INTO academy_lessons (id, module_id, sort, title, duration_label, cards, trainer, questions, body_html, links, pass_score, ack_text, active) VALUES
 ($sd$b0000000-0000-0000-0002-000000000005$sd$, $sd$a0000000-0000-0000-0002-000000000000$sd$, 50, $sd$Шкала бонуса: процент от выполнения плана$sd$, $sd$10 мин$sd$, '[]'::jsonb, NULL, $sd$[{"q":"Выполнил план на 45 %. Бонус:","options":["1 %","2,2 %","0","3 %"],"correct":2},{"q":"Менеджер по продажам выполнил план на 100 %. Процент бонуса:","options":["4 %","5 %","9,5 %","10 %"],"correct":2},{"q":"При каком выполнении плана у менеджера максимальные 10 %?","options":["100 %","110 %","121 % и выше","150 %"],"correct":2},{"q":"План 1 000 000, продано 950 000. Бонус менеджера:","options":["95 000","71 250","80 000","50 000"],"correct":1}]$sd$::jsonb, $sd$<p>Бонус за план продаж — это процент от суммы продаж. Процент зависит от того, на сколько выполнен план, и от грейда. До 50 % плана бонуса нет.</p>
<table class="tbl"><thead><tr><th>Выполнение плана</th><th>РОП</th><th>Главный менеджер</th><th>Менеджер по продажам</th><th>Менеджер (исп. срок)</th></tr></thead><tbody>
<tr><td>до 50 %</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>
<tr><td>51–60 %</td><td>1,2 %</td><td>2,2 %</td><td>3 %</td><td>2,2 %</td></tr>
<tr><td>61–74 %</td><td>1,5 %</td><td>2,5 %</td><td>4 %</td><td>2,3 %</td></tr>
<tr><td>75–80 %</td><td>1,8 %</td><td>3 %</td><td>5 %</td><td>2,5 %</td></tr>
<tr><td>81–85 %</td><td>2 %</td><td>3,5 %</td><td>6 %</td><td>3 %</td></tr>
<tr><td>86–90 %</td><td>2,2 %</td><td>3,8 %</td><td>7 %</td><td>3,3 %</td></tr>
<tr><td>91–95 %</td><td>2,5 %</td><td>4 %</td><td>7,5 %</td><td>3,5 %</td></tr>
<tr><td>96–99 %</td><td>2,8 %</td><td>4,5 %</td><td>8 %</td><td>3,8 %</td></tr>
<tr><td><b>100–120 %</b></td><td><b>3 %</b></td><td><b>5 %</b></td><td><b>9,5 %</b></td><td><b>4 %</b></td></tr>
<tr><td>121 % и выше</td><td>4 %</td><td>7 %</td><td>10 %</td><td>5 %</td></tr>
</tbody></table>
<h4>Как это работает на цифрах — грейд «Менеджер по продажам», план 1 000 000</h4>
<div class="kpis"><div><b>490 000</b><span>49 % плана → бонус 0</span></div><div><b>600 000</b><span>60 % → 3 % = 18 000</span></div><div><b>950 000</b><span>95 % → 7,5 % = 71 250</span></div><div><b>1 000 000</b><span>100 % → 9,5 % = 95 000</span></div><div><b>1 250 000</b><span>125 % → 10 % = 125 000</span></div></div>
<div class="callout">Шкала нелинейная: 95 % плана даёт 71 250, а 100 % — 95 000. Последние 50 000 продаж стоят почти 24 000 бонуса. Считай остаток до плана каждую неделю — для этого есть «Светофор» и декомпозиция цели.</div>$sd$, $sd$[{"t":"Справочник система грейдов · шкала бонуса","u":"https://docs.google.com/spreadsheets/d/1TxsG_X50luEsCGcjvLp2bkFCxTKAyNq6T4lCmEpA34A/edit?gid=1605247468#gid=1605247468"},{"t":"ZG Декомпозиция цели 2.0","u":"https://docs.google.com/spreadsheets/d/1qLyUKBRBsIkUQnNjBp3NmoeOZQuS8d6oMPY9P68ZL2s/edit"}]$sd$::jsonb, NULL, $sd$Я ознакомлен(а) с системой расчёта заработной платы: оклад грейда, премия KPI с весами, бонус за план продаж по шкале, отрицательные KPI, система грейдов и условия перехода. Вопросы по расчёту задал(а) наставнику.$sd$, true)
ON CONFLICT (id) DO UPDATE SET module_id = EXCLUDED.module_id, sort = EXCLUDED.sort, title = EXCLUDED.title, duration_label = EXCLUDED.duration_label, questions = EXCLUDED.questions, body_html = EXCLUDED.body_html, links = EXCLUDED.links, pass_score = EXCLUDED.pass_score, ack_text = EXCLUDED.ack_text, active = EXCLUDED.active;
