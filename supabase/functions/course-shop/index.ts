import {makeShop,makeRpc,telegram,diskLoader,yookassa} from '../_shared/core.js';
const env=(key:string)=>Deno.env.get(key)||'';
const shop=makeShop({env,db:makeRpc(env),bot:telegram(env),loadMaterial:diskLoader(env),payments:yookassa(env)});
Deno.serve(shop.handle);
