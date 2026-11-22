import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {makeShop,hash,token,normalize,yookassa,diskLoader} from '../supabase/functions/_shared/core.js';
const schema=await readFile(new URL('../supabase/migrations/202611220001_course_shop.sql',import.meta.url),'utf8');
const demoSchema=await readFile(new URL('../supabase/migrations/20261122172614_demo_checkout.sql',import.meta.url),'utf8');
const A=900001,U=900002,V=900003,C=-100900000001;
async function fixture(t,overrides={}){
 const pg=new PGlite();t.after(()=>pg.close());await pg.exec('create role anon;create role authenticated;create role service_role;');await pg.exec(schema);await pg.exec(demoSchema);
 const settings={SITE_URL:'https://example.github.io/course/',SHOP_ADMIN_SECRET:'s'.repeat(43),TG_WEBHOOK_SECRET:'w'.repeat(43),ADMIN_CHAT_ID:String(A),COURSE_CHANNEL_ID:String(C),BOT_TOKEN:'test-only',BOT_USERNAME:'example_course_bot',YOOKASSA_SECRET_KEY:'test_unit_only',YOOKASSA_SHOP_ID:'100500',YANDEX_DISK_TOKEN:'unit-test'};
 Object.assign(settings,overrides);
 const env=k=>settings[k]||'';
 const db=async(op,p={})=>{
  const {rows}=op==='demo_decide'
   ?await pg.query('select public.cs_demo_decide($1::uuid,$2,$3) result',[p.id,p.accessHash,p.outcome])
   :await pg.query('select public.cs_rpc($1,$2::jsonb,$3::bigint,$4::bigint) result',[op,JSON.stringify(p),A,C]);
  return rows[0].result;
 };
 const calls=[],members=new Set(),pay=new Map();let counter=0,update=0,failMaterial=null;
 const bot=async(method,data)=>{
  if(method==='getChatMember')return {status:members.has(Number(data.user_id))?'member':'left'};
  if(method==='createChatInviteLink'){calls.push({method,data});return {invite_link:'https://t.me/+test_invite_'+(++counter)};}
  if(method==='approveChatJoinRequest')members.add(Number(data.user_id));
  if(method==='declineChatJoinRequest')members.delete(Number(data.user_id));
  if(method==='sendDocument'){
   const file=data.get('document');if(failMaterial===file.name){failMaterial=null;throw new Error('telegram_500');}
   calls.push({method,name:file.name,chat:data.get('chat_id'),bytes:new Uint8Array(await file.arrayBuffer())});return {message_id:++counter};
  }
  calls.push({method,data});return {message_id:++counter};
 };
 const payments={async create(o){if(pay.has(o.id))return pay.get(o.id);const q={id:crypto.randomUUID(),test:true,status:'pending',paid:false,amount:{value:(o.price/100).toFixed(2),currency:'RUB'},recipient:{account_id:settings.YOOKASSA_SHOP_ID},metadata:{order_id:o.id},confirmation:{confirmation_url:'https://yoomoney.ru/checkout/unit'}};pay.set(o.id,q);return q;},async get(id){return [...pay.values()].find(x=>x.id===id);}};
 const loadMaterial=async kind=>({bytes:new TextEncoder().encode('fixture-'+kind),name:kind==='txt'?'codex-lesson.txt':'codex-practice.xlsx',mime:'application/octet-stream'});
 const shop=makeShop({env,db,bot,loadMaterial,payments});
 async function http(route,data,cap,headers={}){
  const r=await shop.handle(new Request('https://backend.example/course-shop/'+route,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',Origin:'https://example.github.io',...(cap?{Authorization:'Bearer '+cap}:{}),...headers},...(data?{body:JSON.stringify(data)}:{})}));return {status:r.status,body:await r.json()};
 }
 const clientKeys=new Map();
 async function order(id=crypto.randomUUID(),packageId='start'){if(!clientKeys.has(id))clientKeys.set(id,await token('unit-client-random-secret',id));const r=await http('create',{requestId:id,packageId,clientKey:clientKeys.get(id)});assert.equal(r.status,200);return r.body;}
 async function paid(o){const p=pay.get(o.order.id);p.status='succeeded';p.paid=true;const r=await http('status',{id:o.order.id},o.accessToken);assert.equal(r.status,200);return r.body;}
 async function event(data){const e={update:++update,...data};await db('event',e);await shop.drain();return e;}
 async function start(o,user=U){return event({actor:user,private:true,action:'start',claimHash:await hash(await token(settings.SHOP_ADMIN_SECRET,'claim:'+o.order.id))});}
 async function join(o,user=U){const row=await db('order_internal',{id:o.order.id});return event({actor:user,action:'join',channel:C,invite:row.invite_link});}
 return {pg,db,settings,env,calls,members,pay,shop,http,order,paid,event,start,join,failNext(name){failMaterial=name;}};
}
test('Демо: подтверждение и отмена сохраняются, внешние платежи не затрагиваются',async t=>{
 const f=await fixture(t,{PAYMENT_MODE:'demo'});
 const draft=await f.order();
 assert.equal(draft.order.mode,'demo');
 assert.equal(draft.order.paymentState,'pending');
 assert.equal(draft.confirmationUrl,null);
 const decide=(purchase,outcome,access=purchase.accessToken)=>f.http('demo-payment',{id:purchase.order.id,outcome},access);
 assert.equal((await decide(draft,'paid','q'.repeat(43))).status,404);
 assert.equal((await decide(draft,'unknown')).status,400);
 const paid=await decide(draft,'paid');
 assert.equal(paid.status,200);
 assert.equal(paid.body.order.paymentState,'paid');
 assert.match(paid.body.telegramUrl,/^https:\/\/t\.me\//);
 assert.equal((await decide(draft,'paid')).body.order.paymentState,'paid');
 assert.equal((await decide(draft,'canceled')).status,409);

 const declined=await f.order();
 assert.equal((await decide(declined,'canceled')).body.telegramUrl,null);
 assert.equal((await decide(declined,'paid')).status,409);
 assert.equal((await f.http('status',{id:declined.order.id},declined.accessToken)).body.order.paymentState,'canceled');

 const externalId=crypto.randomUUID(),externalKey='b'.repeat(43);
 await f.db('create',{id:externalId,package:'start',accessHash:await hash(externalKey),claimHash:await hash(externalId),ipHash:'external',mode:'robokassa_test'});
 assert.equal((await f.http('demo-payment',{id:externalId,outcome:'paid'},externalKey)).status,404);
 assert.equal((await f.http('create',{requestId:externalId,packageId:'start',clientKey:externalKey})).status,409);
 assert.equal((await f.db('order_internal',{id:externalId})).payment_state,'pending');
 assert.equal(f.pay.size,0);
 await f.pg.exec('set role anon');
 await assert.rejects(()=>f.pg.query("select public.cs_demo_decide($1,'wrong','paid')",[draft.order.id]),/permission denied/i);
 await f.pg.exec('reset role');
});
test('Robokassa: тестовая ссылка и подтверждение только через подписанное уведомление',async t=>{
 const f=await fixture(t,{PAYMENT_MODE:'robokassa_test',ROBOKASSA_MERCHANT_LOGIN:'unit_shop',ROBOKASSA_TEST_PASSWORD_1:'unit-pass-one',ROBOKASSA_TEST_PASSWORD_2:'unit-pass-two'});
 const purchase=await f.order();
 const {id,number,mode}=purchase.order;
 const invoice=String(number);
 const checkout=new URL(purchase.confirmationUrl);
 assert.equal(mode,'robokassa_test');
 assert.equal(checkout.origin,'https://auth.robokassa.ru');
 assert.equal(checkout.searchParams.get('IsTest'),'1');
 assert.equal(checkout.searchParams.get('InvId'),invoice);
 assert.equal(checkout.searchParams.get('Shp_order'),id);
 assert.equal(checkout.searchParams.get('SignatureValue'),await hash('unit_shop:590.00:'+invoice+':unit-pass-one:Shp_order='+id));
 assert.equal(f.pay.size,0);
 const callback=async(amount,password,orderId=id,invoiceId=invoice)=>{
  const SignatureValue=await hash([amount,invoiceId,password,'Shp_order='+orderId].join(':'));
  const body=new URLSearchParams({OutSum:amount,InvId:invoiceId,SignatureValue,Shp_order:orderId});
  return f.shop.handle(new Request('https://backend.example/course-shop/robokassa-result',{method:'POST',body}));
 };
 const status=()=>f.http('status',{id},purchase.accessToken);
 assert.equal((await status()).body.telegramUrl,null);
 assert.equal((await callback('590.00','unit-pass-one')).status,400);
 assert.equal((await callback('1.00','unit-pass-two')).status,400);
 assert.equal((await callback('590.00','unit-pass-two',crypto.randomUUID())).status,400);
 assert.equal((await callback('590.00','unit-pass-two',id,'999')).status,400);
 assert.equal((await status()).body.order.paymentState,'pending');
 for(const amount of ['590.00','590.000000']){
  const ok=await callback(amount,'unit-pass-two');
  assert.equal(ok.status,200);
  assert.equal(await ok.text(),'OK'+invoice);
 }
 assert.equal((await status()).body.order.paymentState,'paid');
 assert.match((await status()).body.telegramUrl,/^https:\/\/t\.me\//);
 await f.start(purchase);
 await f.join(purchase);
 assert.equal(f.calls.filter(x=>x.method==='sendDocument').length,0);
 await f.event({actor:A,private:true,action:'approve',order:id});
 assert.equal(f.calls.filter(x=>x.method==='sendDocument').length,2);
});
test('Полный путь: тестовый PSP, привязка, заявка, модератор, два файла',async t=>{
 const f=await fixture(t),o=await f.order();assert.equal(o.order.mode,'yookassa_test');
 assert.equal((await f.http('status',{id:o.order.id},o.accessToken)).body.telegramUrl,null);
 const p=await f.paid(o);assert.match(p.telegramUrl,/https:\/\/t.me\/example_course_bot\?start=/);
 await f.start(o);assert.equal(f.calls.filter(x=>x.method==='sendDocument').length,0);
 const invite=f.calls.find(x=>x.method==='createChatInviteLink');assert.equal(invite.data.creates_join_request,true);assert.equal(invite.data.member_limit,undefined);
 await f.join(o);assert.equal((await f.db('order_internal',{id:o.order.id})).access_state,'requested');
 assert.equal(f.calls.filter(x=>x.method==='sendDocument').length,0);
 await f.event({actor:A,private:true,action:'approve',order:o.order.id});
 const docs=f.calls.filter(x=>x.method==='sendDocument');assert.deepEqual(docs.map(x=>x.name),['codex-lesson.txt','codex-practice.xlsx']);
 assert.ok(docs.every(x=>Number(x.chat)===U));assert.equal((await f.db('order_internal',{id:o.order.id})).access_state,'approved');
 assert.equal((await f.db('summary')).failed,0);
});
test('Отмена и неоплаченная покупка не дают приглашение',async t=>{
 const f=await fixture(t),o=await f.order();await f.start(o);assert.ok(!f.calls.some(x=>x.method==='createChatInviteLink'));
 const p=f.pay.get(o.order.id);p.status='canceled';const status=await f.http('status',{id:o.order.id},o.accessToken);assert.equal(status.body.order.paymentState,'canceled');await f.start(o);assert.equal(f.calls.filter(x=>x.method==='sendDocument').length,0);
});
test('Повторы покупки и событий, привязка только одному аккаунту',async t=>{
 const f=await fixture(t),id=crypto.randomUUID(),o=await f.order(id),repeat=await f.order(id);
 assert.equal(o.accessToken,repeat.accessToken);assert.equal(f.pay.size,1);
 assert.equal((await f.http('create',{requestId:id,packageId:'site',clientKey:o.accessToken})).status,409);
 assert.equal((await f.http('create',{requestId:id,packageId:'start',clientKey:'a'.repeat(43)})).status,409);
 await f.paid(o);await f.start(o);await f.start(o,V);assert.equal(Number((await f.db('order_internal',{id})).telegram_user),U);
 await f.join(o);const e={update:100,actor:A,private:true,action:'approve',order:id};await f.db('event',e);await f.db('event',e);await f.shop.drain();
 assert.equal(f.calls.filter(x=>x.method==='approveChatJoinRequest').length,1);assert.equal(f.calls.filter(x=>x.method==='sendDocument').length,2);
 await f.event({actor:U,action:'member',channel:C,member:true});assert.equal(f.calls.filter(x=>x.method==='sendDocument').length,2);
});
test('Правда PSP важнее браузера и webhook; несовпадение суммы отклоняется',async t=>{
 const f=await fixture(t),o=await f.order(),payment=f.pay.get(o.order.id);
 assert.equal((await f.http('status',{id:o.order.id},'wrong')).status,404);
 const forged=await f.http('payment',{type:'notification',event:'payment.succeeded',object:{id:payment.id,status:'succeeded',test:true}});
 assert.equal(forged.status,200);assert.equal((await f.db('order_internal',{id:o.order.id})).payment_state,'pending');
 payment.status='succeeded';payment.paid=true;payment.amount.value='1.00';assert.equal((await f.http('status',{id:o.order.id},o.accessToken)).status,503);
 assert.equal((await f.db('order_internal',{id:o.order.id})).payment_state,'pending');
 payment.amount.value='590.00';payment.test=false;assert.equal((await f.http('status',{id:o.order.id},o.accessToken)).status,503);
 assert.equal((await f.http('demo-pay',{id:o.order.id},o.accessToken)).status,404);
});
test('Другой пользователь, ссылка и посторонний модератор не дают файлы',async t=>{
 const f=await fixture(t),o=await f.order();await f.paid(o);await f.start(o);await f.join(o,V);
 assert.equal((await f.db('order_internal',{id:o.order.id})).access_state,'invited');
 await f.join(o);await f.event({actor:V,private:true,action:'approve',order:o.order.id});assert.equal(f.calls.filter(x=>x.method==='approveChatJoinRequest').length,0);
 await f.event({actor:U,private:true,action:'materials'});assert.equal(f.calls.filter(x=>x.method==='sendDocument').length,0);
});
test('Одобрение в самом Telegram тоже выдаёт материалы, отказ не выдаёт',async t=>{
 const f=await fixture(t),o=await f.order();await f.paid(o);await f.start(o);await f.join(o);
 await f.event({actor:A,private:true,action:'decline',order:o.order.id});assert.equal(f.calls.filter(x=>x.method==='sendDocument').length,0);
 await f.start(o);await f.join(o);f.members.add(U);await f.event({actor:U,action:'member',channel:C,member:true});assert.equal(f.calls.filter(x=>x.method==='sendDocument').length,2);
});
test('Ошибка второй отправки сохраняется; повтор не дублирует первый файл',async t=>{
 const f=await fixture(t),o=await f.order();await f.paid(o);await f.start(o);await f.join(o);f.failNext('codex-practice.xlsx');
 await f.event({actor:A,private:true,action:'approve',order:o.order.id});assert.equal(f.calls.filter(x=>x.method==='sendDocument').length,1);assert.equal((await f.db('summary')).failed,1);
 await f.event({actor:V,private:true,action:'retry'});assert.equal(f.calls.filter(x=>x.method==='sendDocument').length,1);
 await f.event({actor:A,private:true,action:'retry'});assert.equal(f.calls.filter(x=>x.method==='sendDocument').length,2);
 assert.equal(f.calls.filter(x=>x.name==='codex-lesson.txt').length,1);
});
test('Аренда очереди не выдаёт один job двум worker; SQL закрыт от anon',async t=>{
 const f=await fixture(t);await f.db('event',{update:1,actor:U,private:true,action:'id'});
 const first=await f.db('claim'),second=await f.db('claim');assert.equal(first.length,1);assert.equal(second.length,0);
 await f.db('sent',{id:first[0].id,lease:crypto.randomUUID()});assert.equal((await f.db('summary')).pending,1);
 await f.pg.exec("update course_shop.outbox set leased_until=now()-interval '1 second'");const recovered=await f.db('claim');assert.equal(recovered[0].id,first[0].id);assert.notEqual(recovered[0].lease,first[0].lease);
 await f.pg.exec('set role anon');await assert.rejects(()=>f.pg.query('select * from course_shop.orders'),/permission denied/i);await assert.rejects(()=>f.pg.query("select public.cs_rpc('catalog')"),/permission denied/i);await f.pg.exec('reset role');
});
test('Проверки HTTP, секретов webhook, групп и живого членства',async t=>{
 const f=await fixture(t);assert.equal((await f.http('catalog',null,null,{Origin:'https://evil.example'})).status,403);
 assert.equal((await f.http('telegram',{update_id:1})).status,401);assert.equal((await f.http('worker',{})).status,401);
 assert.equal(normalize({update_id:1,message:{chat:{id:U,type:'group'},from:{id:U},text:'/materials'}}),null);
 assert.equal(normalize({update_id:1,message:{chat:{id:U,type:'private'},from:{id:V},text:'/id'}}),null);
 const o=await f.order();await f.paid(o);await f.start(o);await f.join(o);await f.event({actor:A,private:true,action:'approve',order:o.order.id});f.members.delete(U);
 await f.event({actor:U,private:true,action:'materials'});assert.equal(f.calls.filter(x=>x.method==='sendDocument').length,2);
});
test('Быстрая заявка до фиксации приглашения откатывает update и повторяется',async t=>{
 const f=await fixture(t),o=await f.order();await f.paid(o);
 await f.db('event',{update:1,actor:U,private:true,action:'start',claimHash:await hash(await token(f.settings.SHOP_ADMIN_SECRET,'claim:'+o.order.id))});
 await f.db('claim');const e={update:2,actor:U,action:'join',channel:C,invite:'https://t.me/+race'};
 await assert.rejects(()=>f.db('event',e),/invite_mapping_pending/);
 assert.equal((await f.pg.query('select count(*)::int n from course_shop.updates where update_id=2')).rows[0].n,0);
 await f.db('invited',{id:o.order.id,link:e.invite,expires:Math.floor(Date.now()/1000)+3600,job:1});await f.db('event',e);assert.equal((await f.db('order_internal',{id:o.order.id})).access_state,'requested');
});
test('ЮKassa: боевой ключ и нетестовый магазин блокируются до создания платежа',async()=>{
 let posts=0;const data={YOOKASSA_SECRET_KEY:'live_forbidden',YOOKASSA_SHOP_ID:'100500',SITE_URL:'https://example.com/'};
 const fetcher=async(url,init)=>{if(init.method==='POST')posts++;return new Response(JSON.stringify({test:false,account_id:'100500'}));};
 let p=yookassa(k=>data[k]||'',fetcher);await assert.rejects(()=>p.create({id:crypto.randomUUID(),price:59000,number:1}),/test_shop_required/);assert.equal(posts,0);
 data.YOOKASSA_SECRET_KEY='test_unit';p=yookassa(k=>data[k]||'',fetcher);await assert.rejects(()=>p.create({id:crypto.randomUUID(),price:59000,number:1}),/test_shop_required/);assert.equal(posts,0);
});
test('Яндекс: приватная загрузка, контроль версии и отказ постороннему URL',async()=>{
 const bytes=new TextEncoder().encode('sample');let href='https://downloader.disk.yandex.ru/file';const settings={YANDEX_DISK_TOKEN:'unit-private',YANDEX_TEXT_PATH:'disk:/nobel_lesson3/codex-lesson.txt',MATERIAL_TXT_SHA256:await hash(bytes)};const calls=[];
 const fetcher=async(url,init={})=>{calls.push({url:String(url),init});return String(url).startsWith('https://cloud-api.yandex.net/')?new Response(JSON.stringify({href})):new Response(bytes);};
 const load=diskLoader(k=>settings[k]||'',fetcher);assert.equal(new TextDecoder().decode((await load('txt')).bytes),'sample');assert.equal(calls[0].init.headers.Authorization,'OAuth unit-private');assert.equal(calls[1].init.headers,undefined);
 href='https://evil.example/file';await assert.rejects(()=>load('txt'),/disk_download_url/);
 href='https://downloader.disk.yandex.ru/file';settings.MATERIAL_TXT_SHA256='0'.repeat(64);await assert.rejects(()=>load('txt'),/material_version_mismatch/);
});

test('Яндекс: переход на хранилище без токена, запрет чужого адреса и циклов',async()=>{
 const bytes=new TextEncoder().encode('redirected');let target='https://mds.storage.yandex.net/file';const calls=[];
 const settings={YANDEX_DISK_TOKEN:'private',YANDEX_TEXT_PATH:'disk:/nobel_lesson3/codex-lesson.txt',MATERIAL_TXT_SHA256:await hash(bytes)};
 const fetcher=async(url,init)=>{calls.push({url:String(url),init});if(String(url).startsWith('https://cloud-api.yandex.net/'))return new Response(JSON.stringify({href:'https://downloader.disk.yandex.ru/file'}));if(String(url).startsWith('https://downloader.disk.yandex.ru/'))return new Response(null,{status:302,headers:{Location:target}});return new Response(bytes);};
 const load=diskLoader(k=>settings[k]||'',fetcher);assert.equal(new TextDecoder().decode((await load('txt')).bytes),'redirected');assert.equal(calls.length,3);assert.equal(calls[2].init.headers,undefined);assert.equal(calls[2].init.redirect,'manual');
 target='https://evil.example/file';await assert.rejects(()=>load('txt'),/disk_download_url/);assert.equal(calls.some(c=>c.url.includes('evil.example')),false);
 target='https://downloader.disk.yandex.ru/file';await assert.rejects(()=>load('txt'),/disk_redirect/);
 const broken=diskLoader(k=>settings[k]||'',async()=>{throw new Error('https://private.example/signed-secret');});await assert.rejects(()=>broken('txt'),/^Error: disk_network$/);
});
