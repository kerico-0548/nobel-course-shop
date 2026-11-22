import {readFile,writeFile,mkdir} from 'node:fs/promises';
const source=await readFile('supabase/functions/_shared/core.js','utf8');await mkdir('.local/dashboard',{recursive:true});
await writeFile('.local/dashboard/course-shop.ts',source+'\nconst env=(k)=>Deno.env.get(k)||"";\nconst shop=makeShop({env,db:makeRpc(env),bot:telegram(env),loadMaterial:diskLoader(env),payments:yookassa(env)});\nDeno.serve(shop.handle);\n');console.log('Самостоятельная функция подготовлена в .local/dashboard');
