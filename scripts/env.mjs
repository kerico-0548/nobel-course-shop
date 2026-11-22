import {readFile,writeFile} from 'node:fs/promises';
export const envFile=new URL('../.local/secrets.env',import.meta.url);
export async function readEnv(){const s=await readFile(envFile,'utf8');return Object.fromEntries(s.replace(/^\uFEFF/,'').split(/\r?\n/).filter(x=>x&&!x.startsWith('#')&&x.includes('=')).map(x=>{const i=x.indexOf('=');return[x.slice(0,i).trim(),x.slice(i+1).trim().replace(/^"(.*)"$/,'$1')];}));}
export async function setEnv(values){let s=await readFile(envFile,'utf8');for(const [key,value] of Object.entries(values)){if(!/^[A-Z0-9_]+$/.test(key)||/[\r\n]/.test(String(value)))throw new Error('invalid_setting');const re=new RegExp('^'+key+'=.*$','m');s=re.test(s)?s.replace(re,key+'='+value):s+'\n'+key+'='+value;}await writeFile(envFile,s);}
