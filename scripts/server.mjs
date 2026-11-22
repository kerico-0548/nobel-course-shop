import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {readEnv} from './env.mjs';
import {makeShop,telegram,diskLoader,yookassa} from '../supabase/functions/_shared/core.js';
await mkdir('.local/db',{recursive:true});const pg=new PGlite('.local/db');
await pg.exec("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$;");
if(!(await pg.query("select to_regnamespace('course_shop') ns")).rows[0].ns)await pg.exec(await readFile('supabase/migrations/202611220001_course_shop.sql','utf8'));
const settings=await readEnv(),env=k=>k==='SITE_URL'?'http://localhost:4174/':settings[k]||'';
const db=async(op,p={})=>(await pg.query('select public.cs_rpc($1,$2::jsonb,$3::bigint,$4::bigint) result',[op,JSON.stringify(p),env('ADMIN_CHAT_ID')||0,env('COURSE_CHANNEL_ID')||0])).rows[0].result;
const shop=makeShop({env,db,bot:telegram(env),loadMaterial:diskLoader(env),payments:yookassa(env)});
const pub=resolve('public');const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
let busy=false;const tick=setInterval(async()=>{if(busy)return;busy=true;try{await shop.drain();}catch{}finally{busy=false;}},15000);tick.unref();
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost:4174');
  if(url.pathname.startsWith('/api/')){
   let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>8192){res.writeHead(413);res.end();return;}chunks.push(c);}
   const headers=new Headers(req.headers);headers.set('x-forwarded-for',req.socket.remoteAddress||'local');
   const request=new Request(url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});const response=await shop.handle(request);
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
  }
  if(url.pathname==='/config.js'){res.writeHead(200,{'Content-Type':types['.js'],'Cache-Control':'no-store'});res.end('window.SHOP_CONFIG={endpoint:"/api"};');return;}
  const file=resolve(pub,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
  if(!file.startsWith(pub+sep)){res.writeHead(403);res.end();return;}
  const data=await readFile(file);const ext=file.slice(file.lastIndexOf('.'));res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);
 }catch{res.writeHead(404);res.end('Not found');}
});
server.listen(4174,'127.0.0.1',()=>console.log('Local: http://localhost:4174/'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(tick);server.close();pg.close().finally(()=>process.exit(0));});
