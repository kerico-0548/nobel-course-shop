import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {readEnv,setEnv} from './env.mjs';
const env=await readEnv(),action=process.argv[2]||'init';
async function api(method,data={}){try{const r=await fetch('https://api.telegram.org/bot'+env.BOT_TOKEN+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(18000)});const d=await r.json();if(!d.ok)throw new Error();return d.result;}catch{throw new Error('Telegram API недоступен или параметры неверны. Секреты не выводятся.');}}
if(action==='init'){
 const changes={};for(const k of ['SHOP_ADMIN_SECRET','TG_WEBHOOK_SECRET'])if(!env[k])changes[k]=randomBytes(32).toString('base64url');
 if(!env.SITE_URL)changes.SITE_URL='http://localhost:4174/';
 for(const [kind,file] of [['TXT','codex-lesson.txt'],['XLSX','codex-practice.xlsx']]){try{changes['MATERIAL_'+kind+'_SHA256']=createHash('sha256').update(await readFile(new URL('../.local/course-materials/'+file,import.meta.url))).digest('hex');}catch{}}
 await setEnv(changes);console.log('Локальные настройки и контрольные суммы подготовлены. Секреты скрыты.');
}else if(action==='owner'){
 if(!env.BOT_TOKEN||!env.BOT_USERNAME)throw new Error('Заполните BOT_TOKEN и BOT_USERNAME в .local/secrets.env');
 const info=await api('getWebhookInfo');if(info.url)throw new Error('Webhook уже установлен. Не заменяю чужое подключение.');
 const code='owner_'+randomBytes(24).toString('base64url');await writeFile(new URL('../.local/owner-claim.json',import.meta.url),JSON.stringify({code,created:Date.now()}));
 console.log('https://t.me/'+env.BOT_USERNAME.replace(/^@/,'')+'?start='+code);
}else if(action==='check-owner'){
 const claim=JSON.parse(await readFile(new URL('../.local/owner-claim.json',import.meta.url),'utf8'));
 if(claim.used){console.log('Владелец уже проверен.');process.exit(0);}
 if(Date.now()-claim.created>600000)throw new Error('Ссылка устарела. Выполните npm run setup -- owner заново.');
 if((await api('getWebhookInfo')).url)throw new Error('Не использую getUpdates при установленном webhook.');
 const updates=await api('getUpdates');
 const ids=[...new Set(updates.filter(u=>u.message?.chat?.type==='private'&&u.message.from?.id===u.message.chat.id&&!u.message.from.is_bot&&u.message.text==='/start '+claim.code&&u.message.date*1000>=claim.created-3000).map(u=>String(u.message.from.id)))];
 if(ids.length!==1){console.log(JSON.stringify({ownerVerified:false}));process.exit(0);}
 const channelUpdates=updates.filter(u=>u.my_chat_member?.chat?.type==='channel'&&String(u.my_chat_member.from?.id)===ids[0]);
 const channels=[...new Map(channelUpdates.map(u=>[String(u.my_chat_member.chat.id),u.my_chat_member.chat])).values()];
 const values={ADMIN_CHAT_ID:ids[0],BOT_USERNAME:env.BOT_USERNAME.replace(/^@/,'')};
 if(channels.length===1){const me=await api('getMe'),rights=await api('getChatMember',{chat_id:channels[0].id,user_id:me.id});if(rights.status==='administrator'&&rights.can_invite_users)values.COURSE_CHANNEL_ID=String(channels[0].id);}
 await setEnv(values);await writeFile(new URL('../.local/owner-claim.json',import.meta.url),JSON.stringify({used:true,created:claim.created}));
 console.log(JSON.stringify({ownerVerified:true,channelDetected:Boolean(values.COURSE_CHANNEL_ID),channelTitle:channels.length===1?channels[0].title:null}));
}else if(action==='check-channel'){
 if(!env.ADMIN_CHAT_ID)throw new Error('Сначала подтвердите владельца.');
 if((await api('getWebhookInfo')).url)throw new Error('Не использую getUpdates при установленном webhook.');
 const updates=await api('getUpdates');
 const channels=[...new Map(updates.filter(u=>u.my_chat_member?.chat?.type==='channel'&&String(u.my_chat_member.from?.id)===env.ADMIN_CHAT_ID).map(u=>[String(u.my_chat_member.chat.id),u.my_chat_member.chat])).values()];
 if(channels.length!==1){console.log(JSON.stringify({channelDetected:false,candidates:channels.length}));process.exit(0);}
 const me=await api('getMe'),rights=await api('getChatMember',{chat_id:channels[0].id,user_id:me.id});
 if(rights.status!=='administrator'||!rights.can_invite_users)throw new Error('Боту нужно право администратора приглашать пользователей.');
 await setEnv({COURSE_CHANNEL_ID:String(channels[0].id)});console.log(JSON.stringify({channelDetected:true,channelTitle:channels[0].title}));
}else if(action==='register'||action==='status'){
 const cfg=JSON.parse(await readFile(new URL('../.local/deployment.json',import.meta.url),'utf8'));
 const r=await fetch(cfg.endpoint+'/setup',{method:'POST',headers:{'Content-Type':'application/json','X-Shop-Admin-Secret':env.SHOP_ADMIN_SECRET},body:JSON.stringify({action:action==='register'?'register':'status',webhookUrl:cfg.endpoint+'/telegram'}),signal:AbortSignal.timeout(30000)});console.log(r.status,await r.text());
}else throw new Error('Неизвестное действие');
