# توثيق API الخادم v4.4.0

## اختيار الوضع وعزل الحسابات

يتطلب كل مسار خاص بالحساب `Authorization: Bearer ADMIN_TOKEN`. يقبل المسار `?mode=real` أو `?mode=demo`؛ وإذا لم يُرسل الوضع، يكون Real للحفاظ على توافق العملاء السابقين. Demo غير متاح إذا لم يكن `DERIV_DEMO_ACCOUNT_ID` وسجل `STATE_FILE_DEMO` قد أُعدّا على الخادم. `GET /modes` يعيد فقط الأوضاع المهيأة؛ لا يفتح اتصال Deriv.

تحتفظ كل وضع بمحرك واستراتيجية وعميل WebSocket وتأكيد بدء وسجل مخاطر وصفقات مستقل. لا يمكن مشاركة التأكيد بينهما، ويجب أن يحمل طلب `/start` الوضع نفسه. إذا أرسل المستخدم `mode=demo` مع خادم Real-only، يعيد الخادم `404` بدلاً من توجيه الطلب إلى Real. كل المسارات القديمة بلا `mode` تبقى على Real.

## PAT → OTP عبر REST → WebSocket

لكل حساب يطلب الخادم `POST https://api.derivws.com/trading/v1/options/accounts/{accountId}/otp` باستخدام `Authorization: Bearer PAT` و`Deriv-App-ID`. يتحقق العميل من أن رابط OTP يحتوي المضيف `api.derivws.com` والمسار المطابق تماماً للوضع: `/trading/v1/options/ws/real` أو `/trading/v1/options/ws/demo`، ومعامل `otp` واحد فقط. لا يقبل عميل Real عنوان Demo، ولا يقبل عميل Demo عنوان Real. لا تتصل الخدمة عند الإقلاع؛ الاتصال يطلب لكل وضع صراحةً عبر `POST /connect?mode=...`.

## مسارات الحالة والتحكم

- `GET /modes` — قائمة الأوضاع المهيأة وحالة كل اتصال، دون كشف PAT.
- `GET /status?mode=demo`، `/settings?mode=...`، `/pnl?mode=...`، `/trades?mode=...` و`/history?mode=...` — بيانات الوضع المحدد فقط.
- `GET /markets?mode=...` — الأسواق النشطة التي تحقق الخادم من دعمها لعقود `CALL` و`PUT`.
- `GET /market-data?mode=...&symbol=frxEURUSD&granularity=60` — الشموع وعقد الحساب المفتوح إن وجد وتقييم اتجاهي تاريخي؛ قراءة فقط ولا يرسل `proposal` أو `buy`.
- `POST /settings?mode=...` — حفظ إعدادات الوضع المحدد، بعد التحقق، والتوقف، والاتصال الجاهز، وعدم وجود عقد أو شراء غير محسوم.
- `GET /confirmation?mode=...` ثم `POST /start?mode=...` — تأكيد منفصل ودقيق للحساب والسوق والإطار والمدة والتحليل والمخاطر. Real يستخدم عبارة Real، وDemo عبارة Demo/virtual funds.
- `POST /stop?mode=...` و`POST /disconnect?mode=...` — يخصان الوضع المحدد ولا يوقفان الوضع الآخر.
- `POST /reconcile?mode=...` مع `contractId` — لحالة شراء غير محسومة في سجل ذلك الحساب فقط وبعد التحقق اليدوي.

## الأسواق والتقييم التاريخي

يستخدم الخادم `active_symbols: "brief"` مع `contract_type: ["CALL", "PUT"]`، ثم يتحقق عبر `contracts_for` من توفر العقدين. لا يستخدم `product_type` القديم. وتقتصر الأسواق البديلة في الرسم على القائمة التي تحقق منها الخادم؛ لقطات الرسم البديل تُخزّن مؤقتاً 30 ثانية.

قيمة `simulation` تقيس دقة اتجاه شروط الإشارة المحفوظة عند إغلاق الشمعة بعد أفق المدة. ليست نتائج تداول Demo، ولا سجل صفقات فعلية، ولا عائد عقد Deriv أو ربحية. لا تُحسب نسبة إذا كانت المدة بوحدة تيك، أو غير متوافقة تماماً مع إطار الشموع، أو تعذر الحصول على تاريخ ودقة سعر كافيين. لا تضمن النسبة نتيجة مستقبلية.

## الاختبارات وحدودها

تعمل اختبارات الخادم محلياً دون PAT أو حساب Deriv أو اتصال حي. توثق النهايات فقط؛ لم يُتحقق هنا من صلاحية حساب أو PAT، ولم يُنشر الخادم أو توضع صفقات.

## مصادر Deriv الرسمية

- [Options OTP](https://developers.deriv.com/docs/options/websocket/)
- [Workflow: account ID selects Demo or Real OTP URL](https://developers.deriv.com/docs/workflows/)
- [Demo WebSocket](https://developers.deriv.com/docs/options/ws-demo/) · [Real WebSocket](https://developers.deriv.com/docs/options/ws-real/)
- [Get Options accounts](https://developers.deriv.com/docs/options/get-accounts/)
