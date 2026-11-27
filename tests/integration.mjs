import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.mjs';
import {settled} from './support.mjs';
const base=process.env.OAS_TEST_API||'http://127.0.0.1:18080';
const upstream=process.env.OAS_TEST_FIXTURE_BASE||'http://host.docker.internal:18780';
let cookie='',csrf='',server,project,key,endpoint,reader,model;
async function call(path,body,method='POST',expected=200){
  const result=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Origin:base,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const value=await result.json();
  assert.equal(result.status,expected,JSON.stringify(value));return value.data;
}
async function resource(value){return call('/admin/v1/endpoints',{timeout_ms:8000,max_concurrency:4,rpm:10000,options:{},...value},'POST',201);}
async function business(op,input,expected=200,auth=key){
  const response=await fetch(base+'/v1/search/'+op,{method:'POST',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:JSON.stringify(input)});
  const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));if(response.ok)await settled(base,value.request_id,{Cookie:cookie});return value;
}
before(async()=>{
  server=await fixture();
  const response=await fetch(base+'/admin/v1/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:process.env.OAS_TEST_PASSWORD||'admin123'})});
  assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];csrf=(await response.json()).data.csrf_token;
  const retention=await call('/admin/v1/settings/retention',undefined,'GET');
  if(retention.retention_days!==7)await call('/admin/v1/settings/retention',{retention_days:7,expected_version:retention.version},'PUT');
  endpoint=await resource({name:'Native search',kind:'search',provider:'tavily',adapter:'http_search',base_url:upstream,options:{}});
  reader=await resource({name:'Native article',kind:'reader',provider:'anysearch',adapter:'http_reader',base_url:upstream,options:{format:'html'}});
  model=await resource({name:'Structured model',kind:'model',provider:'openai_compatible',adapter:'chat_model',base_url:upstream+'/v1',options:{model:'fixture',tokenizer:'cl100k_base',max_input_tokens:8192,max_output_tokens:2048}});
  const r=await call('/admin/v1/projects',{name:'Integration research',search_pools:[[endpoint.id]],reader_pools:[[reader.id]],model_endpoint_id:model.id},'POST',201);
  project=r.project;key=r.api_key;
});
after(()=>{server?.closeAllConnections();server?.close();});
test('real HTTP list, content and synthesis form a recorded evidence chain',async()=>{
  const list=await business('list',{query:'rainfall',count:2});
  assert.equal(list.data.items[0].url,upstream+'/article');
  const article=await business('content',{url:list.data.items[0].url});
  assert.ok(article.data.markdown.includes('Rainfall'));
  assert.ok(!article.data.text.includes('**'));
  const summary=await business('summary',{query:'rainfall',source_count:1,region:'Shanghai',current_time:'2026-05-01T00:30:00+08:00'});
  assert.ok(summary.data.summary.includes('rainfall'));assert.ok(summary.data.citations.length);
  const detail=await call('/admin/v1/requests/'+summary.request_id,undefined,'GET');
  assert.ok(detail.metadata.upstream_calls>=5);assert.equal(detail.metadata.retention_days,7);
  const evidence=await call('/admin/v1/requests/'+summary.request_id+'/evidence',undefined,'GET');
  assert.equal(evidence.sources[0].source_id,summary.data.citations[0].source_id);
  const exported=await call('/admin/v1/requests/'+summary.request_id+'/export',undefined,'GET');
  assert.ok(exported.payloads.some(p=>p.replay.some(m=>m.kind==='model'&&m.model_input.messages)));
});
test('native providers normalize their actual protocol formats',async()=>{
  for(const provider of ['tavily','anysearch','deepseek','searxng']){
    const e=await resource({name:provider+' search',provider,kind:'search',adapter:'http_search',base_url:upstream,options:{}});
    const temp=await call('/admin/v1/projects',{name:provider+' project',search_pools:[[e.id]],reader_pools:[]},'POST',201);
    const result=await business('list',{query:'rainfall'},200,temp.api_key);assert.equal(result.data.items.length,1);
  }
  for(const provider of ['tavily','anysearch','deepseek','crawl4ai']){
    const e=await resource({name:provider+' reader',provider,kind:'reader',adapter:'http_reader',base_url:upstream,options:{format:'markdown'}});
    const temp=await call('/admin/v1/projects',{name:provider+' article project',search_pools:[],reader_pools:[[e.id]]},'POST',201);
    const result=await business('content',{url:upstream+'/article'},200,temp.api_key);assert.ok(result.data.text.includes('rain'));
  }
});
test('validation, optimistic concurrency, references and sessions are enforced',async()=>{
  assert.equal((await business('list',{query:''},400)).error.code,'INVALID_ARGUMENT');
  assert.equal((await business('list',{query:'x',unexpected:true},400)).error.code,'INVALID_ARGUMENT');
  assert.equal((await business('list',{query:'x'},401,'wrong')).error.code,'UNAUTHORIZED');
  const {id,version,cache_epoch,cache_access_epoch,...body}=project;
  await call('/admin/v1/projects/'+id,{...body,expected_version:version},'PUT');
  await call('/admin/v1/projects/'+id,{...body,expected_version:version},'PUT',409);
  await call('/admin/v1/endpoints/'+endpoint.id+'?expected_version='+endpoint.version,undefined,'DELETE',409);
  const noCsrf=await fetch(base+'/admin/v1/settings/retention',{method:'PUT',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({retention_days:2,expected_version:1})});
  assert.equal(noCsrf.status,403);
});
test('global retention updates apply only to new records and stats use actual calls',async()=>{
  const first=await business('list',{query:'rainfall'});
  const prior=await call('/admin/v1/requests/'+first.request_id,undefined,'GET');
  const setting=await call('/admin/v1/settings/retention',undefined,'GET');
  await call('/admin/v1/settings/retention',{retention_days:3,expected_version:setting.version},'PUT');
  const second=await business('list',{query:'rainfall'});
  const newer=await call('/admin/v1/requests/'+second.request_id,undefined,'GET');
  assert.equal(prior.metadata.retention_days,7);assert.equal(newer.metadata.retention_days,3);
  const after=await call('/admin/v1/requests/'+first.request_id,undefined,'GET');
  assert.equal(after.metadata.expires_at,prior.metadata.expires_at);
  const calls=await call('/admin/v1/endpoint-calls?request_id='+second.request_id,undefined,'GET');assert.equal(calls.items.length,1);
  const stats=await call('/admin/v1/endpoint-statistics?project_id='+project.id,undefined,'GET');assert.ok(stats.overview.calls>0);
});
