import native from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {appendFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const scope=new AsyncLocalStorage();
const catalog=JSON.parse(readFileSync(new URL('./subitems.json',import.meta.url),'utf8'));
const known=new Map(catalog.items.map(item=>[item.id,item]));
function count(){const current=scope.getStore();if(current)current.assertions++;}
export const assert=new Proxy(native,{apply(target,self,args){const result=Reflect.apply(target,self,args);count();return result;},get(target,key){const value=target[key];if(typeof value!=='function')return value;return (...args)=>{const result=Reflect.apply(value,target,args);if(result?.then)return result.then(v=>{count();return v;});count();return result;};}});
export async function prove(id,work){
 native.ok(known.has(id),'Unknown acceptance subitem: '+id);
 const source=new Error().stack.split('\n').find(line=>!line.includes('proof.mjs')&&line.includes('file:'))?.trim()||'unknown';
 const current={id,assertions:0};
 try{const value=await scope.run(current,()=>work(assert));native.ok(current.assertions>=1,'A subitem must execute a real assertion: '+id);emit({...current,source,status:'passed'});return value;}
 catch(error){emit({...current,source,status:'failed'});throw error;}
}
function emit(value){if(process.env.OAS_ASSERTIONS_FILE){native.ok(process.env.OAS_SOURCE_FINGERPRINT&&process.env.OAS_RUN_ID&&process.env.OAS_SUITE);appendFileSync(process.env.OAS_ASSERTIONS_FILE,JSON.stringify({version:1,run_id:process.env.OAS_RUN_ID,fingerprint:process.env.OAS_SOURCE_FINGERPRINT,suite:process.env.OAS_SUITE,...value})+'\n');}}
export function check(id,work){
 native.ok(known.has(id),'Unknown acceptance subitem: '+id);const current={id,assertions:0};
 try{const value=scope.run(current,()=>work(assert));native.ok(!value?.then,'Use prove() for asynchronous assertions');native.ok(current.assertions>0,'A subitem must execute an assertion');emit({...current,source:new Error().stack.split('\n')[2]?.trim(),status:'passed'});return value;}catch(error){emit({...current,status:'failed'});throw error;}
}
