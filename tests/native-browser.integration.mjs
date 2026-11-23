import {test,before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from './fixture.mjs';

const exec=promisify(execFile),name='oas-native-'+randomUUID(),key=randomUUID();
const docker=async(...args)=>(await exec('docker',args,{timeout:30000,maxBuffer:4*1024*1024})).stdout.trim();
let site,base,job;
async function ready(){return (await fetch(base+'/health/ready')).json();}
async function command(action,fields={}){
 const response=await fetch(base+'/internal/jobs',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
  body:JSON.stringify({...job,action,...fields}),signal:AbortSignal.timeout(35000)});
 return {status:response.status,value:await response.json()};
}
async function newJob(){job={job_id:randomUUID(),request_id:randomUUID(),owner:'native-integration',pod_uid:name,deadline_ms:45000};
 const opened=await command('open');assert.equal(opened.value.opened,true,JSON.stringify(opened));}
before(async()=>{
 assert.ok(process.env.OAS_TEST_BROWSER_IMAGE,'Set OAS_TEST_BROWSER_IMAGE');
 site=await fixture();
 await docker('run','-d','--name',name,'--label','oas.task=native-messaging-1122','-p','127.0.0.1::8090','--shm-size=256m','--memory=900m',
  '--add-host','host.docker.internal:host-gateway','-e','OAS_WORKER_KEY='+key,'-e','POD_UID='+name,'-e','OAS_WORKER_SLOTS=1',
  '-e','OAS_NATIVE_DEBUG=1','-e','OAS_EGRESS_ALLOW_HOSTS=host.docker.internal','-e','OAS_TEST_GOOGLE_ORIGIN=http://host.docker.internal:18780',
  '-e','OAS_TEST_BAIDU_ORIGIN=http://host.docker.internal:18780',process.env.OAS_TEST_BROWSER_IMAGE);
 base='http://'+await docker('port',name,'8090/tcp');
 for(let i=0;i<100;i++){try{if((await ready()).status==='ready')return;}catch{}await delay(150);}
 throw Error('Native worker not ready');
});
afterEach(async()=>{
 if(job){await command('cancel').catch(()=>{});job=null;}
 for(let i=0;i<50;i++){if((await ready()).free_slots===1)return;await delay(100);}
 assert.fail('Native worker did not release its slot after the test');
});
after(async()=>{
 try{if(process.env.OAS_NATIVE_LOGS)console.log(await docker('logs',name));}finally{
  await docker('rm','-fv',name).catch(()=>{});site?.closeAllConnections();await new Promise(resolve=>site?site.close(resolve):resolve());
 }
});

test('a genuine Firefox page reports webdriver false, ignores hidden and disabled search fields and preserves Unicode queries',async()=>{
 await newJob();
 for(const engine of ['google','baidu']){
  const reply=await command('search',{engine,query:'广州降雨测量 🙂',count:5,time_range:'month'});
  assert.equal(reply.status,200,JSON.stringify(reply));
  assert.equal(reply.value.driver,'native_messaging');
  assert.equal(reply.value.webdriver,false);assert.equal(reply.value.page_webdriver,false);
  assert.ok(reply.value.hits.length>0);
  assert.ok(site.requests.some(r=>(r.request_url.includes('q=')||r.request_url.includes('wd='))&&decodeURIComponent(r.request_url).includes('广州')));
 }
 const processes=await docker('exec',name,'sh','-c','cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\\000" " "');
 assert.ok(!/geckodriver|--marionette|--remote-debugging-port/.test(processes));
 assert.equal((await command('close')).value.closed,true);
});

test('complete redirect or hydration documents without the current query input do not cause premature parse failures',async()=>{
 await newJob();
 for(const engine of ['google','baidu']){
  const response=await command('search',{engine,query:'hydrating-search',count:5});assert.equal(response.status,200,JSON.stringify(response));assert.ok(response.value.hits.length);
 }
 await command('close');
});

test('Google and Baidu retain factual cards, current input values, tables and code while excluding navigation and ads',async()=>{
 await newJob();
 for(const engine of ['google','baidu']){
  const response=await command('search',{engine,query:'live-value-weather-card',count:5});assert.equal(response.status,200,JSON.stringify(response));
  const card=response.value.cards[0];assert.equal(card.engine,engine);assert.ok(card.url.includes(engine==='google'?'/search?':'/s?'));
  assert.match(card.content,/降雨量: 12/);assert.match(card.content,/今天\s*\|\s*12 mm/);assert.match(card.content,/```[\s\S]*rain = 12/);
  assert.ok(!/HIDDEN_NOISE|QUERY_NAVIGATION_NOISE|QUERY_SUGGESTION_NOISE|AD_NOISE/.test(card.content),card.content);
  assert.equal(response.value.engine_answer,undefined);assert.ok(response.value.hits.length);
  const only=await command('search',{engine,query:'card-only',count:5});assert.equal(only.status,200,JSON.stringify(only));
  assert.equal(only.value.hits.length,0);assert.ok(only.value.cards.length);assert.equal(only.value.search_readiness.return_reason,'material_ready');
 }
 await command('close');
});

test('late card material and AI-only answers can finish after four seconds within the submitted-query budget',async()=>{
 await newJob();
 for(const engine of ['google','baidu'])for(const query of ['late-material-card','ai-only']){
  const response=await command('search',{engine,query,count:5});assert.equal(response.status,200,JSON.stringify(response));
  assert.ok(response.value.search_readiness.elapsed_ms>=4200,JSON.stringify(response.value.search_readiness));
  assert.ok(response.value.search_readiness.elapsed_ms<7000);
  if(query==='ai-only'){assert.match(response.value.engine_answer.content,/rain gauge/i);assert.equal(response.value.search_readiness.return_reason,'ai_answer_ready');}
  else assert.ok(response.value.cards.length);
 }
 await command('close');
});

test('fragment completion and copy controls inside a still-generating AI body never authorize a direct answer',async()=>{
 await newJob();
 for(const engine of ['google','baidu']){
  const response=await command('search',{engine,query:'fragment-ai-card',count:5});assert.equal(response.status,200,JSON.stringify(response));
  assert.equal(response.value.engine_answer,undefined);assert.equal(response.value.search_readiness.answer_state,'pending');
 }
 await command('close');
});

test('Baidu citation panels belong to the current answer and ignore stale floating panels and replaced answer bodies',async()=>{
 await newJob();
 for(const query of ['popup-ai-card','popup-stale-ai-card']){
  const response=await command('search',{engine:'baidu',query,count:5});assert.equal(response.status,200,JSON.stringify(response));
  assert.deepEqual(response.value.engine_answer.sources.map(s=>s.url),['https://example.org/rain-source']);
  if(query.includes('stale'))assert.match(response.value.engine_answer.content,/New rainfall answer/);
 }
 await command('close');
});

test('native article capture retains HTTP status, layout resources and isolated reader cleanup',async()=>{
 await newJob();
 const read=await command('extract',{url:'http://host.docker.internal:18780/article'});
 assert.equal(read.status,200,JSON.stringify(read));assert.equal(read.value.webdriver,false);assert.equal(read.value.page_webdriver,false);
 assert.ok(read.value.body.includes('Rainfall measurements'));assert.ok(read.value.layout.srcdoc.includes('data:image/gif;base64,'),JSON.stringify({state:read.value.layout.state,missing:read.value.layout.missing_resource_count,images:(read.value.layout.srcdoc.match(/<img[^>]+>/g)||[]).map(s=>s.match(/src="([^"]*)/)[1].slice(0,80)),requests:site.requests.slice(-12).map(r=>r.path)}));
 assert.ok(read.value.layout.srcdoc.includes('grid-template-columns'));assert.ok(!read.value.layout.srcdoc.includes('<script'));
 assert.ok(['validate','navigate','extract','archive'].every(stage=>read.value._phases.some(p=>p.stage===stage&&p.status==='success')));
 for(const [path,code]of [['/refused','ACCESS_DENIED'],['/risk-article','ENDPOINT_RISK_CONTROL'],['/redirect-private','URL_NOT_ALLOWED']]){
  const refused=await command('extract',{url:'http://host.docker.internal:18780'+path});
  assert.equal(refused.value.code,code,JSON.stringify(refused));
 }
 const again=await command('extract',{url:'http://host.docker.internal:18780/article'});assert.equal(again.status,200,JSON.stringify(again));
 assert.equal((await command('close')).value.closed,true);assert.equal((await ready()).free_slots,1);
});

test('native search challenges remain errors and a later normal query can use the worker',async()=>{
 await newJob();
 const denied=await command('search',{engine:'google',query:'browser-risk',count:5});
 assert.equal(denied.value.code,'ENDPOINT_RISK_CONTROL',JSON.stringify(denied));
 await command('close');await newJob();
 const good=await command('search',{engine:'baidu',query:'rainfall',count:5});assert.equal(good.status,200,JSON.stringify(good));
 await command('close');
});
