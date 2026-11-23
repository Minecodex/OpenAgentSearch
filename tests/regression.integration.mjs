import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.mjs';
const base=process.env.OAS_TEST_API||'http://127.0.0.1:18080',upstream=process.env.OAS_TEST_FIXTURE_BASE||'http://host.docker.internal:18780';
let server,cookie,csrf;
async function call(path,body,method=body?'POST':'GET',status=200){
  const response=await fetch(base+path,{method,headers:{Cookie:cookie,Origin:base,'X-CSRF-Token':csrf,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const json=await response.json();assert.equal(response.status,status,JSON.stringify(json));return json.data;
}
before(async()=>{server=await fixture();const response=await fetch(base+'/admin/v1/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:process.env.OAS_TEST_PASSWORD||'admin123'})});assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];csrf=(await response.json()).data.csrf_token;});
after(()=>{server?.closeAllConnections();server?.close();});
async function endpoint(name,suffix='',kind='search',timeout=3000){return call('/admin/v1/endpoints',{name,kind,provider:'tavily',adapter:kind==='search'?'http_search':'http_reader',base_url:upstream+suffix,timeout_ms:timeout,max_concurrency:4,rpm:10000,options:{}},'POST',201);}
async function project(search,reader=[]){return call('/admin/v1/projects',{name:'Regression project',rewrite_count:0,search_pools:search,reader_pools:reader},'POST',201);}
async function business(made,op,input){const response=await fetch(base+'/v1/search/'+op,{method:'POST',headers:{Authorization:'Bearer '+made.api_key,'Content-Type':'application/json'},body:JSON.stringify(input)});return {http_status:response.status,...await response.json()};}
async function recorded(id){for(let n=0;n<50;n++){const detail=await call('/admin/v1/requests/'+id);if(detail.metadata.status!=='running'&&!detail.incomplete_reasons?.includes('diagnostics_pending'))return detail;await new Promise(r=>setTimeout(r,40));}assert.fail('diagnostics did not finish');}
test('source 403 and per-endpoint timeout both fall forward; explicit target denial is terminal',async()=>{
  const good=await endpoint('Good');
  for(const [suffix,timeout]of[['/upstream-denied',3000],['/slow',100]]){
    const bad=await endpoint(suffix,suffix,'search',timeout),made=await project([[bad.id,good.id]]);
    const result=await business(made,'list',{query:'rainfall'});assert.equal(result.http_status,200,JSON.stringify(result));await recorded(result.request_id);
    const calls=await call('/admin/v1/endpoint-calls?request_id='+result.request_id);assert.equal(calls.items.length,2);assert.equal(calls.items.filter(c=>c.status==='error').length,1);
  }
  const denied=await endpoint('Target denied','/target-denied','reader'),reader=await endpoint('Reader','','reader'),made=await project([],[[denied.id,reader.id]]);
  const result=await business(made,'content',{url:upstream+'/article'});assert.equal(result.error.code,'ACCESS_DENIED');await recorded(result.request_id);
  assert.equal((await call('/admin/v1/endpoint-calls?request_id='+result.request_id)).items.length,1);
});
test('keyword filters, unique call cursors and empty time windows remain consistent',async()=>{
  const bad=await endpoint('Denied','/upstream-denied'),good=await endpoint('Allowed'),made=await project([[bad.id,good.id]]);
  const result=await business(made,'list',{query:'rainfall'});await recorded(result.request_id);
  const byText=await call('/admin/v1/requests?q='+result.request_id);assert.equal(byText.items.length,1);
  const query='/admin/v1/endpoint-calls?request_id='+result.request_id+'&limit=1';
  const first=await call(query),second=await call(query+'&cursor='+first.next_cursor);
  assert.notEqual(first.items[0].call_id,second.items[0].call_id);assert.equal(second.next_cursor,null);
  const empty=await call('/admin/v1/endpoint-statistics?from=2001-01-01T00:00:00Z&to=2001-01-02T00:00:00Z&granularity=day&timezone=Asia%2FShanghai');assert.equal(empty.overview.calls,0);assert.equal(empty.series.length,0);
});
test('explicit risk control excludes an ordinary endpoint across requests',async()=>{
  const risk=await endpoint('Risk','/risk'),good=await endpoint('Good'),made=await project([[risk.id],[good.id]]);
  for(let attempt=0;attempt<2;attempt++){
    const result=await business(made,'list',{query:'rainfall'});assert.equal(result.http_status,200);await recorded(result.request_id);
    const calls=await call('/admin/v1/endpoint-calls?request_id='+result.request_id);assert.equal(calls.items.length,attempt===0?2:1);
  }
});
test('credential commands reject unknown fields and empty credentials',async()=>{
  await call('/admin/v1/proxies',{name:'Invalid',scheme:'socks5',host:'example.com',port:1080,auth_mode:'password',max_concurrency:1,enabled:true,secret:{username:'',password:''}},'POST',400);
  await call('/admin/v1/endpoints',{name:'Invalid',kind:'search',provider:'tavily',adapter:'http_search',base_url:upstream,timeout_ms:1000,max_concurrency:1,rpm:10,options:{},secret:{api_key:'x',unexpected:'y'}},'POST',400);
});

test('client disconnect finalizes its dispatched attempt and releases request admission',async()=>{
  const slow=await endpoint('Disconnect','/slow','search',8000),made=await project([[slow.id]]);
  const request=crypto.randomUUID(),controller=new AbortController();
  const pending=fetch(base+'/v1/search/list',{method:'POST',headers:{Authorization:'Bearer '+made.api_key,'Content-Type':'application/json','X-Request-ID':request},body:JSON.stringify({query:'rainfall'}),signal:controller.signal}).catch(error=>error);
  for(let n=0;n<20;n++){const response=await fetch(base+'/admin/v1/requests/'+request,{headers:{Cookie:cookie}});if(response.ok)break;await new Promise(r=>setTimeout(r,20));}
  await new Promise(r=>setTimeout(r,150));controller.abort();await pending;
  const detail=await recorded(request);assert.equal(detail.metadata.status,'cancelled');
  const calls=await call('/admin/v1/endpoint-calls?request_id='+request);assert.equal(calls.items[0].status,'cancelled');
});
test('SearXNG engine failures cannot masquerade as a legal empty search',async()=>{
  const e=await call('/admin/v1/endpoints',{name:'Failed SearXNG',kind:'search',provider:'searxng',adapter:'http_search',base_url:upstream+'/searx-failed',timeout_ms:1000,max_concurrency:1,rpm:100,options:{engines:[]}},'POST',201);
  const made=await project([[e.id]]),result=await business(made,'list',{query:'rainfall'});assert.equal(result.http_status,502);assert.equal(result.error.code,'SEARCH_FAILED');
});

test('unsupported API paths and methods keep localized JSON errors',async()=>{
  for(const [path,status]of [['/v1/search/list',405],['/v1/not-found',404]]){
    const response=await fetch(base+path,{headers:{'Accept-Language':'en'}}),body=await response.json();assert.equal(response.status,status);assert.ok(body.error.message);assert.equal(body.status,'error');
  }
});
