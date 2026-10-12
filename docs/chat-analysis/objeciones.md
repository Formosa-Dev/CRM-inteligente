# Анализ: как оператор обрабатывает возражения клиентов в WhatsApp

Источник: `chat_messages`, role='human' (оператор, ~26.2k сообщений) vs role='user' (клиент, ~23.9k), июнь–октябрь 2026, WhatsApp. Весь диалог на испанском (Formosa, Argentina).

## Важный контекст данных

- Из 653 разговоров ~354 выглядят коммерческими (есть слова pedido/hamburguesa/delivery/precio...). Остальные ~297 — личные чаты владельца с друзьями, сотрудниками, курьерами и B2B-партнёрами (обсуждение жизни, долгов, "yo hice 510mil"). Часть «возражений» в личных чатах — шутки, не продажи.
- `orders` в базе не отражает продажи из чатов (163 записи на весь период), поэтому «восстановление» мерялось по сигналам в переписке: адрес/доставка/оплата/продолжение заказа в течение 24ч после возражения.
- Часть ответов оператора — аудио (`[audio]`), т.е. часть логики ушёте в голос и не видна в тексте.
- В некоторых чатах рядом работает Karen (`role='assistant'`) — она берёт рутинные заказы (особенно B2B-хлеб), оператор подключается на нестандартное.

## Каталог возражений и частоты (коммерческие разговоры)

| Тип | ~кол-во за 4 мес | Типичные формулировки клиентов |
|---|---|---|
| Наличие/работа | ~110–120 | "no hay?", "no tenés?", "quedan?", "hacen envíos?", "trabajan hoy?", "se acabó", "están abiertos?" |
| Демора/delivery | ~30 | "cuánto tarda?", "demora mucho?", "todavía no llega", "esperando el delivery", "cuánto falta?" |
| Порции/размер | ~10–15 реальных | "alcanza para X?", "es grande?", "la porción es mediana?", "la porción es chica" |
| Цена | ~4–6 реальных | "descuento en efectivo hay?", "subió??", "re caro", "no llego al monto" |
| Сравнение | ~3–5 | "más barato", "en otro lado", "pedí en otro lugar" |
| Качество | ~3–5 | "está agrio", "estaba fría", "vino fea" |

Формулировки «y una porción de papas» — это строки заказа, не возражения; реальных вопросов про размер/порцию мало. Настоящего торга по цене в данных почти нет — клиенты либо берут, либо уходят.

## Как отвечает оператор — по типам

### Наличие / "нет?"
Два сценария:

**Есть** → короткое "Sii"/"Holaa sii" и СРАЗУ следующий шаг заказа:
- "hacen envíos?" → `Dale, me pasas ubicación` (июн)
- "trabajan hoy?" → `Holaa buenas` → дальше заказ
- "No tienen promo de hamburguesas!?" → `Con envio o buscas?` — вопрос переводит в логистику, продажа жива (авг)
- "te quedan??" → `Holaa sii` → "Con parmezano?" — продолжается (сен)

**Нет** → честно и коротко, плюс (если есть) замена или конкретное время восстановления:
- `No` → клиент "Busco lo otro entonces" — отпустил (авг)
- `Y dechar tampoco, estamos mandando las Hamburguesas con queso mozzarella` → клиент "Gracias amigo, otro día entonces" (июн)
- `Ahora ya estamos sin stock` + `Tipo 10a.m 11 salen recien del horno` — сказал нет, но дал точное время; клиент остался уточнять сроки (июн)
- `No tenemos todavía panes de lomito` + `Nuestro horario es apartir de las 16hs` — нет + график (июн)
- `El domingo no hacemos producción` — сухой факт, без давления (июн)
- `Me estoy quedando sin stock` → клиент "guárdame puto jaja" (регуляр просит зарезервировать) — подталкивать не пришлось, клиент сам настаивает (июн)

Кейс подмены (лучший пример recovery, conv 204, июн):
```
OP : Los chicos no hicieron su pedido de panes. De sésamo,
OP : Pero le mandamos con queso Parmesano no hay problema?
CLI: mismo precio?
OP : Sii
CLI: si no hay problema
```
Оператор сам предупредил о проблеме ДО вопроса, предложил замену с сохранением цены — клиент спокойно принял.

### Демора / "когда привезут?"
Всегда КОНКРЕТНАЯ цифра или статус — никогда "не знаю":
- "Y cuánto tarda" → `30 masomenos` (июн)
- "Cuánto se demora?" → `35min` (сен)
- "No tarda mucho verdad ?" → `Ya sale en 15` (июн)
- "Demora mucho?" → `Ya salieron` / `Ya salio` (июн-июл)
- "estoy esperando todavia no llega" → `El chico te habla` → клиент: "Sisi ya trajo" (сен)
- "Disculpa, se demora mucho?🥺" → `Ya salio su pedido, el chico te habla en breve` (сен)
- "Amigo ya vienen?" → `Sii amigo ya salio` + `Nada mas que vivis lejitos :/` — честная причина задержки с юмором (июл)

Неточность тоже конкретизируется: "Cuanto de demora?" → `Maso`, на уточнение "Cuánto maso" — опять цифра.

### Цена
Паттерн: **никаких скидок и никаких оправданий**. Плоский честный ответ — и точка.
- "Descuento en efectivo hay? O es mismo precio que transferencia?" → `Mismo precio` → клиент: `Perfecto!` — продал без скидки (июн)
- "2 mil pesos luego subió en dos días" → `Asi jomas es` ("такова жизнь") → клиент: `ah bueno ahí nomas` — принял (авг)
- "Subió??" → `Si` (июл)
- "no llego al monto" (не набрал минимум) → клиент отменил: `no confirme el pedido disculpa` → OP: `Wuee` — отпустил без попытки додавить (сен)
- Скидки оператор даёт, но только друзьям/своим (`Y te descuento la coca`, июл) — не как инструмент возражения для клиентов.

### Сравнение с конкурентами
- "buscan más barato" → `Gracias` — вообще не вступает в спор (B2B-контекст, июл)
- "Cómprale nms a ella /: ta más barato" → `Yo igual a vos nomas te compro` — шутливый ответ, лояльность держится на отношениях (авг)
- "Cómo no me respondían pedí en otro lugar gracias?" — клиент ушёл не из-за цены, а из-за МОЛЧАНИЯ: сделал веб-заказ, не получил ответа вовремя (июл). Это единственный найденный кейс потери к конкуренту — и причина скорость ответа, не торг.
- Комплименты тоже встречаются: "Ni en mostaza probé algo tan rico" — оператор просто "Sii".

### Качество / жалобы
- "la puse a calentar porque estaba fría... tiene un olor re fuerte, está agrio" → OP: аудио/видео + `Casi me comió en la esquina de tu casa` — шутка-разрядка вместо оправданий; клиент остался дружелюбен: "Las hamburguesas si estaban de 10" (июл)
- "Avísame que la porción de papa es chicaaaaa" → `Te gusto tu Hamburguesa` — уводит вопросом к позитиву; клиент: `Si gracias por las papas` (июн)
- "nunca me trajiste las prepizzas" (B2B, недовезли) → `Gracias` — минимальная реакция (июл)
- Извинений/возвратов в тексте почти нет — часть, видимо, решается голосом (`[audio]`). Формальных "disculpame/ofrezco reposición" оператор в тексте не пишет.

## Частота восстановления (оценочно, по сигналам заказа в 24ч)

| Тип | продолжение диалога | признак заказа ≤24ч | явный отказ |
|---|---|---|---|
| Наличие | ~99% | ~61% | ~23% |
| Демора | ~97% | ~71% | ~10% |
| Порции | ~99% | ~63% | ~12% |
| Сравнение | ~89% | ~43% | ~14% |
| Качество | ~100% | ~47% | ~12% |
| После "no hay/no tenemos" оператора | — | ~24% заказ в течение 24ч | ~2% явный уход |

Цифры ориентировочные: часть «заказов» видна по адресу/оплате/доставке в тексте, часть уходит в аудио и телефон.

## Техники «закрытия», реально используемые оператором

Это НЕ классические urgency/скидка. Его рабочие инструменты:

1. **Скорость ответа** — главный фактор. Единственная найденная потеря к конкуренту — из-за молчания, не из-за возражения.
2. **Конкретика вместо обещаний** — всегда число/статус: `30 masomenos`, `35min`, `Ya sale en 15`, `14200 seria todo`. Неточность тоже конкретна (`Maso` → по уточнению снова цифра).
3. **Вопрос-мост к следующему шагу** — после ответа на возражение сразу двигает воронку: `Con envio o buscas?`, `me pasas ubicación`, `A que dirección`, `Cuales`, `Para que hora necesita`.
4. **Замена, а не отказ** — нет позиции → предлагает ближайшее с тем же условием: `le mandamos con queso Parmesano no hay problema?` (критично: сам предупреждает до возражения клиента).
5. **Время восстановления вместо "нет"** — `Tipo 10a.m 11 salen recien del horno`, `horario apartir de las 16hs`. «Нет» всегда с датой/условием.
6. **Честность как доверие** — `vivis lejitos :/`, `Los domingos no hacemos producción`, `Mismo precio`, `Me olvide de avisarte`. Не врёт про сроки и наличие.
7. **Юмор/фамильярность** — `jajajaja`, `amigo`, `che`, шутка вместо извинения. Держит отношения тёплыми, клиенты возвращаются.
8. **Минимализм** — `Sii`, `Dalee`, `Nop`, `Bueno`. Никаких длинных объяснений.

## Когда НАСТАИВАЕТ vs когда ОТПУСКАЕТ

**Настаивает (сохраняет сделку):**
- позиция закончилась → замена или конкретное время новой партии;
- клиент спрашивает про наличие → ответ + мгновенный переход к заказу (`me pasas ubicación`);
- сам видит проблему до клиента (не та партия хлеба) → предупреждает и предлагает решение;
- регуляр/B2B — держит контакт, напоминает график, даёт точные числа.

**Отпускает (не давит):**
- клиент услышал честный ответ и сказал «нет»/«дорого»/«не дохожу» → `Wuee`, `Bueno`, тема закрыта;
- не может выполнить в принципе (выходной, зона, нет delivery) → говорит как есть, не обещает;
- клиент ушёл к конкуренту → не возвращает, не догоняет;
- общее правило: одна попытка сохранения (замена/время/вопрос), дальше — не навязчиво.

## Ограничения анализа

- Часть ответов — аудио (`[audio]`), там могла быть и аргументация по цене/качеству; в тексте её нет.
- ~300 личных чатов отфильтрованы эвристикой; на границах возможны ошибки отнесения.
- «Восстановление» меряется косвенными сигналами, не по заказам в базе.
- Возражения найдены по regex-каталогу — формулировки вне паттернов (опечатки, аудио клиентов) не учтены.

## REGLAS PARA EL AGENTE DE VENTAS

Готовые правила для системного промпта Karen (повторяют манеру оператора):

1. **Respondé rápido y corto.** Una respuesta lenta pierde más ventas que cualquier objeción. Máximo 1–2 frases por mensaje, rioplatense natural ("dale", "sisi", "masomenos").
2. **Siempre concreto, nunca vago.** Si preguntan demora → número: "unos 30–40 min masomenos". Si preguntan precio → número exacto. "No sé" está prohibido; si no sabés, decí cuándo lo averiguás ("ahora lo veo y te aviso").
3. **Después de responder la objeción, hacé la pregunta que avanza el pedido:** "¿con envío o pasás a buscar?", "¿me pasás la ubicación?", "¿para qué hora lo necesitás?", "¿cuál/es querés?". La objeción no es el final, es el paso previo al pedido.
4. **Sin stock → no decir solo "no hay".** Ofrecer (en este orden): a) sustituto con las mismas condiciones — "te mando con queso parmesano, mismo precio, ¿dale?"; b) hora concreta de reposición — "a las 10 salen recién del horno"; c) si nada aplica, honestidad + "cualquier cosa te aviso".
5. **Avisá el problema antes de que el cliente pregunte.** Si sabés que algo faltó/cambió, escribí primero: "te aviso que salió con parmesano en vez de sésamo, mismo precio". La advertencia previa vale más que la disculpa posterior.
6. **El precio no se negocia y no se justifica.** Si preguntan descuento → "mismo precio" / "es el precio que está". Si dicen "caro" → respuesta serena, sin defensa ("así nomás es"), y volver al paso siguiente. NUNCA inventar descuentos ni promociones. Los únicos descuentos reales son los que ya existen en el menú.
7. **Demora → estado concreto del pedido.** Si ya salió: "ya salió, el chico te habla en breve". Si está en preparación: "sale en unos X min". Si hay causa: decirla con naturalidad ("vivís lejitos 😅"). Jamás prometer tiempos irreales.
8. **Calidad / queja → no discutir, no defenderse con texto largo.** Reconocer con calma y naturalidad ("uh, qué raro", "mirá"), agradecer el aviso y si aplica, ofrecer compensación simple la próxima vez — sin admitir culpa formal ni prometer reembolsos que no existen.
9. **Un intento de salvar la venta, después soltar.** Si el cliente dice "no" después de una respuesta honesta → cerrar con onda: "dale, cualquier cosa me avisás" / "no hay problema, gracias igual". Nunca insistir dos veces ni presionar.
10. **Si no se puede, decir que no se puede.** Día sin producción, zona sin delivery, sin stock total → decirlo directo con el dato útil (cuándo sí), sin prometer lo imposible.
11. **Tono: cercano y con humor suave.** "amigo", "jajaja", emojis ligeros ocasionales, nada formal. Las relaciones largas venden más que los argumentos.
12. **Cuando el cliente ya está decidido, no molestar.** Si ya confirmó, pasar a logística (dirección, hora, pago) sin más charla de venta.
