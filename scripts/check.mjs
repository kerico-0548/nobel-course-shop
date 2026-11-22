import {readFile,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
for(const f of ['public/app.js','public/config.js','supabase/functions/_shared/core.js']){const r=spawnSync(process.execPath,['--check',f],{stdio:'inherit'});if(r.status)process.exit(r.status);}
for(const f of await readdir('public')){const s=await readFile('public/'+f,'utf8');if(/\b\d{7,12}:[A-Za-z0-9_-]{25,}\b|sb_secret_|test_[A-Za-z0-9_-]{20,}|y0_[A-Za-z0-9_-]{20,}/.test(s))throw new Error('Possible secret in '+f);}
console.log('Синтаксис и публичные файлы проверены');
