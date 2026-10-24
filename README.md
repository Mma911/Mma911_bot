# SCDP Deriv Cloud Server v4.2.1 — دليل النشر والتشغيل الحقيقي

هذه الحزمة **real-money v4.2.1** لخدمة Node.js تنفّذ عقود Deriv Options على حساب حقيقي، بعد تأكيد صريح لكل إعدادات السوق والتحليل والمخاطر. يبدأ الخادم **مفصولاً**: لا يتصل بـ Deriv حتى `POST /connect` المصرّح به، ولا يرسل شراءً حتى يراجع المشغّل التأكيد الكامل ثم يرسل `POST /start`.

> **تحذير:** التداول الحقيقي قد يخسر المال. لا توجد ضمانات ربح. نفّذ كل خطوة وأنت تراجع الحساب والقيم بنفسك.

## ما الذي ينفّذه التطبيق؟

- الإعداد الافتراضي `frxEURUSD` والعملة `USD` وإطار التحليل 60 ثانية. يمكن للمشغّل تغيير السوق وإطار التحليل ومدة العقد، وإعدادات مؤشرات الاستراتيجية وحدود المخاطر من لوحة Android. تبقى معادلات المؤشرات وشروط CALL/PUT ثابتة؛ تتغير المعاملات فقط. يعرض الخادم الأسواق النشطة التي يتحقق من دعمها لعقدي `CALL` و`PUT`.
- يطلب OTP عبر REST ثم يستخدم **Real WebSocket فقط**: `wss://api.derivws.com/trading/v1/options/ws/real?...otp=...`. يرفض Demo وأي مسار WebSocket آخر. لا تستخدم إرشادات `legacy authorize`.
- لا يفتح اتصال Deriv عند إقلاع الخدمة. يطلب العميل الإداري `POST /connect` اتصالًا مصادقًا صراحةً؛ تبقى الخدمة متوقفة. بعد ذلك يقرأ الرصيد والتاريخ والتيكات أثناء التهيئة. `/start` يجري preflight للاتجاهين دون شراء، ثم يفعّل التداول عند نجاحه؛ ليس شراءً فوريًا.
- تُحمى جميع مسارات الحالة والتحكم برأس `Authorization: Bearer ADMIN_TOKEN`. جسر CORS يجيز فقط `Origin: null` لتطبيق Android المعبأ محلياً؛ لا يجيز مصادر ويب عامة أخرى.
- يشتري عقدًا واحدًا كحد أقصى في كل مرة، ويحفظ نية الشراء قبل `buy`. إذا أصبحت نتيجة الشراء غامضة يقفل الشراء حتى `reconcile` يدويًا؛ لا يعيد الشراء تلقائيًا.
- بعد انقطاع الاتصال أو إعادة الاتصال يتوقف ويحتاج `POST /start` جديدًا. لا توجد استئنافية تلقائية بعد crash/restart.
- حدود الجلسة وإعدادات السوق والمدة والمارتينغيل محفوظة على القرص الدائم ولا تُصفّر بـ `/start`. بعد إعادة التشغيل تُستعاد الإعدادات، لكن التداول يظل متوقفاً ويتطلب اتصالاً وتأكيداً وبدءاً يدوياً جديداً؛ لا يحتاج الخادم إلى بقاء الهاتف مفتوحاً.
- يمكن تعديل الإعدادات فقط عبر `ADMIN_TOKEN` عندما يكون التداول متوقفاً، ولا يوجد عقد مفتوح أو شراء غير محسوم، والخادم متصل وجاهز. المارتينغيل متوقف افتراضياً؛ عند تفعيله يظل مقيداً بسقف الرهان وحد الخسارة والخسائر المتتالية وبحد مستقل لخطوات الزيادة `maxMartingaleSteps` (عدد صحيح 0–10، افتراضي 3). يوقف أول حد متحقق التداول؛ كل الحدود تبقى سارية معاً.
- قيم ATR للوقف والهدف **تحليلية فقط** وليست أوامر وقف خسارة أو جني ربح ولا أوامر إغلاق مبكر. لا ضمان للأرباح. لا يصدر الخادم تنبيه الصوت المحلي ولا يحسب تقييم الشموع التاريخي الخاص بالمحاكاة؛ خيار `binCandles` التاريخي لا يغيّر شروط الدخول ولا يتاح كخيار تنفيذ سحابي.

الملف XML الأصلي `strategy-source/SCDP_Deriv_Analysis_Settings_Demo.xml` يحتفظ باسم **Demo لأغراض provenance فقط**؛ ليس وضع تنفيذ. المنفّذ هو `strategy.js`، وهو غير معدّل تلقائيًا من XML.

## المتطلبات والبناء

- Node.js **20 أو أحدث**.
- خدمة واحدة فقط وقرص دائم. لا تستخدم replicas أو autoscaling أو نشرين متداخلين.
- استمرار الخدمة يعتمد على خطة الاستضافة ووقت التشغيل والشبكة؛ لا يوجد ضمان 24/7 أو ضد النوم/إعادة التشغيل/الانقطاعات. Android لوحة تحكم فقط ولا يلزم أن تبقى مفتوحة، لكن إغلاقها لا يمنع قيود الاستضافة أو فقد اتصال الخادم.

```sh
npm ci
npm start
```

`npm start` يشغّل `node server.js`. يستمع الخادم على `0.0.0.0`، ويستخدم `PORT` الذي تعطيه الاستضافة تلقائيًا (والافتراضي المحلي `3000`).

## النشر اليدوي من GitHub إلى Render

هذا دليل نشر يدوي فقط؛ **لا ينفّذ نشرًا فعليًا**.

1. فك ZIP وارفع محتويات مجلد `deriv-railway-bot` إلى جذر مستودع GitHub، بحيث يكون `package.json` في الجذر. لا ترفع `.env` أو `node_modules` أو رموزًا حقيقية.
2. في Render أنشئ Web Service من المستودع، واضبط:
   - **Build Command:** `npm ci`
   - **Start Command:** `npm start`
   - Node.js 20+.
3. أضف Persistent Disk واربطه عند `/var/data` **قبل** التداول.
4. استخدم متغير الحالة التالي حرفيًا: `STATE_FILE=/var/data/scdp-real/state.json`.
5. شغّل **نسخة واحدة فقط**: لا replicas، ولا autoscaling، ولا نشر متداخل. أوقف النسخة القديمة قبل تشغيل الجديدة.
6. بعد ضبط المتغيرات، افتح `GET /` لفحص الصحة العام فقط. استخدم واجهة Android أو `POST /connect` ثم `/status` و`/confirmation` و`/start`؛ جميعها تتطلب الرمز.

### متغيرات البيئة

| المتغير | المطلوب والقيمة |
|---|---|
| `DERIV_APP_ID` | معرّف تطبيق Deriv المرتبط بـ PAT |
| `DERIV_PAT` | PAT للحساب الحقيقي بصلاحية **`trade` فقط/المطلوبة للتداول**؛ لا تطلب `account_manage` ولا تحتاج إلى إنشاء حساب جديد |
| `DERIV_ACCOUNT_ID` | معرّف الحساب الحقيقي، وليس البريد الإلكتروني |
| `ADMIN_TOKEN` | سر تحكم عشوائي طوله 24 حرفًا على الأقل؛ يرسل كرأس Bearer |
| `STATE_FILE` | مطلوب، مسار مطلق على القرص الدائم: `/var/data/scdp-real/state.json` |
| `DERIV_SYMBOL` | اختياري؛ رمز سوق افتراضي صالح عند إنشاء الحالة لأول مرة. قائمة الأسواق الحية والتحقق من دعم `CALL`/`PUT` يجريان في الخادم؛ الإعداد المحفوظ على القرص الدائم له الأولوية بعد ذلك |
| `PORT` | اختياري؛ Render يضبطه تلقائيًا، وإلا يستخدم التطبيق `3000` |

استخدم عنوان HTTPS الخاص بـ Render لكل أوامر التحكم ولا تكشف منفذ HTTP المباشر للإنترنت. لا تُضمّن الأسرار في GitHub أو عنوان URL. استخدم حساب Options حقيقيًا موجودًا؛ هذه الخدمة لا تنشئ حسابًا. لا تستخدم `legacy authorize`. لا يقرأ `npm start` ملف `.env` تلقائيًا؛ عرّف القيم في بيئة الاستضافة. للتشغيل المحلي يمكن استخدام `node --env-file=.env server.js` على Node الداعم لذلك.

## دورة التأكيد الآمن (مطلوب قبل كل بدء)

### تغيير السوق والمدة والتحليل وحدود المخاطر

من تبويب «الإعدادات» في تطبيق Android 1.4.1، اتصل بالخادم v4.2.1 وانتظر حالة «متصل وجاهز»، ثم حمّل قائمة الأسواق. يطلب الخادم `active_symbols: "brief"` مع `contract_type: ["CALL", "PUT"]`، ويقرأ الحقول الحالية `underlying_symbol` و`underlying_symbol_name` (مع دعم أسماء الاستجابة القديمة)، ثم يتحقق عبر `contracts_for` من العقدين. لا يستخدم `product_type` الذي أُزيل من مخطط Deriv الحالي.

اختر السوق وإطار تحليل الشموع ومدة العقد ووحدتها؛ هذه إعدادات منفصلة. يمكن ضبط EMA، RSI، نافذة MACD، ADX، ATR ومنع تكرار الاتجاه. القيم الافتراضية تطابق المحرك السابق: EMA 50، RSI 14/50، MACD 12/26/9، نافذة 1، ADX 14/20 مفعّل، ATR 14، مضاعفا التحليل 2 و0.5، والشموع المغلقة فقط؛ منع التكرار والمارتينغايل متوقفان افتراضياً، وحد خطوات الزيادة 3. إضافة التحكم لا تغيّر صيغ المؤشرات أو منطق تقاطع MACD وشروط EMA/RSI/ADX؛ ولا تحوّل مستويات ATR إلى أوامر وقف.

اضبط أيضاً الرهان الأساسي، والمارتينغايل ومعامله وسقفه وعدد خطوات الزيادة `maxMartingaleSteps` (0–10؛ الافتراضي 3)، وحد خسارة الجلسة وهدف الربح وعدد الصفقات والخسائر المتتالية. حد الخسائر المتتالية وخطوات الزيادة مستقلان، ويوقف أول حد يتحقق. حفظ الإعدادات لا يبدأ التداول؛ يتحقق الخادم من جميع القيم، ويحفظها ذرياً في `STATE_FILE`، ويعيد تهيئة بيانات الشموع. التغيير مرفوض أثناء التداول، أو أي عملية مشغولة، أو وجود عقد مفتوح/شراء غير محسوم، أو غياب الاتصال الجاهز. بعد الحفظ حمّل تأكيداً جديداً، وراجع السوق والإطار والمدة والتحليل وحدود المخاطر قبل كل بدء. إذا رفض Deriv مدة العقد، يفشل الفحص المسبق قبل تفعيل التداول أو الشراء.

إذا ظهرت قائمة فارغة، يعرض التطبيق عدد الرموز المرشحة/المرفوضة وأمثلة رموز ورسائل أخطاء `contracts_for`. وإذا رفض Deriv طلب القائمة، يظهر رمز الخطأ ورسالة API ويكتب الخادم سطراً يبدأ بـ `[markets]`. شارك التشخيص ورمز/رسالة الخطأ فقط عند طلب المساعدة، ولا تشارك `ADMIN_TOKEN` أو `DERIV_PAT`.

عيّن متغيرات محلية في الصدفة، من دون وضع رموز حقيقية في هذا الملف:

```sh
export BASE_URL='https://YOUR-RENDER-SERVICE.onrender.com'
export ADMIN_TOKEN='YOUR_ADMIN_TOKEN'
```

### 1) اطلب confirmation واحفظه

```sh
curl --fail-with-body "$BASE_URL/confirmation" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -o confirmation.json
```

ينجح الطلب فقط إذا كانت الخدمة متصلة وجاهزة، والحساب الحقيقي مصادقًا، والخدمة متوقفة، ولا يوجد شراء غير محسوم. الـ JSON الكامل يتضمن `accountId` الفعلي، و`nonce`، و`expiresAt` بعد خمس دقائق. شكله الكامل (مع إبقاء القيم الديناميكية كما أعادها الخادم) هو:

```json
{
  "mode": "real",
  "accountId": "ACCOUNT_ID_RETURNED_BY_SERVER",
  "currency": "USD",
  "symbol": "frxEURUSD",
  "granularity": 60,
  "duration": 1,
  "durationUnit": "m",
  "analysisSettings": {
    "granularity": 60, "emaPeriod": 50, "rsiPeriod": 14, "rsiLevel": 50,
    "crossWindow": 1, "useAdxFilter": true, "adxPeriod": 14, "adxMin": 20,
    "atrPeriod": 14, "atrStopMult": 2, "atrTargetMult": 0.5,
    "noRepeatDirection": false, "macd": {"fast": 12, "slow": 26, "signal": 9},
    "closedCandleOnly": true
  },
  "riskLimits": {
    "baseStake": 1,
    "maxStake": 4,
    "maxLoss": 10,
    "takeProfit": 5,
    "maxTrades": 20,
    "maxConsecutiveLosses": 3,
    "maxMartingaleSteps": 3,
    "useMartingale": false,
    "martingaleFactor": 2
  },
  "nextStake": 1,
  "session": {
    "sessionProfit": 0,
    "tradesCount": 0,
    "lossStreak": 0
  },
  "confirmation": "I CONFIRM REAL MONEY TRADING AND ACCEPT THESE EXACT MARKET, ANALYSIS, STAKE AND RISK SETTINGS",
  "nonce": "NONCE_RETURNED_BY_SERVER",
  "expiresAt": "ISO_TIMESTAMP_FIVE_MINUTES_FROM_ISSUE"
}
```

### 2) راجع الملف يدويًا

```sh
cat confirmation.json
```

تحقق بنفسك من الحساب والسوق وإطار التحليل والمدة وجميع قيم `analysisSettings` و`riskLimits` **بالضبط**، بما فيها `nextStake` والعملة، ومن عبارة التأكيد الكاملة. لا تعدّل الملف؛ يتأكد الخادم من تطابقه مع التحدي والقيم الحالية ويرفض أي تغيير.

### 3) بعد المراجعة الصريحة فقط، أرسل JSON نفسه

```sh
curl --fail-with-body "$BASE_URL/start" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @confirmation.json
```

الأمران منفصلان عمدًا: **لا تستخدم pipeline للموافقة التلقائية** مثل `curl .../confirmation | curl .../start`. جسم `/start` يُستهلك مرة واحدة حتى عند الفشل؛ عند أي فشل أو انتهاء صلاحية اطلب confirmation جديدًا وراجعه من جديد.

## الحالة والإيقاف والمصالحة

### الحالة

```sh
curl --fail-with-body "$BASE_URL/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

راجع خصوصًا `connected` و`ready` و`realAuthenticated` و`tradingEnabled` و`pending` و`stopReason` و`lastError` و`strategy`.

### الإيقاف

```sh
curl --fail-with-body -X POST "$BASE_URL/stop" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

الإيقاف يمنع المشتريات الجديدة فقط. **لا يلغي `buy` أُرسل بالفعل ولا يغلق عقدًا مفتوحًا**؛ يستمر العقد في المتابعة حتى التسوية.

### المصالحة بعد نتيجة شراء غامضة

لا تستخدم `reconcile` إلا بعد مراجعة سجل حساب Deriv يدويًا، ومعرفة `contractId` الصحيح، وكون الخدمة متوقفة وجاهزة و`pending.phase` يشير إلى شراء غير محسوم:

```sh
curl --fail-with-body -X POST "$BASE_URL/reconcile" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"contractId":123456789}'
```

يفحص التطبيق الرمز والاتجاه والسعر ووقت الشراء قبل ربط العقد. لا تحذف السجل ولا تعاود الشراء لتجاوز القفل. إذا لم تجد عقدًا مؤكدًا، اترك القفل قائمًا وتحقق مع Deriv.

## السجل الدائم واستعادة الأعطال

الحالة تُحفظ ذرياً في `/var/data/scdp-real/state.json` بصيغة real مرتبطة بالحساب، وتشمل إعدادات السوق والتحليل والمدة والمخاطر وسجل العقود. تُرحّل سجلات v4.1 ذات إعدادات التداول القديمة إلى قيم التحليل الحالية الافتراضية مع الحفاظ على حدود المخاطر المحفوظة؛ وتبقى دفاتر Demo أو mismatch الحساب/الإصدار مرفوضة. لا تنسخ أو تحذف **live state** لتصفير القفل أو حدود المخاطر. بعد إعادة التشغيل تعود الإعدادات نفسها، لكن الموافقة والتداول يظلان متوقفين حتى يبدأ المشغّل يدوياً.

بعد crash أو فقد الاتصال: شغّل الخدمة، أرسل `POST /connect` المصرّح به، افحص `/status`، راجع `pending` وسجل Deriv، واستخدم `/reconcile` إن لزم، ثم اطلب confirmation جديدًا وابدأ يدويًا. لا يوجد resume تلقائي.

## عقد Android API

كل المسارات التالية، ما عدا `GET /` للصحة العامة، تتطلب `Authorization: Bearer ADMIN_TOKEN`. لا ترسل PAT أو أي سر Deriv إلى Android.

1. `POST /connect` — يطلب اتصال WebSocket حقيقيًا ويهيّئ السوق؛ لا يفعّل التداول. الاستجابة تعيد `status`، وقد تبقى `connected=false` إذا فشلت المصادقة أو الشبكة.
2. `GET /status` — الحالة التشغيلية: `connected`, `ready`, `realAuthenticated`, `tradingEnabled`, `pending`, `lastTrade`, `lastError`, `stopReason`, و`strategy`.
3. `GET /settings` — الإعدادات الفعلية المخزنة وحالة السماح بالتعديل.
4. `GET /markets` — قائمة أسواق Deriv النشطة ذات عقود `CALL` و`PUT` المتاحة؛ تتطلب اتصالاً جاهزاً وتُخزّن مؤقتاً لدقيقتين.
5. `POST /settings` — يحفظ السوق وإطار التحليل والمدة ومعاملات EMA/RSI/ADX/ATR وقيود الرهان والمارتينغيل بعد تحقق الخادم؛ لا يسمح بالتعديل أثناء التداول أو وجود عقد غير محسوم.
6. `GET /confirmation` ثم `POST /start` — دورة التأكيد اليدوي الموضحة أعلاه. لا تبنِ موافقة تلقائية في التطبيق.
7. `POST /stop` — يمنع المشتريات الجديدة ولا يلغي شراءً أُرسل أو عقدًا مفتوحًا.
8. `POST /disconnect` — يوقف التداول ويغلق العميل؛ أعد تشغيل الخدمة قبل طلب اتصال جديد.
9. `GET /pnl` — يعيد `sessionProfit`, `tradesCount`, `lossStreak`, `lastProfit`, والصفقة المعلّقة.
10. `GET /trades?limit=50` أو `GET /history?limit=50` — سجل آخر 1–200 صفقة مسوّاة بترتيب الأحدث أولًا. السجل محدود بـ200 عنصر ومحفوظ ضمن ملف الحالة الدائم.
11. `POST /reconcile` مع `{"contractId":123}` — للمشتريات غير المحسومة فقط، وبعد تحقق يدوي من سجل Deriv.

تستخدم جميع استجابات التحكم JSON؛ أخطاء المصادقة `401`، ومدخلات `limit` غير الصحيحة `400`، وفشل دورة التشغيل أو الحالة `409`.

## الاختبارات وحدود التحقق

```sh
npm ci
npm test
```

الاختبارات mocked ومحلية؛ لا تحتاج credentials ولا اتصالًا حيًا، ولا تثبت التحقق الحي من Deriv أو نشرًا أو تنفيذ صفقات. لم تُنفّذ بهذه الحزمة صفقات أو deployments حقيقية.

## مصادر Deriv المفتوحة

- [Options WebSocket](https://developers.deriv.com/docs/options/websocket/)
- [Real Options WebSocket](https://developers.deriv.com/docs/options/ws-real/)
- [Proposal API comparison](https://developers.deriv.com/comparison/proposal/)
- [Active symbols](https://developers.deriv.com/comparison/active-symbols/)
- [Contracts for](https://developers.deriv.com/comparison/contracts-for/)
