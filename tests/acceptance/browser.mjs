import {test,before,beforeEach,after} from 'node:test';
import {assert,check,prove} from './proof.mjs';
import {spawnSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {proxies} from '../proxies.mjs';
import {base,upstream,server,cookie,setup,close,admin,endpoint,project,business,recorded,sql,q,sleep} from './context.mjs';
let outlets;
before(async()=>{await setup();outlets=await proxies();});after(()=>{close();outlets?.close();});
const searchId='00000000-0000-4000-8000-000000000001',readerId='00000000-0000-4000-8000-000000000002';
function docker(...args){const r=spawnSync('docker',args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function owned(name){assert.match(process.env[name]||'',/^oas-local-[a-f0-9]{8}-(api|browser)$/);return process.env[name];}
function probe(id,version,reachable){const value={reachable,checked_at:new Date().toISOString(),probe_pod_uid:'representative-fixture'};sql(`INSERT INTO probes(egress_id,version,body,generation) VALUES('${id}',${version},'${JSON.stringify(value)}',nextval('oas_probe_generation')) ON CONFLICT(egress_id) DO UPDATE SET version=EXCLUDED.version,body=EXCLUDED.body,generation=EXCLUDED.generation;`);return value;}
async function proxiesResource(scheme='socks5',port=18781,password='sample-password'){
 return admin('proxies',{name:'Acceptance '+scheme,scheme,host:'host.docker.internal',port,auth_mode:'password',secret:{username:'sample',password},max_concurrency:2,enabled:true},'POST',201);
}
async function browserProject(pool,extra={}){return project({search_pools:[[searchId]],reader_pools:[[readerId]],browser_proxy_pool_id:pool?.id||null,...extra});}
const proxyBody=p=>Object.fromEntries(['name','scheme','host','port','auth_mode','max_concurrency','enabled'].map(key=>[key,p[key]]));
async function isolateExits(reset=true){
 owned('OAS_TEST_BROWSER');
 if(reset)sql('DELETE FROM browser_engine_health;');
 const {items}=await admin('proxies?limit=100');
 for(const proxy of items.filter(p=>p.enabled))await admin('proxies/'+proxy.id,{...proxyBody(proxy),enabled:false,expected_version:proxy.version,secret_action:'keep'},'PUT');
}
beforeEach(isolateExits);

test('A09 proxy credentials never echo, tests belong to the tested version, and disabling or referenced deletion is immediate',async()=>{
 const proxy=await proxiesResource();assert.equal(proxy.has_secret,true);assert.ok(!JSON.stringify(proxy).includes('sample-password'));
 const receipt=await admin('proxies/'+proxy.id+'/test',{});assert.equal(receipt.status,'success',JSON.stringify(receipt));check('A09.password',()=>assert.equal(receipt.status,'success'));check('A09.no_secret_echo',()=>{assert.ok(proxy.has_secret);assert.ok(!JSON.stringify(receipt).includes('sample-password'));});assert.equal(receipt.resource_version,1);
 const pool=await admin('proxy-pools',{name:'Referenced proxy pool',members:[{proxy_id:proxy.id,weight:1}]},'POST',201);await prove('A09.reference_conflict',async()=>{await admin('proxies/'+proxy.id+'?expected_version=1',undefined,'DELETE',409);});
 const changed=await admin('proxies/'+proxy.id,{...proxyBody(proxy),enabled:false,expected_version:1,secret_action:'keep'},'PUT');assert.equal(changed.has_secret,true);assert.equal(changed.last_test,null);
 const made=await browserProject(pool);await prove('A09.disabled',async()=>{await business(made,'content',{url:upstream+'/article'},503);});
 const renewed=await admin('proxies/'+proxy.id,{...proxyBody(changed),enabled:true,expected_version:changed.version,secret_action:'replace',secret:{username:'sample',password:'wrong'}},'PUT');const failed=await admin('proxies/'+proxy.id+'/test',{});assert.equal(failed.status,'error');check('A09.version_receipt',()=>{assert.equal(failed.resource_version,renewed.version);assert.equal(changed.last_test,null);});assert.ok((await admin('requests/'+failed.trace_request_id)).spans.every(s=>s.status==='error'));
 await admin('proxy-pools/'+pool.id,{name:pool.name,members:[],expected_version:pool.version},'PUT');await admin('proxies/'+proxy.id+'?expected_version='+renewed.version,undefined,'DELETE',200);
});

test('A10 both authenticated proxy protocols carry parallel jobs with authorized egress and independent cleanup',async()=>{
 for(const[scheme,port]of [['socks5',18781],['https',18782]]){
  const proxy=await proxiesResource(scheme,port);check('A09.'+(scheme==='socks5'?'socks':'https'),()=>{assert.equal(proxy.scheme,scheme);assert.equal(proxy.port,port);assert.ok(proxy.has_secret);});probe(proxy.id,proxy.version,false);const pool=await admin('proxy-pools',{name:scheme+' egress',members:[{proxy_id:proxy.id,weight:3}]},'POST',201),made=await browserProject(pool,{rewrite_count:1});
  const result=await business(made,'summary',{query:'rainfall'});await recorded(result.request_id);const calls=(await admin('endpoint-calls?request_id='+result.request_id+'&limit=100')).items.filter(c=>c.browser_job);
  assert.ok(calls.length>=2);assert.equal(new Set(calls.map(c=>c.browser_job.job_id)).size,calls.length);assert.equal(new Set(calls.map(c=>c.browser_job.pod_uid)).size,1);assert.ok(calls.every(c=>c.browser_job.proxy_id===proxy.id));assert.ok(calls.filter(c=>c.kind==='reader').every(c=>!('google_probe'in c.browser_job)));
  const exported=await admin('requests/'+result.request_id+'/export');assert.ok(!JSON.stringify(exported).includes('sample-password'));check('A10.fixed_egress',()=>{const searches=calls.filter(c=>c.kind==='search');assert.equal(searches.length,2);assert.ok(searches.every(c=>!c.browser_job.reused_context));assert.ok(calls.every(c=>c.browser_job.proxy_id===proxy.id));assert.equal(new Set(searches.map(c=>c.browser_job.job_id)).size,2);});check('A10.'+(scheme==='socks5'?'socks':'https')+'_egress',()=>assert.ok(outlets.count[scheme==='socks5'?'socks':'https']>0));
 }
 assert.ok(outlets.count.socks>0&&outlets.count.https>0);const d=await admin('diagnostics');assert.ok(Object.values(d.scheduler.active_leases).every(n=>n===0));
});

test('A10 an attributable pre-target proxy connection failure reselects at most once and target refusal does not cool a healthy proxy',async()=>{
 const bad=await proxiesResource('socks5',18789),good=await proxiesResource();const pool=await admin('proxy-pools',{name:'One allowed reselection',members:[{proxy_id:bad.id,weight:100},{proxy_id:good.id,weight:1}]},'POST',201),made=await browserProject(pool);
 const result=await business(made,'content',{url:upstream+'/article'});await recorded(result.request_id);const calls=(await admin('endpoint-calls?request_id='+result.request_id)).items;assert.equal(calls.length,2);assert.equal(calls.filter(c=>c.status==='error').length,1);assert.equal(calls.find(c=>c.status==='success').browser_job.proxy_id,good.id);
 const status=await admin('proxies/'+bad.id);assert.equal(status.failure_count,1);check('A10.one_reselection',()=>{assert.equal(calls.length,2);assert.equal(status.failure_count,1);assert.equal(status.health,'degraded');});
 const only=await admin('proxy-pools',{name:'Target refusal',members:[{proxy_id:good.id,weight:1}]},'POST',201),refused=await browserProject(only);await business(refused,'content',{url:upstream+'/refused'},502);await prove('A10.target_refusal',async()=>assert.equal((await admin('proxies/'+good.id)).failure_count,0));
});

test('A21 language starts at the first matching pool regardless of eligibility and built-in browser risk never creates half-hour exclusion',async()=>{
 const a=await endpoint('search'),b=await endpoint('search'),c=await endpoint('search');const made=await project({search_pools:[[a.id],[b.id,c.id],[searchId]]});const routes=await admin('language-routes');await admin('language-routes',{expected_version:routes.version,entries:[{language:'en',endpoint_ids:[b.id]}]},'PUT');
 const order=[];for(let i=0;i<4;i++){const result=await business(made,'list',{query:'rain',language:'en'});await recorded(result.request_id);order.push((await admin('endpoint-calls?request_id='+result.request_id)).items[0].endpoint_id);}check('A21.language_entry',()=>assert.ok(order.every(id=>[b.id,c.id].includes(id))));check('A21.equal_round_robin',()=>assert.deepEqual(order,[b.id,c.id,b.id,c.id]));
 sql(`UPDATE endpoint_stats_hour SET metrics=jsonb_set(metrics,'{speed_ms}','999999'::jsonb) WHERE metrics->'dimensions'->>'project_id'='${made.project.id}';`);
 const unchanged=await business(made,'list',{query:'rain',language:'en'});await recorded(unchanged.request_id);await prove('A21.observation_readonly',async()=>assert.equal((await admin('endpoint-calls?request_id='+unchanged.request_id)).items[0].endpoint_id,b.id));
 const riskEndpoint=await endpoint('search','',{base_url:upstream+'/risk'});const firstProject=await project({search_pools:[[riskEndpoint.id],[c.id]]}),secondProject=await project({search_pools:[[riskEndpoint.id],[c.id]]});
 for(const[index,p]of [firstProject,secondProject].entries()){const result=await business(p,'list',{query:'rain'});await recorded(result.request_id);const calls=(await admin('endpoint-calls?request_id='+result.request_id)).items;assert.equal(calls.length,index===0?2:1);assert.ok(calls.some(call=>call.endpoint_id===c.id));if(index===0)assert.ok(calls.some(call=>call.endpoint_id===riskEndpoint.id&&call.status==="error"));check('A21.cross_project_risk',()=>assert.equal(calls.length,index===0?2:1));check('A21.forward_only',()=>assert.ok(calls.some(call=>call.endpoint_id===c.id)));check('A21.pool_exhausted',()=>assert.ok(calls.some(call=>call.endpoint_id===c.id)));}
 const reset=await admin('language-routes');await admin('language-routes',{expected_version:reset.version,entries:[]},'PUT');probe('default_network',1,true);
 const fallback=await browserProject(null,{search_pools:[[searchId],[a.id]],reader_pools:[[readerId],[made.reader.id]]});
 const risk=await business(fallback,'list',{query:'browser-risk'});await recorded(risk.request_id);const riskCalls=(await admin('endpoint-calls?request_id='+risk.request_id)).items;
 check('A23.both_engines_fail',()=>{assert.equal(riskCalls.length,3);assert.equal(riskCalls.filter(c=>c.endpoint_id===searchId&&c.status==='error').length,2);assert.ok(riskCalls.some(c=>c.endpoint_id===a.id&&c.status==='success'));});
 const next=await business(fallback,'list',{query:'rainfall'});await recorded(next.request_id);await prove('A21.browser_search_exempt',async()=>assert.equal((await admin('endpoint-calls?request_id='+next.request_id)).items[0].endpoint_id,searchId));
 const readerRisk=await business(fallback,'content',{url:upstream+'/risk-article'});await recorded(readerRisk.request_id);assert.equal((await admin('endpoint-calls?request_id='+readerRisk.request_id)).items.length,2);
 const readerNext=await business(fallback,'content',{url:upstream+'/article'});await recorded(readerNext.request_id);await prove('A21.browser_reader_exempt',async()=>assert.equal((await admin('endpoint-calls?request_id='+readerNext.request_id)).items[0].endpoint_id,readerId));
 assert.equal(sql(`SELECT count(*) FROM endpoint_risk_cooldowns WHERE endpoint_id IN('${searchId}','${readerId}');`),'0');
});

test('A23 current egress samples select the initial engine Google or Baidu, unknown and stale versions get zero search calls',async()=>{
 const made=await browserProject();for(const reachable of [true,false]){probe('default_network',1,reachable);const result=await business(made,'list',{query:'early-ai-card'});assert.equal(result.data.engine_answer.engine,reachable?'google':'baidu');assert.ok(result.data.engine_answer.sources.length);await recorded(result.request_id);const call=(await admin('endpoint-calls?request_id='+result.request_id)).items[0];check('A23.engine.default.'+(reachable?'google':'baidu'),()=>assert.equal(call.browser_job.search_engine,reachable?'google':'baidu'));assert.equal(call.browser_job.google_probe.probe_pod_uid,'representative-fixture');}
 const proxy=await proxiesResource();const pool=await admin('proxy-pools',{name:'Versioned sample',members:[{proxy_id:proxy.id,weight:1}]},'POST',201);probe(proxy.id,proxy.version,true);const current=await admin('proxies/'+proxy.id,{...proxyBody(proxy),port:18781,expected_version:proxy.version,secret_action:'keep'},'PUT');const bound=await browserProject(pool,{search_pools:[[searchId],[made.search.id]]});
 docker('pause',owned('OAS_TEST_BROWSER'));try{await sleep(150);probe(proxy.id,proxy.version,true);const result=await business(bound,'list',{query:'rain'});await recorded(result.request_id);assert.ok((await admin('endpoint-calls?request_id='+result.request_id)).items.every(c=>!c.browser_job));}finally{docker('unpause',owned('OAS_TEST_BROWSER'));}
 probe(proxy.id,current.version,false);const measured=await business(bound,'list',{query:'rain'});await recorded(measured.request_id);assert.equal((await admin('endpoint-calls?request_id='+measured.request_id)).items[0].browser_job.search_engine,'baidu');
 const reader=await business(bound,'content',{url:upstream+'/article'});check('A23.reader_independent',()=>assert.ok(reader.data.text));
});

function worker(path,command){const key=process.env.OAS_TEST_WORKER_KEY;assert.ok(key);const output=docker('exec','-i',owned('OAS_TEST_BROWSER'),'curl','--silent','--show-error','--max-time','15','--write-out','\n%{http_code}','-H','Authorization: Bearer '+key,...(command?['-H','Content-Type: application/json','--data',JSON.stringify(command)]:[]),'http://127.0.0.1:8090'+path);const lines=output.split('\n');return {status:Number(lines.pop()),body:JSON.parse(lines.join('\n'))};}

async function waitForScheduler(ready, message) {
 const deadline = Date.now() + 15000;
 do {
  const {scheduler} = await admin('diagnostics');
  if (ready(scheduler)) return;
  await sleep(100);
 } while (Date.now() < deadline);
 assert.fail(message);
}

test('A11 late opens stay closed and stale owners cannot close another worker job and crash recovery eventually releases quarantined capacity',async()=>{
 const id=crypto.randomUUID(),request=crypto.randomUUID(),nextId=crypto.randomUUID();const cmd={job_id:id,request_id:request,owner:'first-owner',pod_uid:'local-worker',action:'open',deadline_ms:15000,count:0};
 const late={...cmd,job_id:crypto.randomUUID()};
 assert.equal(worker('/internal/jobs',{...late,action:'cancel'}).status,200);await sleep(2200);check('A11.late_open',()=>assert.equal(worker('/internal/jobs',late).status,409));
 try{
  assert.equal(worker('/internal/jobs',cmd).status,200);assert.equal(worker('/internal/jobs',{...cmd,action:'close'}).status,200);assert.equal(worker('/internal/jobs',{...cmd,owner:'second-owner'}).status,409);
  assert.equal(worker('/internal/jobs',{...cmd,job_id:nextId,owner:'second-owner'}).status,200);check('A11.stale_owner',()=>assert.equal(worker('/internal/jobs',{...cmd,job_id:nextId,action:'close'}).status,409));assert.equal(worker('/health/ready').body.free_slots,3);
 }finally{worker('/internal/jobs',{...cmd,job_id:nextId,owner:'second-owner',action:'close'});}
 const made=await browserProject(),rid=crypto.randomUUID(),start=server.requests.length;const pending=fetch(base+'/v1/search/content',{method:'POST',headers:{Authorization:'Bearer '+made.api_key,'Content-Type':'application/json','X-Request-ID':rid},body:JSON.stringify({url:upstream+'/slow-article'})}).then(async r=>({status:r.status,body:await r.json()}));
 for(let n=0;n<150&&!server.requests.slice(start).some(r=>r.path==='/slow-article');n++)await sleep(40);assert.ok(server.requests.slice(start).some(r=>r.path==='/slow-article'),'the current job must reach its target before the worker crashes');
 const browserContainer = owned('OAS_TEST_BROWSER');
 docker('kill', browserContainer);
 try {
  const failed = await pending;
  check('A11.worker_crash', () => assert.ok(failed.status >= 400));
  await recorded(rid);
  await waitForScheduler(s => s.ready_workers === 0, 'discovery must remove the crashed worker');
 } finally {
  docker('start', browserContainer);
 }
 await waitForScheduler(
  s => s.ready_workers === 1 && Object.values(s.active_leases).every(count => count === 0),
  'discovery and cleanup must complete before the next browser request',
 );
 assert.equal(worker('/health/ready').body.free_slots,4);const next=await business(made,'content',{url:upstream+'/article'});assert.ok(next.data.text);await recorded(next.request_id);
});

test('a missing browser cleanup receipt retains the slot until recovery confirms closure',async()=>{
 for(let n=0;n<100;n++){
  const endpoint=await admin('endpoints/'+readerId),state=await admin('diagnostics');
  if(endpoint.availability==='available' && state.scheduler.ready_workers===1 && Object.values(state.scheduler.active_leases).every(n=>n===0))break;
  assert.ok(n<99,'the recovered worker must be discoverable before fault injection');await sleep(100);
 }
 const made=await browserProject(),id=crypto.randomUUID(),before=server.requests.length;
 // Observe rejection immediately while waiting for target arrival; report it at
 // the owning await instead of allowing an unhandled rejection into another test.
 const pending=business(made,'content',{url:upstream+'/slow-article?quarantine'},499,{'X-Request-ID':id}).then(value=>({value}),error=>({error}));
 for(let n=0;n<200&&!server.requests.slice(before).some(r=>r.path==='/slow-article');n++)await sleep(25);
 assert.ok(server.requests.slice(before).some(r=>r.path==='/slow-article'));
 docker('pause',owned('OAS_TEST_BROWSER'));
 try{
  await admin('requests/'+id+'/cancel',{});const settled=await pending;if(settled.error)throw settled.error;assert.equal(settled.value.error.code,'CANCELLED');await recorded(id);
  await prove('A11.quarantine',async()=>{const d=await admin('diagnostics');assert.equal(d.scheduler.active_leases['worker:local-worker'],1);const calls=(await admin('endpoint-calls?request_id='+id)).items;assert.ok(calls.some(c=>c.browser_job.phases.some(p=>p.stage==='cleanup'&&p.status==='error')));});
 }finally{docker('unpause',owned('OAS_TEST_BROWSER'));}
 for(let n=0;n<150;n++){const d=await admin('diagnostics');if(Object.values(d.scheduler.active_leases).every(n=>n===0))break;await sleep(100);}
 await prove('A11.quarantine',async()=>{const d=await admin('diagnostics');assert.ok(Object.values(d.scheduler.active_leases).every(n=>n===0));assert.equal(worker('/health/ready').body.free_slots,4);});
});

test('A15 scheduler ownership loss cancels active work and a restart recovers persisted configuration without old browser jobs',async()=>{
 const made=await project(),rid=crypto.randomUUID();
 const pending=fetch(base+'/v1/search/list',{method:'POST',headers:{Authorization:'Bearer '+made.api_key,'Content-Type':'application/json','X-Request-ID':rid},body:JSON.stringify({query:'ownership-slow'})}).then(async r=>r.json()).catch(error=>({transport:error.name}));
 await sleep(150);sql("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND objid=77183002 AND pid<>pg_backend_pid();");
 const interrupted=await pending;assert.ok(interrupted.transport||interrupted.error?.code==='CANCELLED');for(let n=0;n<100;n++){const state=docker('inspect','-f','{{.State.Running}}',owned('OAS_TEST_SERVER'));if(state==='false')break;await sleep(100);}docker('start',owned('OAS_TEST_SERVER'));
 for(let n=0;n<100;n++){try{if((await fetch(base+'/health/ready')).ok)break;}catch{}await sleep(100);}
 const result=await business(made,'list',{query:'rain'});assert.ok(result.data.items.length);const d=await admin('diagnostics');check('A15.ownership_loss',()=>{assert.ok(interrupted.transport||interrupted.error?.code==='CANCELLED');assert.equal(d.scheduler.stopping,false);});assert.equal(sql('SELECT count(*) FROM browser_jobs;'),'0');
});

test('redirects, denial and cancellation retain the browser capability and classify actual destinations',async()=>{
 const made=await browserProject();
 await prove('A05.redirect_public',async()=>{const value=await business(made,'content',{url:upstream+'/redirect'});assert.equal(value.data.url,upstream+'/redirect');assert.equal(value.data.final_url,upstream+'/article');assert.ok(value.data.text.includes('rainfall'));});
 await prove('A05.redirect_private',async()=>{const value=await business(made,'content',{url:upstream+'/redirect-private'},400);assert.equal(value.error.code,'URL_NOT_ALLOWED');});
 await prove('A05.unreachable',async()=>{await business(made,'content',{url:upstream+'/not-found'},502);});
 await prove('A11.target_denial',async()=>{const value=await business(made,'content',{url:upstream+'/refused'},502);assert.equal(value.error.code,'ACCESS_DENIED');});
 const start=server.requests.length;const id=crypto.randomUUID();const active=business(made,'content',{url:upstream+'/slow-article'},499,{'X-Request-ID':id});
 for(let n=0;n<200&&!server.requests.slice(start).some(r=>r.path==='/slow-article');n++)await sleep(30);
 await admin('requests/'+id+'/cancel',{});const result=await active;check('A11.cancel_navigation',()=>assert.equal(result.error.code,'CANCELLED'));await recorded(id);
});

test('manual proxy tests separate expected page status and content from transport health',async()=>{
 const proxy=await proxiesResource();try{
  for(const status of [200,404,500]){server.probeReply={status,body:'oas-probe-ok'};const value=await admin('proxies/'+proxy.id+'/test',{});check('A09.'+(status===200?'expected_200':'unexpected_'+status),()=>{assert.equal(value.status,status===200?'success':'error',JSON.stringify(value));assert.equal(value.diagnostics.http_status,status);assert.ok(value.diagnostics.reachable);assert.equal(value.diagnostics.proxy_healthy,true);});check('A09.phase_diagnostics',()=>{assert.deepEqual(value.diagnostics.phases.map(p=>p.stage),['connect','handshake','response']);assert.equal(value.diagnostics.phases.reduce((n,p)=>n+p.duration_ms,0),value.diagnostics.total_ms);assert.ok(value.diagnostics.phases.every(p=>p.source==='worker'));});}
  server.probeReply={status:200,body:'wrong-body'};const mismatch=await admin('proxies/'+proxy.id+'/test',{});check('A09.body_mismatch',()=>{assert.equal(mismatch.status,'error');assert.equal(mismatch.diagnostics.body_matches,false);assert.equal(mismatch.diagnostics.failure_kind,'target_body');});
  const bad=await proxiesResource('socks5',18781,'wrong');const auth=await admin('proxies/'+bad.id+'/test',{});check('A09.auth_failure',()=>{assert.equal(auth.status,'error');assert.equal(auth.diagnostics.failure_kind,'proxy_auth');});
  const tlsProxy=await admin('proxies',{name:'TLS hostname mismatch',scheme:'https',host:'wrong-proxy.test',port:18782,auth_mode:'password',secret:{username:'sample',password:'sample-password'},max_concurrency:1,enabled:true},'POST',201);const tls=await admin('proxies/'+tlsProxy.id+'/test',{});check('A09.tls_failure',()=>{assert.equal(tls.status,'error');assert.equal(tls.diagnostics.failure_kind,'proxy_tls');});
 }finally{server.probeReply=null;}
});

test('a job freezes its egress Google sample while a later request uses the replacement',async()=>{
 probe('default_network',1,false);const made=await browserProject(null,{rewrite_count:1});let changed=false;
 const update=req=>{if(!changed&&new URL(req.url,'http://fixture').pathname==='/s'){changed=true;probe('default_network',1,true);}};server.on('request',update);
 try{const value=await business(made,'summary',{query:'rain'});await recorded(value.request_id);const calls=(await admin('endpoint-calls?request_id='+value.request_id+'&limit=100')).items.filter(c=>c.kind==='search');check('A23.frozen_sample',()=>{assert.equal(calls.length,2);assert.ok(calls.every(c=>c.browser_job.search_engine==='baidu'&&c.browser_job.google_probe.reachable===false));});}finally{server.off('request',update);}
 const proxy=await proxiesResource();const pool=await admin('proxy-pools',{name:'Engine matrix',members:[{proxy_id:proxy.id,weight:1}]},'POST',201);const bound=await browserProject(pool);
 for(const state of [true,false]){probe(proxy.id,proxy.version,state);const result=await business(bound,'list',{query:'rain'});await recorded(result.request_id);const call=(await admin('endpoint-calls?request_id='+result.request_id)).items[0];check('A23.engine.proxy.'+(state?'google':'baidu'),()=>assert.equal(call.browser_job.search_engine,state?'google':'baidu'));}
});


test('two healthy weighted exits remain bounded when both proxy leases are held',async()=>{
 const high=await proxiesResource('socks5',18781),low=await proxiesResource('https',18782);
 const preparedAt=server.requests.length;
 for(const proxy of [high,low]){
   const current=await admin('proxies/'+proxy.id,{...proxyBody(proxy),max_concurrency:1,expected_version:proxy.version,secret_action:'keep'},'PUT');
   probe(current.id,current.version,false);
 }
 for(let n=0;n<300;n++){
   const homes=new Set(server.requests.slice(preparedAt).filter(r=>r.path==='/').map(r=>r.egress));
   if(homes.has('https') && homes.has('socks'))break;
   await sleep(100);
 }
 const pool=await admin('proxy-pools',{name:'Healthy weighted exits',members:[{proxy_id:high.id,weight:2},{proxy_id:low.id,weight:1}]},'POST',201),made=await browserProject(pool);
 const before=server.requests.length;const ids=[crypto.randomUUID(),crypto.randomUUID()];const first=business(made,'content',{url:upstream+'/hold-article?one'},200,{'X-Request-ID':ids[0]});let second,primaryError;
 try{
  for(let n=0;n<200&&!server.requests.slice(before).some(r=>r.path==='/hold-article');n++)await sleep(25);
  const one=server.requests.slice(before).find(r=>r.path==='/hold-article');check('A10.weighted_choice',()=>assert.equal(one?.egress,'socks'));
  second=business(made,'content',{url:upstream+'/hold-article?two'},200,{'X-Request-ID':ids[1]});
  for(let n=0;n<200&&server.requests.slice(before).filter(r=>r.path==='/hold-article').length<2;n++)await sleep(25);
  check('A10.shared_proxy_limit',()=>assert.deepEqual(server.requests.slice(before).filter(r=>r.path==='/hold-article').map(r=>r.egress).sort(),['https','socks']));
  const beforeThird=await admin('diagnostics');const third=await business(made,'content',{url:upstream+'/article'},429);await recorded(third.request_id);
  check('A10.both_saturated',()=>assert.equal(third.error.code,'CAPACITY_EXHAUSTED'));
  const after=await admin('diagnostics');check('A10.atomic_lease',()=>{assert.equal(after.scheduler.active_leases['proxy:'+high.id],1);assert.equal(after.scheduler.active_leases['proxy:'+low.id],1);assert.equal(after.scheduler.active_leases['worker:local-worker'],beforeThird.scheduler.active_leases['worker:local-worker']);});
 }catch(error){primaryError=error;throw error;}finally{for(const release of server.held||[])release();server.held=[];const results=await Promise.allSettled([first,...(second?[second]:[])]);if(results.some(r=>r.status==='rejected')){for(const id of ids){await recorded(id);await writeFile('artifacts/failed-browser-'+id+'.json',JSON.stringify(await admin('requests/'+id+'/export'),null,2));}console.error(docker('logs','--tail','50',owned('OAS_TEST_BROWSER')));}if(!primaryError)for(const result of results)assert.equal(result.status,'fulfilled',String(result.reason));}
});

test('Firefox capability tests and ordinary searches switch engines within the same job and time budget',async()=>{
 const project=await browserProject();const cachedProbe=probe('default_network',1,true);
 const probeRequests=server.requests.filter(r=>r.path==='/probe').length;
 async function attempts(requestId){
   await recorded(requestId);
   return (await admin('endpoint-calls?request_id='+requestId)).items;
 }
 function verifySwitch(rows, reason){
   assert.equal(rows.length,2,JSON.stringify(rows.map(row=>({status:row.status,code:row.error_code,engine:row.browser_job?.search_engine,selection:row.browser_job?.engine_selection,proxy:row.browser_job?.proxy_id,query:row.input_preview}))));
   const google=rows.find(c=>c.browser_job.search_engine==='google'),baidu=rows.find(c=>c.browser_job.search_engine==='baidu');
   assert.equal(google.status,'error');assert.equal(google.error_code,reason);assert.equal(baidu.status,'success');
   assert.equal(google.browser_job.job_id,baidu.browser_job.job_id);assert.equal(google.browser_job.pod_uid,baidu.browser_job.pod_uid);
   assert.deepEqual(google.browser_job.google_probe,baidu.browser_job.google_probe);assert.equal(baidu.browser_job.google_probe.reachable,true);
   assert.equal(baidu.browser_job.reused_context,true);assert.equal(baidu.browser_job.engine_fallback.call_id,google.call_id);
   assert.equal(baidu.browser_job.engine_fallback.reason,reason);assert.equal(baidu.input_preview,google.input_preview);
 }
 try {
   server.googleBehavior='risk';
   const receipt=await admin('endpoints/'+searchId+'/test',{});
   const tested=await attempts(receipt.trace_request_id);
   assert.deepEqual(tested[0].browser_job.google_probe,cachedProbe);
   assert.equal(server.requests.filter(r=>r.path==='/probe').length,probeRequests,'a business call must not run a connectivity probe');
   check('A23.test_engine_fallback',()=>{assert.equal(receipt.status,'success');verifySwitch(tested,'ENDPOINT_RISK_CONTROL');assert.deepEqual(receipt.search_attempts.map(a=>[a.engine,a.status]),[['google','error'],['baidu','success']]);});
   const proxy=await proxiesResource(),pool=await admin('proxy-pools',{name:'Engine fallback outlet',members:[{proxy_id:proxy.id,weight:1}]},'POST',201);
   probe(proxy.id,proxy.version,true);const bound=await browserProject(pool);
   const query='fallback rainfall',result=await business(bound,'list',{query,language:'fr',time_range:'month'});
   const rows=await attempts(result.request_id);
   check('A23.runtime_google_fallback',()=>{verifySwitch(rows,'ENDPOINT_RISK_CONTROL');assert.ok(rows.every(c=>c.browser_job.proxy_id===proxy.id));assert.ok(result.data.items.length);
      const urls=server.requests.filter(r=>r.method==='GET').map(r=>new URL(r.request_url,'http://fixture'));
      assert.ok(urls.some(u=>u.searchParams.get('q')===query && u.searchParams.get('tbs')==='qdr:m' && u.searchParams.get('hl')==='fr'));
      assert.ok(urls.some(u=>u.searchParams.get('wd')===query && /stf=\d+,\d+\|stftype=1/.test(u.searchParams.get('gpc'))));
   });
   await isolateExits(false);
   probe('default_network',1,true);
   const summaryProject=await browserProject(null,{rewrite_count:1});
   const summary=await business(summaryProject,'summary',{query:'summary across two variants'});const summaryRows=await attempts(summary.request_id);
   const searches=summaryRows.filter(c=>c.kind==='search');
   assert.equal(searches.filter(c=>c.browser_job.search_engine==='google').length,0);
   assert.equal(searches.filter(c=>c.browser_job.search_engine==='baidu'&&c.status==='success').length,2);
   assert.equal(new Set(searches.map(c=>c.browser_job.job_id)).size,2);
   assert.ok(searches.every(c=>c.browser_job.engine_selection.reason==='google_cooldown'));
   assert.ok(summaryRows.filter(c=>c.kind==='reader').every(c=>!('engine_fallback' in c.browser_job)&&!('engine_selection' in c.browser_job)));
   const cooled=await business(project,'list',{query:'reuse measured engine failure'});
   const cached=await attempts(cooled.request_id);
   assert.equal(cached.length,1);
   assert.equal(cached[0].browser_job.search_engine,'baidu');
   assert.equal(cached[0].browser_job.engine_selection.reason,'google_cooldown');
   sql("UPDATE browser_engine_health SET retry_at=clock_timestamp()-interval '1 second';");
   const expired=await business(project,'list',{query:'retry after engine cooldown'});
   verifySwitch(await attempts(expired.request_id),'ENDPOINT_RISK_CONTROL');
   sql('DELETE FROM browser_engine_health;');
   server.googleBehavior='delayed';
   const delayed=await business(project,'list',{query:'late but within submitted budget'});const delivered=await attempts(delayed.request_id);
   assert.equal(delivered.length,1);assert.equal(delivered[0].browser_job.search_engine,'google');assert.equal(delivered[0].status,'success');assert.ok(delayed.data.items.length);
   server.googleBehavior='slow';
   const slow=await business(project,'list',{query:'slow initial engine'});const timed=await attempts(slow.request_id);
   check('A23.google_timeout_fallback',()=>{verifySwitch(timed,'UPSTREAM_TIMEOUT');assert.ok(slow.data.items.length);});
   sql('DELETE FROM browser_engine_health;');
   server.googleBehavior='empty';
   const empty=await business(project,'list',{query:'known empty'});const one=await attempts(empty.request_id);
   check('A23.google_empty_terminal',()=>{assert.equal(empty.status,'empty');assert.deepEqual(empty.data.items,[]);assert.equal(one.length,1);assert.equal(one[0].browser_job.search_engine,'google');});
 }finally{delete server.googleBehavior;}
});
