import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.mjs';
import {settled} from './support.mjs';
const base=process.env.OAS_TEST_API||'http://127.0.0.1:18080';
let server,cookie,csrf,key,project;
async function call(path,body,method='POST'){
  const r=await fetch(base+path,{method,headers:{Cookie:cookie||'',Origin:base,'X-CSRF-Token':csrf||'','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value.data;
}
before(async()=>{
  server=await fixture();const r=await fetch(base+'/admin/v1/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:process.env.OAS_TEST_PASSWORD||'admin123'})});
  assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];csrf=(await r.json()).data.csrf_token;
  const entities=await call('/admin/v1/endpoints?limit=100',null,'GET');const search=entities.items.find(e=>e.adapter==='browser_search'),reader=entities.items.find(e=>e.adapter==='browser_reader');
  assert.ok(search.ready_pods>0);
  const made=await call('/admin/v1/projects',{name:'Firefox research',search_pools:[[search.id]],reader_pools:[[reader.id]],model_endpoint_id:entities.items.find(e=>e.kind==='model').id});
  key=made.api_key;project=made.project;
});
after(()=>{server?.closeAllConnections();server?.close();});
async function business(op,input){
  const r=await fetch(base+'/v1/search/'+op,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(input)});
  const data=await r.json();
  if(!r.ok){
    await settled(base,data.request_id,{Cookie:cookie});
    const details=await call('/admin/v1/endpoint-calls?request_id='+data.request_id,null,'GET');
    console.error('Browser failure calls',JSON.stringify(details.items));
  }
  assert.ok(r.ok,JSON.stringify(data));await settled(base,data.request_id,{Cookie:cookie});return data;
}
test('Firefox reads dynamic DOM and persists a reusable static layout',async()=>{
  const result=await business('content',{url:'http://host.docker.internal:18780/article'});
  assert.ok(result.data.text.includes('Rainfall measurements'));
  assert.equal(result.data.final_url,'http://host.docker.internal:18780/article');
  const exported=await call('/admin/v1/requests/'+result.request_id+'/export',null,'GET');
  const page=exported.payloads.flatMap(s=>s.replay).find(m=>m.kind==='webpage');
  assert.ok(page.body.includes('<html'));
  const layout=await call('/admin/v1/requests/'+result.request_id+'/replay/'+page.material_id+'/layout',null,'GET');
  assert.ok(layout.srcdoc.includes('grid-template-columns'));
  assert.ok(layout.srcdoc.includes("default-src"));
});
test('Firefox search uses the measured egress and returns parser-produced links',async()=>{
  for(let n=0;n<10;n++){const e=await call('/admin/v1/endpoints?limit=100',null,'GET');if(e.items.find(e=>e.adapter==='browser_search').default_network_google_probe.reachable!==null)break;await new Promise(r=>setTimeout(r,500));}
  const result=await business('list',{query:'rainfall',count:2});
  assert.equal(result.data.items[0].title,'Rainfall field guide');
  const calls=await call('/admin/v1/endpoint-calls?request_id='+result.request_id,null,'GET');
  assert.equal(calls.items[0].browser_job.pod_uid,'local-worker');
  assert.ok(['google','baidu'].includes(calls.items[0].browser_job.search_engine));
});

test('a completed engine answer includes sources and stable list material returns at the minimum observation window',async()=>{
  const early=await business('list',{query:'early-ai-card',count:2});
  assert.ok(early.data.items.length);
  assert.match(early.data.engine_answer.content,/rain gauge/i);
  assert.equal(early.data.engine_answer.sources[0].url,'https://example.org/rain-source');
  const late=await business('list',{query:'late-ai-card',count:2});
  assert.ok(late.data.items.length);
  assert.equal(late.data.engine_answer,undefined);
  const trace=await call('/admin/v1/requests/'+late.request_id+'/export',null,'GET');
  const observation=trace.payloads.find(p=>p.span.stage==='search').output.search_readiness;
  assert.ok(observation.elapsed_ms>=3900 && observation.elapsed_ms<4500,JSON.stringify(observation));
  assert.equal(observation.return_reason,'material_ready');
});

test('Firefox rejects a refused page and subsequent jobs can use the same capability',async()=>{
  const response=await fetch(base+'/v1/search/content',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({url:'http://host.docker.internal:18780/refused'})});
  const denied=await response.json();assert.equal(response.status,502);assert.equal(denied.error.code,'ACCESS_DENIED');
  await settled(base,denied.request_id,{Cookie:cookie});
  const next=await business('content',{url:'http://host.docker.internal:18780/article'});assert.ok(next.data.text.includes('rainfall'));
});

test('cancelling a navigation closes its Firefox job and keeps the next request usable',async()=>{
  const request=crypto.randomUUID();
  const pending=fetch(base+'/v1/search/content',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','X-Request-ID':request},body:JSON.stringify({url:'http://host.docker.internal:18780/slow-article'})});
  await new Promise(r=>setTimeout(r,2200));await call('/admin/v1/requests/'+request+'/cancel',{});
  const response=await pending,value=await response.json();assert.equal(value.error.code,'CANCELLED');
  await settled(base,request,{Cookie:cookie});
  const result=await business('content',{url:'http://host.docker.internal:18780/article'});assert.ok(result.data.text.includes('rainfall'));
});
