(() => {
 const element = id => document.getElementById(id);
 const endpoint = String(window.SHOP_CONFIG?.endpoint || '').replace(/\/$/, '');
 const fallback = [
  {id:'start',title:'Старт с Codex',description:'Первый небольшой проект и понятный план практики',price:59000},
  {id:'site',title:'Сайт своими руками',description:'От идеи до страницы с работающими действиями',price:149000},
  {id:'practice',title:'Больше практики',description:'Тот же учебный канал и материалы для проверки всей цепочки',price:249000}
 ];
 const storageKey = 'nobel-course-shop-v1';
 const intentKey = storageKey + '.intent';
 const currency = new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:0});
 const money = price => currency.format(price / 100);
 const paymentStates = {pending:'ожидается',paid:'подтверждена',canceled:'отменена'};
 const accessStates = {
  unlinked:'аккаунт Telegram ещё не связан',linked:'бот запущен',invited:'приглашение выдано',
  requested:'ждём модератора',approving:'модератор открывает доступ',
  approved:'канал доступен',declining:'заявка отклоняется',declined:'модератор отклонил заявку'
 };

 let packages = fallback;
 let paymentMode = null;
 let ready = false;
 let selection = null;
 let order = null;
 let busy = false;
 let lastFocus = null;

 function read(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
 }
 function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
 }
 function clearIntent(id) {
  if (read(intentKey)?.requestId !== id) return;
  try { localStorage.removeItem(intentKey); } catch {}
 }
 function restore() {
  const saved = read(storageKey);
  if (saved?.id && saved?.accessToken) return saved;
  const pending = read(intentKey);
  if (pending?.requestId && pending?.clientKey) {
   return {id:pending.requestId,accessToken:pending.clientKey,packageId:pending.packageId,mode:pending.mode};
  }
  return null;
 }
 function intent(packageId) {
  const old = read(intentKey);
  if (old?.packageId === packageId && old.mode === paymentMode && old.requestId && old.clientKey) return old;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const clientKey = btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  const pending = {requestId:crypto.randomUUID(),packageId,clientKey,mode:paymentMode};
  write(intentKey,pending);
  return pending;
 }
 function external(value, kind) {
  try {
   const url = new URL(value);
   if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
   if (kind === 'telegram') return url.hostname === 't.me' ? url.href : null;
   if (url.hostname === 'auth.robokassa.ru' && url.pathname === '/Merchant/Index.aspx' && url.searchParams.get('IsTest') === '1') return url.href;
   return ['yoomoney.ru','yookassa.ru'].some(host => url.hostname === host || url.hostname.endsWith('.'+host)) ? url.href : null;
  } catch { return null; }
 }
 async function api(path, data, accessToken) {
  if (!endpoint) throw new Error('Сервер пока не подключён.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
   const response = await fetch(endpoint + '/' + path, {
    method:data ? 'POST' : 'GET',
    headers:{'Content-Type':'application/json',...(accessToken ? {Authorization:'Bearer '+accessToken} : {})},
    ...(data ? {body:JSON.stringify(data)} : {}),
    signal:controller.signal
   });
   const reply = await response.json();
   if (!response.ok) throw new Error(reply.error || 'Не удалось выполнить запрос.');
   return reply;
  } catch (error) {
   if (error.name === 'AbortError') throw new Error('Сервис не ответил вовремя. Попробуйте проверить статус.');
   if (error instanceof TypeError) throw new Error('Нет связи с сервером. Попробуйте ещё раз.');
   throw error;
  } finally { clearTimeout(timer); }
 }
 function notice(text, error = false) {
  element('notice').textContent = text;
  element('notice').classList.toggle('error',error);
 }
 function actions(...visible) {
  for (const id of ['pay','demo-confirm','demo-cancel','refresh','telegram','resume']) {
   element(id).hidden = !visible.includes(id);
  }
 }
 function payLabel() {
  if (paymentMode === 'demo') return 'Создать учебный заказ';
  const provider = {robokassa_test:'Robokassa',yookassa_test:'ЮKassa'}[paymentMode];
  return provider ? 'Перейти к оплате в '+provider : 'Перейти к тестовой оплате';
 }
 function render() {
  const box = element('packages');
  box.replaceChildren();
  packages.forEach(item => {
   const card = document.createElement('article');
   card.className = 'package';
   const heading = document.createElement('h3');
   heading.textContent = item.title;
   const description = document.createElement('p');
   description.className = 'description';
   description.textContent = item.description;
   const price = document.createElement('p');
   price.className = 'price';
   price.textContent = money(item.price);
   const button = document.createElement('button');
   button.type = 'button';
   button.textContent = 'Выбрать пакет';
   button.setAttribute('aria-label','Выбрать пакет «'+item.title+'»');
   button.addEventListener('click',() => open(item,button));
   card.append(heading,description,price,button);
   box.append(card);
  });
 }
 function open(item, focus) {
  lastFocus = focus || document.activeElement;
  selection = item;
  order = null;
  element('dialog-title').textContent = item.title;
  element('summary').textContent = money(item.price)+' · доступ в учебный канал и два файла';
  element('progress').textContent = '';
  element('pay').textContent = payLabel();
  element('pay').disabled = !ready;
  actions('pay');
  notice(!ready ? 'Доступен просмотр пакетов. Оплата пока подключается.'
   : paymentMode === 'demo' ? 'Сайт сохранит заказ. Затем можно выбрать подтверждение или отмену. Карта не нужна.'
   : 'Используйте тестовые платёжные данные на странице оплаты.');
  element('purchase').showModal();
 }
 function update(reply) {
  const result = reply.order;
  const sameOrder = order?.id === result.id;
  const isDemo = result.mode === 'demo';
  const confirmationUrl = external(reply.confirmationUrl,'payment') || (sameOrder ? order.confirmationUrl : null);
  order = {...order,id:result.id,packageId:result.packageId,mode:result.mode,confirmationUrl};
  write(storageKey,order);
  if (result.paymentState !== 'pending') clearIntent(result.id);
  element('dialog-title').textContent = 'Покупка №'+result.number;
  const packageTitle = packages.find(item => item.id === result.packageId)?.title || 'Учебный пакет';
  element('summary').textContent = packageTitle + ' · ' + money(result.price);
  element('progress').textContent = 'Оплата: '+paymentStates[result.paymentState]+' · Доступ: '+accessStates[result.accessState];

  if (result.paymentState === 'paid') {
   const link = external(reply.telegramUrl,'telegram');
   if (link) {
    element('telegram').href = link;
    actions('telegram','refresh');
    notice(result.accessState === 'approved' ? 'Доступ подтверждён. Учебные файлы находятся в боте.'
     : 'Оплата подтверждена. Запустите бота и подайте заявку в канал. Файлы придут после одобрения.');
   } else {
    actions('refresh');
    notice('Учебная оплата подтверждена, деньги не списаны. Следующий шаг — запуск Telegram-бота после подключения канала.');
   }
  } else if (result.paymentState === 'canceled') {
   actions('refresh');
   notice('Учебная оплата отменена. Доступ по этой покупке закрыт. Выберите пакет ещё раз для новой попытки.');
  } else if (isDemo) {
   actions('demo-confirm','demo-cancel','refresh');
   notice('Заказ сохранён. Выберите результат учебной оплаты. Сумма указана для примера.');
  } else if (confirmationUrl && result.mode === paymentMode) {
   element('resume').href = confirmationUrl;
   actions('resume','refresh');
   notice('Платёж ожидает подтверждения. Завершите его на тестовой странице платёжного сервиса.');
  } else {
   actions('refresh');
   notice('Платёж ещё не подтверждён. Выберите пакет заново, чтобы начать покупку в текущем режиме.');
  }
 }
 async function run(task, message) {
  if (busy) return;
  busy = true;
  const buttons = ['pay','demo-confirm','demo-cancel','refresh'].map(element);
  buttons.forEach(button => { button.disabled = true; });
  notice(message);
  try { await task(); } catch (error) { notice(error.message,true); }
  finally {
   busy = false;
   buttons.forEach(button => { button.disabled = button.id === 'pay' && !ready; });
  }
 }
 element('pay').addEventListener('click',() => {
  if (!selection || !ready) return;
  run(async () => {
   const pending = intent(selection.id);
   const reply = await api('create',{requestId:pending.requestId,packageId:pending.packageId,clientKey:pending.clientKey});
   order = {id:reply.order.id,accessToken:reply.accessToken,packageId:selection.id,mode:reply.order.mode,confirmationUrl:external(reply.confirmationUrl,'payment')};
   write(storageKey,order);
   if (reply.order.mode === 'demo') {
    update(reply);
    element('demo-confirm').focus();
   } else if (reply.order.paymentState === 'paid') {
    update(await api('status',{id:order.id},order.accessToken));
   } else if (order.confirmationUrl) {
    location.assign(order.confirmationUrl);
   } else {
    throw new Error('Не удалось получить ссылку на тестовую оплату.');
   }
  },'Сохраняем учебный заказ…');
 });
 function decide(outcome) {
  if (!order || order.mode !== 'demo') return;
  run(async () => update(await api('demo-payment',{id:order.id,outcome},order.accessToken)),'Сохраняем результат оплаты…');
 }
 function refresh() {
  if (!order) return;
  run(async () => update(await api('status',{id:order.id},order.accessToken)),'Проверяем статус оплаты…');
 }
 element('demo-confirm').addEventListener('click',() => decide('paid'));
 element('demo-cancel').addEventListener('click',() => decide('canceled'));
 element('refresh').addEventListener('click',refresh);
 element('close').addEventListener('click',() => { if (!busy) element('purchase').close(); });
 element('purchase').addEventListener('cancel',event => { if (busy) event.preventDefault(); });
 element('purchase').addEventListener('close',() => lastFocus?.focus());

 function resume() {
  const saved = restore();
  if (!saved) { alert('В этом браузере пока нет сохранённой покупки. Выберите пакет.'); return; }
  const item = packages.find(item => item.id === saved.packageId) || packages[0];
  if (!item) return;
  open(item,element('restore'));
  order = saved;
  actions('refresh');
  refresh();
 }
 element('restore').addEventListener('click',resume);
 async function init() {
  const banner = element('connection');
  render();
  try {
   const catalog = await api('catalog');
   packages = catalog.packages;
   ready = catalog.paymentConfigured;
   paymentMode = catalog.paymentMode;
   render();
   banner.hidden = ready && catalog.telegramConfigured;
   banner.textContent = !ready ? 'Оплата временно недоступна.'
    : !catalog.telegramConfigured ? 'Подключение Telegram ещё завершается.' : '';
  } catch { banner.textContent = 'Оплата временно недоступна. Попробуйте обновить страницу.'; }
  if (new URLSearchParams(location.search).has('order')) {
   history.replaceState({},'',location.pathname);
   if (restore()) resume();
   else {
    banner.textContent = 'Откройте покупку в том же браузере, в котором начали оплату.';
    banner.hidden = false;
   }
  }
 }
 init();
})();
