import {assert} from './proof.mjs';
import {spawn,spawnSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {fixture} from '../fixture.mjs';
import {settled} from '../support.mjs';
export const base=process.env.OAS_TEST_API||'http://127.0.0.1:18080';
export const upstream=process.env.OAS_TEST_FIXTURE_BASE||'http://host.docker.internal:18780';
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export let server,cookie,csrf;
export async function setup(){
 server=await fixture();const r=await fetch(base+'/admin/v1/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:process.env.OAS_TEST_PASSWORD||'admin123'})});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];csrf=(await r.json()).data.csrf_token;
 // Files share the owned database, while each file owns its proxy listeners.
 // An enabled outlet from a finished file must not route the next file's traffic.
 if(/^oas-local-[a-f0-9]{8}-db$/.test(process.env.OAS_TEST_DB||'')){
  const previous=await admin('proxies?limit=100');
  for(const proxy of previous.items.filter(p=>p.enabled)){
   const body=Object.fromEntries(['name','scheme','host','port','auth_mode','max_concurrency'].map(key=>[key,proxy[key]]));
   await admin('proxies/'+proxy.id,{...body,enabled:false,expected_version:proxy.version,secret_action:'keep'},'PUT');
  }
 }
}
export function close(){server?.closeAllConnections();server?.close();}
export async function admin(path,body,method=body?'POST':'GET',status=200){
 const response=await fetch(base+'/admin/v1/'+path,{method,headers:{Cookie:cookie,Origin:base,'X-CSRF-Token':csrf,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value.data;
}
export async function endpoint(kind='search',mode='',extra={}){
 return admin('endpoints',{name:["Acceptance",kind,mode,crypto.randomUUID().slice(0,8)].filter(Boolean).join(" "),kind,provider:kind==='model'?'openai_compatible':kind==='reader'?'anysearch':'tavily',adapter:kind==='model'?'chat_model':kind==='reader'?'http_reader':'http_search',base_url:upstream+(mode?'/case/'+mode:'')+(kind==='model'?'/v1':''),timeout_ms:8000,max_concurrency:16,rpm:10000,options:kind==='model'?{model:'fixture',tokenizer:'cl100k_base',max_input_tokens:8192,max_output_tokens:2048}:kind==='reader'?{format:'html'}:{},...extra},'POST',201);
}
export async function project(extra={},endpoints={}){
 const search=endpoints.search||await endpoint('search'),reader=endpoints.reader||await endpoint('reader'),model=endpoints.model||await endpoint('model');
 const made=await admin('projects',{name:'Acceptance project',search_pools:[[search.id]],reader_pools:[[reader.id]],model_endpoint_id:model.id,rewrite_count:0,...extra},'POST',201);return {...made,search,reader,model};
}
export async function business(made,op,input,expected=200,headers={}){
 const response=await fetch(base+'/v1/search/'+op,{method:'POST',headers:{Authorization:'Bearer '+made.api_key,'Content-Type':'application/json',...headers},body:typeof input==='string'?input:JSON.stringify(input)});const value=await response.json();
 if(response.status!==expected && /^[a-f0-9-]{36}$/.test(value.request_id||'')){
  try{await recorded(value.request_id);await writeFile('artifacts/failed-browser-'+value.request_id+'.json',JSON.stringify(await admin('requests/'+value.request_id+'/export'),null,2));}catch{}
 }
 assert.equal(response.status,expected,JSON.stringify(value));return value;
}
export const recorded=id=>settled(base,id,{Cookie:cookie});
export const q=scope=>new URLSearchParams(scope).toString();
export function sql(statement){
 const container=process.env.OAS_TEST_DB;assert.match(container||'',/^oas-local-[a-f0-9]{8}-db$/,'SQL acceptance requires its owned disposable database');
 const result=spawnSync('docker',['exec','-i',container,'psql','-X','-U','oas','-d','oas','-v','ON_ERROR_STOP=1','-At'],{input:statement,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout.trim();
}
export function blockDiagnostics(seconds=3){
 const container=process.env.OAS_TEST_DB;assert.match(container||'',/^oas-local-[a-f0-9]{8}-db$/);
 return new Promise((resolve,reject)=>{const child=spawn('docker',['exec',container,'psql','-X','-U','oas','-d','oas','-v','ON_ERROR_STOP=1','-c',`BEGIN;LOCK endpoint_calls IN ACCESS EXCLUSIVE MODE;SELECT pg_sleep(${Number(seconds)});COMMIT;`],{stdio:'ignore'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('diagnostic lock failed')));});
}
export function editable(resource){const{version,id,cache_epoch,cache_access_epoch,managed_by,availability,has_secret,last_test,ready_pods,default_network_google_probe,...body}=resource;return {...body,expected_version:version};}
