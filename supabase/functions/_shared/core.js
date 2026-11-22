const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder=new TextEncoder();
export async function hash(value){const b=typeof value==='string'?encoder.encode(value):value;return [...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function token(secret,value){const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(value))))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');}
export async function equal(a,b){if(!a||!b||a.length>512||b.length>512)return false;const x=await hash(a),y=await hash(b);let d=0;for(let i=0;i<x.length;i++)d|=x.charCodeAt(i)^y.charCodeAt(i);return d===0;}
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}});
const member=m=>['member','administrator','creator'].includes(m?.status)||(m?.status==='restricted'&&m.is_member===true);
export function makeRpc(env,fetcher=fetch){
 let key=env('SERVER_DB_KEY')||env('SUPABASE_SERVICE_ROLE_KEY');
 if(!key&&env('SUPABASE_SECRET_KEYS')){const x=JSON.parse(env('SUPABASE_SECRET_KEYS'));key=x.default||Object.values(x).find(v=>typeof v==='string');}
 return async(op,data={})=>{
  const r=await fetcher(env('SUPABASE_URL')+'/rest/v1/rpc/cs_rpc',{method:'POST',headers:{apikey:key,...(key?.startsWith('eyJ')?{Authorization:'Bearer '+key}:{}),'Content-Type':'application/json'},body:JSON.stringify({p_op:op,p:data,p_admin:Number(env('ADMIN_CHAT_ID')||0),p_channel:Number(env('COURSE_CHANNEL_ID')||0)}),signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw new Error('database_'+r.status);return r.json();
 };
}
export function telegram(env,fetcher=fetch){return async(method,payload)=>{
 try{
  const form=payload instanceof FormData;
  const r=await fetcher('https://api.telegram.org/bot'+env('BOT_TOKEN')+'/'+method,{method:'POST',headers:form?{}:{'Content-Type':'application/json'},body:form?payload:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});
  const data=await r.json();if(!r.ok||!data.ok)throw new Error('telegram_'+(data.error_code||r.status));return data.result;
 }catch(e){throw new Error(/^telegram_\d+$/.test(e.message)?e.message:'telegram_network');}
};}
export function yookassa(env,fetcher=fetch){
 let verifiedUntil=0;
 const call=async(path,method='GET',payload,key)=>{
  if(!/^test_/.test(env('YOOKASSA_SECRET_KEY'))||!/^\d+$/.test(env('YOOKASSA_SHOP_ID')))throw new Error('test_shop_required');
  let r;
  try{r=await fetcher('https://api.yookassa.ru/v3/'+path,{method,headers:{Authorization:'Basic '+btoa(env('YOOKASSA_SHOP_ID')+':'+env('YOOKASSA_SECRET_KEY')),'Content-Type':'application/json',...(key?{'Idempotence-Key':key}:{})},...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(18000)});}catch{throw new Error('payment_network');}
  if(!r.ok)throw new Error('payment_'+r.status);return r.json();
 };
 const ensure=async()=>{if(Date.now()<verifiedUntil)return;const me=await call('me');if(me.test!==true||String(me.account_id)!==env('YOOKASSA_SHOP_ID'))throw new Error('test_shop_required');verifiedUntil=Date.now()+60000;};
 return {
  async create(o){await ensure();return call('payments','POST',{amount:{value:(o.price/100).toFixed(2),currency:'RUB'},capture:true,confirmation:{type:'redirect',return_url:env('SITE_URL')+'?order='+o.id},description:'NOBEL · учебная покупка №'+o.number,metadata:{order_id:o.id}},o.id);},
  async get(id){if(!UUID.test(id||''))throw new Error('payment_id');await ensure();return call('payments/'+id);}
 };
}

const ROBO_MODE='robokassa_test';
const ROBO_CHECKOUT='https://auth.robokassa.ru/Merchant/Index.aspx';

function robokassa(env){
 const login=env('ROBOKASSA_MERCHANT_LOGIN');
 const password1=env('ROBOKASSA_TEST_PASSWORD_1');
 const password2=env('ROBOKASSA_TEST_PASSWORD_2');
 const ready=/^[A-Za-z0-9_.-]{1,100}$/.test(login)&&Boolean(password1&&password2&&password1!==password2);
 return {
  ready,
  async checkout(order){
   if(!ready||!Number.isSafeInteger(Number(order.number))||Number(order.number)<1||Number(order.number)>2147483647)throw new Error('robokassa_config');
   const invoice=String(order.number);
   const amount=(order.price/100).toFixed(2);
   const signature=await hash([login,amount,invoice,password1,'Shp_order='+order.id].join(':'));
   const url=new URL(ROBO_CHECKOUT);
   url.search=new URLSearchParams({MerchantLogin:login,OutSum:amount,InvId:invoice,Description:'NOBEL · учебная покупка №'+invoice,SignatureValue:signature,IsTest:'1',Shp_order:order.id});
   return {id:'robo:'+invoice,url:url.href};
  },
  async result(req){
   if(!ready)return null;
   if(req.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/x-www-form-urlencoded')return null;
   const fields=new URLSearchParams(new TextDecoder().decode(await limitedBytes(req,8192)));
   const amount=fields.get('OutSum'),invoice=fields.get('InvId');
   const signature=fields.get('SignatureValue'),orderId=fields.get('Shp_order');
   if(['OutSum','InvId','SignatureValue','Shp_order'].some(key=>fields.getAll(key).length!==1))return null;
   if([...fields.keys()].some(key=>/^shp_/i.test(key)&&key!=='Shp_order'))return null;
   const value=amount?.match(/^(\d{1,8})\.(\d{2})0{0,4}$/);
   if(!value)return null;
   if(!/^[1-9]\d{0,9}$/.test(invoice)||!UUID.test(orderId)||!/^[a-f0-9]{64}$/i.test(signature))return null;
   const expected=await hash([amount,invoice,password2,'Shp_order='+orderId].join(':'));
   if(!await equal(signature.toLowerCase(),expected))return null;
   return {invoice,orderId,paymentId:'robo:'+invoice,price:Number(value[1])*100+Number(value[2])};
  }
 };
}
async function limitedBytes(r,limit){
 if(Number(r.headers.get('content-length'))>limit)throw new Error('file_too_large');
 const reader=r.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new Error('file_too_large');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const data=new Uint8Array(size);let p=0;for(const c of chunks){data.set(c,p);p+=c.length;}return data;
}
export function diskLoader(env,fetcher=fetch){return async(kind)=>{
 try{
 const path=env(kind==='txt'?'YANDEX_TEXT_PATH':'YANDEX_XLSX_PATH');
 if(!env('YANDEX_DISK_TOKEN')||!path)throw new Error('disk_not_configured');
 const r=await fetcher('https://cloud-api.yandex.net/v1/disk/resources/download?path='+encodeURIComponent(path),{headers:{Authorization:'OAuth '+env('YANDEX_DISK_TOKEN')},signal:AbortSignal.timeout(12000)});
 if(!r.ok)throw new Error('disk_'+r.status);
 const data=await r.json();let url=new URL(data.href),file;
 const signal=AbortSignal.timeout(25000);
 for(let redirects=0;;redirects++){
  const host=url.hostname;
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||!['yandex.net','yandex.ru','yandex.com'].some(h=>host===h||host.endsWith('.'+h)))throw new Error('disk_download_url');
  file=await fetcher(url,{redirect:'manual',signal});
  if(![301,302,303,307,308].includes(file.status))break;
  const location=file.headers.get('location');await file.body?.cancel();
  if(!location||redirects>=3)throw new Error('disk_redirect');
  url=new URL(location,url);
 }
 if(!file.ok)throw new Error('disk_download_'+file.status);
 const bytes=await limitedBytes(file,10*1024*1024);
 const expected=env(kind==='txt'?'MATERIAL_TXT_SHA256':'MATERIAL_XLSX_SHA256');
 if(expected&&await hash(bytes)!==expected)throw new Error('material_version_mismatch');
 return {bytes,name:kind==='txt'?'codex-lesson.txt':'codex-practice.xlsx',mime:kind==='txt'?'text/plain; charset=utf-8':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
 }catch(e){throw new Error(/^(disk_[a-z_0-9]+|file_too_large|material_version_mismatch)$/.test(e.message)?e.message:'disk_network');}
};}
export function normalize(u){
 if(!Number.isSafeInteger(u?.update_id))return null;
 if(u.chat_join_request){const q=u.chat_join_request;if(q.chat?.type!=='channel'||!Number.isSafeInteger(q.from?.id)||q.from.is_bot)return null;return {update:u.update_id,actor:q.from.id,action:'join',channel:q.chat.id,invite:String(q.invite_link?.invite_link||'')};}
 if(u.chat_member){const q=u.chat_member,n=q.new_chat_member;if(q.chat?.type!=='channel'||!Number.isSafeInteger(n?.user?.id)||n.user.is_bot)return null;return {update:u.update_id,actor:n.user.id,action:'member',channel:q.chat.id,member:member(n)};}
 const cb=u.callback_query,m=cb?.message||u.message,from=cb?.from||m?.from;
 if(m?.chat?.type!=='private'||!Number.isSafeInteger(from?.id)||from.is_bot||from.id!==m.chat.id)return null;
 const e={update:u.update_id,actor:from.id,private:true,action:'help'};
 if(cb){const [action,id]=String(cb.data||'').split(':');return ['approve','decline'].includes(action)&&UUID.test(id||'')?{...e,action,order:id}:e;}
 const [cmd,arg]=String(m.text||'').trim().split(/\s+/,2);
 if(cmd==='/start'&&/^[A-Za-z0-9_-]{43}$/.test(arg||''))return {...e,action:'start',claimToken:arg};
 return {...e,action:({'/id':'id','/status':'status','/materials':'materials','/requests':'requests','/retry':'retry'})[cmd]||'help'};
}
export function makeShop({env,db,bot,loadMaterial,payments,clock=()=>Date.now()}){
 const channel=Number(env('COURSE_CHANNEL_ID')||0),admin=Number(env('ADMIN_CHAT_ID')||0);
 const paymentMode=env('PAYMENT_MODE')||'yookassa_test';
 const robo=robokassa(env);
 const origin=()=>{try{return new URL(env('SITE_URL')).origin;}catch{return '';}};
 const configured=()=>Boolean(env('BOT_TOKEN')&&env('BOT_USERNAME')&&channel&&admin);
 const yooReady=()=>/^test_/.test(env('YOOKASSA_SECRET_KEY'))&&Boolean(env('YOOKASSA_SHOP_ID'));
 const paymentConfigured=()=>Boolean(origin()&&(paymentMode===ROBO_MODE?robo.ready:paymentMode==='yookassa_test'&&yooReady()));
 const ownOrder=async(data,auth)=>{
  if(!UUID.test(data.id||'')||!auth?.startsWith('Bearer '))return null;
  const x=await db('get',{id:data.id,accessHash:await hash(auth.slice(7))});return x?.error?null:x;
 };
 const internal=async id=>db('order_internal',{id});
 async function verifiedPayment(o,data){
  const amount=String(data.amount?.value||'').match(/^(\d+)\.(\d{2})$/);
  const price=amount?Number(amount[1])*100+Number(amount[2]):-1;
  if(data.id!==o.provider_payment_id||data.test!==true||data.metadata?.order_id!==o.id||data.amount?.currency!=='RUB'||price!==o.price||String(data.recipient?.account_id)!==env('YOOKASSA_SHOP_ID')||(data.status==='succeeded'&&data.paid!==true))throw new Error('payment_mismatch');
  return db('payment_update',{id:o.id,paymentId:data.id,status:data.status,price,test:data.test});
 }
 async function drain(){
  const until=clock()+45000;
  for(let pass=0;pass<4&&clock()<until;pass++){
   const jobs=await db('claim');if(!jobs.length)break;
   for(const j of jobs){
    if(clock()>until)break;
    const d=j.data;
    try{
     if(j.kind==='message')await bot('sendMessage',{chat_id:d.chat,text:d.text});
     else if(j.kind==='invite_message')await bot('sendMessage',{chat_id:d.chat,text:'Учебная покупка №'+d.number+' подтверждена. Подайте заявку на вступление в закрытый канал. Модератор проверит её; затем бот пришлёт файлы.',reply_markup:{inline_keyboard:[[{text:'Подать заявку в канал',url:d.link}]]}});
     else if(j.kind==='moderation')await bot('sendMessage',{chat_id:d.chat,text:'Новая заявка в учебный канал\nПокупка №'+d.number+' · '+d.package+'\nTelegram ID: '+d.user+'\nТестовый платёж подтверждён. Реальные деньги не списывались.',reply_markup:{inline_keyboard:[[{text:'Одобрить',callback_data:'approve:'+d.order},{text:'Отклонить',callback_data:'decline:'+d.order}]]}});
     else if(j.kind==='requests')await bot('sendMessage',{chat_id:d.chat,text:d.orders.length?'Заявки, ожидающие решения:':'Ожидающих заявок нет.',reply_markup:{inline_keyboard:d.orders.map(o=>[{text:'Одобрить №'+o.number,callback_data:'approve:'+o.id},{text:'Отклонить',callback_data:'decline:'+o.id}])}});
     else if(['access','approve','decline','material'].includes(j.kind)){
      const o=await internal(d.order);
      if(!o||o.payment_state!=='paid'||Number(o.telegram_user)!==Number(d.chat))throw new Error('access_denied');
      const m=await bot('getChatMember',{chat_id:channel,user_id:d.chat});
      if(j.kind==='access'){
       if(member(m))await db('approved',{id:o.id});
       else if(['requested','approving','declining'].includes(o.access_state))await bot('sendMessage',{chat_id:d.chat,text:'Ваша заявка обрабатывается модератором. Файлы отправятся после одобрения.'});
       else{
        let link=o.invite_link,expires=Math.floor(new Date(o.invite_expires||0).getTime()/1000);
        if(!link||expires<Math.floor(clock()/1000)+60){expires=Math.floor(clock()/1000)+3600;const q=await bot('createChatInviteLink',{chat_id:channel,name:'Покупка '+o.number,expire_date:expires,creates_join_request:true});link=q.invite_link;}
        await db('invited',{id:o.id,link,expires,job:j.id});
       }
      }else if(j.kind==='approve'){
       if(!member(m)){await bot('approveChatJoinRequest',{chat_id:channel,user_id:d.chat});const check=await bot('getChatMember',{chat_id:channel,user_id:d.chat});if(!member(check))throw new Error('membership_not_confirmed');}
       await db('approved',{id:o.id});await bot('sendMessage',{chat_id:admin,text:'Доступ по покупке №'+o.number+' открыт.'});
      }else if(j.kind==='decline'){
       if(!member(m)&&o.access_state!=='approved'){await bot('declineChatJoinRequest',{chat_id:channel,user_id:d.chat});await db('declined',{id:o.id,job:j.id});}
      }else{
       if(o.access_state!=='approved'||!member(m))throw new Error('membership_required');
       const file=await loadMaterial(d.material);const form=new FormData();form.append('chat_id',String(d.chat));form.append('document',new Blob([file.bytes],{type:file.mime}),file.name);form.append('caption',d.material==='txt'?'Короткий учебный урок. Файл загружен с Яндекс Диска.':'Таблица практики. Файл загружен с Яндекс Диска.');
       await bot('sendDocument',form);
      }
     }else throw new Error('unknown_job');
     await db('sent',{id:j.id,lease:j.lease});
    }catch(e){await db('failed',{id:j.id,lease:j.lease,error:/^[a-z0-9_]+$/.test(e.message)?e.message:'delivery_error'});}
   }
  }
  return db('summary');
 }
 async function body(req){try{return JSON.parse(new TextDecoder().decode(await limitedBytes(req,8192)));}catch(e){if(e.message==='file_too_large')throw new Error('body_size');throw e;}}
 return {drain,async handle(req){
  const path=new URL(req.url).pathname.split('/').filter(Boolean).at(-1),requestOrigin=req.headers.get('origin');
  const isPublic=['catalog','create','status'].includes(path);
  const cors={'Access-Control-Allow-Origin':origin(),'Vary':'Origin','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET, POST, OPTIONS'};
  if(isPublic&&requestOrigin&&requestOrigin!==origin())return json({error:'Этот сайт не подключён.'},403);
  if(req.method==='OPTIONS'&&isPublic)return new Response(null,{status:204,headers:cors});
  const out=(data,status=200)=>json(data,status,isPublic?cors:{});
  try{
   if(path==='catalog'&&req.method==='GET')return out({packages:await db('catalog'),paymentMode,paymentConfigured:paymentConfigured(),telegramConfigured:configured(),materialsConfigured:Boolean(env('YANDEX_DISK_TOKEN'))});
   if(req.method!=='POST')return out({error:'Метод не поддерживается.'},405);
   if(path==='create'){
    if(env('SHOP_ADMIN_SECRET').length<32||!paymentConfigured())return out({error:'Тестовый магазин пока не подключён.'},503);
    const x=await body(req);if(!UUID.test(x.requestId||'')||!['start','site','practice'].includes(x.packageId)||!/^[A-Za-z0-9_-]{43}$/.test(x.clientKey||''))return out({error:'Проверьте пакет.'},400);
    const accessToken=x.clientKey,claim=await token(env('SHOP_ADMIN_SECRET'),'claim:'+x.requestId);
    const ip=req.headers.get('cf-connecting-ip')||req.headers.get('x-forwarded-for')?.split(',')[0]||'unknown';
    const o=await db('create',{id:x.requestId,package:x.packageId,accessHash:await hash(accessToken),claimHash:await hash(claim),ipHash:await hash(ip+env('SHOP_ADMIN_SECRET')),mode:paymentMode});
    if(o.error)return out({error:o.error==='rate'?'Слишком много покупок. Попробуйте позже.':'Не удалось создать покупку.'},o.error==='rate'?429:409);
    let stored=await internal(o.id);
    if(!stored.provider_payment_id){
     let paymentId,confirmationUrl;
     if(stored.mode===ROBO_MODE){
      const checkout=await robo.checkout(o);
      paymentId=checkout.id;
      confirmationUrl=checkout.url;
     }else{
      const p=await payments.create(o);
      const href=new URL(p.confirmation?.confirmation_url||'');
      if(p.test!==true||!UUID.test(p.id||'')||href.protocol!=='https:'||!['yoomoney.ru','yookassa.ru'].some(h=>href.hostname===h||href.hostname.endsWith('.'+h)))throw new Error('payment_confirmation');
      paymentId=p.id;
      confirmationUrl=href.href;
     }
     await db('payment_saved',{id:o.id,paymentId,confirmationUrl});
     stored=await internal(o.id);
    }
    return out({order:o,accessToken,confirmationUrl:stored.confirmation_url});
   }
   if(path==='status'){
    const x=await body(req),o=await ownOrder(x,req.headers.get('authorization'));if(!o)return out({error:'Покупка не найдена.'},404);
    const stored=await internal(o.id);
    const actual=stored.mode==='yookassa_test'&&stored.provider_payment_id
     ?await verifiedPayment(stored,await payments.get(stored.provider_payment_id)):o;
    const claim=await token(env('SHOP_ADMIN_SECRET'),'claim:'+x.id);
    return out({order:actual,confirmationUrl:stored.confirmation_url,telegramUrl:actual.paymentState==='paid'&&configured()?'https://t.me/'+env('BOT_USERNAME')+'?start='+claim:null,telegramConfigured:configured()});
   }
   if(path==='payment'){
    const x=await body(req),id=x.object?.id;
    if(x.type!=='notification'||!UUID.test(id||''))return out({error:'invalid_event'},400);
    const orderId=await db('payment_lookup',{paymentId:id});if(!orderId)return out({ok:true});
    const o=await internal(orderId);
    if(o?.mode==='yookassa_test')await verifiedPayment(o,await payments.get(id));
    return out({ok:true});
   }
   if(path==='robokassa-result'){
    const payment=await robo.result(req);
    if(!payment)return out({error:'invalid_result'},400);
    const o=await internal(payment.orderId);
    if(o?.mode!==ROBO_MODE||o.provider_payment_id!==payment.paymentId||o.price!==payment.price)return out({error:'payment_mismatch'},400);
    await db('payment_update',{id:o.id,paymentId:payment.paymentId,status:'succeeded',price:payment.price,test:true});
    return new Response('OK'+payment.invoice,{headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
   }
   if(path==='telegram'){
    if(!await equal(req.headers.get('X-Telegram-Bot-Api-Secret-Token'),env('TG_WEBHOOK_SECRET')))return out({error:'unauthorized'},401);
    const update=await body(req),e=normalize(update);
    if(e){if(e.claimToken){e.claimHash=await hash(e.claimToken);delete e.claimToken;}if(update.callback_query?.id)await bot('answerCallbackQuery',{callback_query_id:update.callback_query.id}).catch(()=>{});await db('event',e);}
    const result=await drain();return out({ok:result.pending===0},result.pending?503:200);
   }
   if(['worker','setup'].includes(path)){
    if(!await equal(req.headers.get('X-Shop-Admin-Secret'),env('SHOP_ADMIN_SECRET')))return out({error:'unauthorized'},401);
    if(path==='worker')return out(await drain());
    const x=await body(req),me=await bot('getMe',{});
    if(x.action==='register'){
     if(!configured())return out({error:'Заполните бота, владельца и канал.'},400);
     const rights=await bot('getChatMember',{chat_id:channel,user_id:me.id});if(rights.status!=='administrator'||!rights.can_invite_users)return out({error:'Боту нужны права администратора канала и приглашения пользователей.'},400);
     if(env('TG_WEBHOOK_SECRET').length<32)return out({error:'Секрет webhook не задан.'},400);
     await bot('setWebhook',{url:x.webhookUrl,secret_token:env('TG_WEBHOOK_SECRET'),allowed_updates:['message','callback_query','chat_join_request','chat_member','my_chat_member'],drop_pending_updates:false});return out({ok:true,username:me.username});
    }
    const info=await bot('getWebhookInfo',{});return out({username:me.username,configured:configured(),webhookUrl:info.url,pending:info.pending_update_count,lastError:info.last_error_date||null,...await db('summary')});
   }
   return out({error:'Не найдено.'},404);
  }catch(e){if(e instanceof SyntaxError||e.message==='body_size')return out({error:'Некорректный запрос.'},400);return out({error:'Сервис временно недоступен. Покупка и доступ не подтверждены.'},503);}
 }};
}
