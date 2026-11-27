import {test,before,after} from 'node:test';
import {assert,prove} from './proof.mjs';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {base,upstream,server,cookie,setup,close,admin,endpoint,project,business,recorded,editable,sql,sleep} from './context.mjs';
const require=createRequire(new URL('../../web/package.json',import.meta.url));
const {chromium}=require('playwright-core');
let made,browser,modelBudget;const errors=[];
before(async()=>{await setup();sql('SELECT 1;');modelBudget=await admin('settings/cache-model-budgets');await admin('settings/cache-model-budgets',{expected_version:modelBudget.version,concurrency:2,rpm:100},'PUT');made=await project({cache_enabled:true,search_limit:10,source_limit:2},{search:await endpoint('search','cache'),reader:await endpoint('reader','',{provider:'tavily',base_url:upstream})});});
after(async()=>{await browser?.close();if(modelBudget){const current=await admin('settings/cache-model-budgets');await admin('settings/cache-model-budgets',{expected_version:current.version,concurrency:modelBudget.concurrency,rpm:modelBudget.rpm},'PUT');}close();assert.deepEqual(errors,[]);});
async function eventually(check,timeout=120000){const end=Date.now()+timeout;let value;while(Date.now()<end){value=await check();if(value)return value;await sleep(200);}throw Error('Cache condition did not settle: '+value+' '+sql(`SELECT COALESCE(json_agg(x),'[]') FROM (SELECT kind,state,attempts,last_error FROM cache_jobs WHERE scope='${made.project.id}' AND state IN ('waiting','retry','running')) x;`));}
async function trace(value){await recorded(value.request_id);return admin('requests/'+value.request_id+'/export');}
const active=()=>Number(sql(`SELECT count(*) FROM cache_jobs WHERE scope='${made.project.id}' AND state IN ('waiting','retry','running');`));
const refs=()=>JSON.parse(sql(`SELECT COALESCE(json_agg(json_build_object('text',body->'query'->>'text','total',total)),'[]') FROM cache_registry WHERE scope='${made.project.id}' AND kind='list';`));
test('default-off project keeps ordinary routing; enabled project stores all ten raw hits before display truncation',()=>prove('P02.capture',async()=>{
 const off=await project();assert.equal(off.project.cache_enabled,false);
 const first=await business(made,'list',{query:'plan2-seed-a rainfall',count:2});assert.equal(first.data.items.length,2);
 await eventually(()=>Number(sql(`SELECT count(*) FROM cache_snapshots WHERE scope='${made.project.id}' AND indexed;`))===1);
 assert.equal(Number(sql(`SELECT jsonb_array_length(body->'hits') FROM cache_snapshots WHERE scope='${made.project.id}' LIMIT 1;`)),10);
 // Only the two returned pages are fetch targets. Index/summary jobs are separate.
 await eventually(()=>active()===0);
 assert.equal(Number(sql(`SELECT count(DISTINCT target) FROM cache_jobs WHERE scope='${made.project.id}' AND kind='content';`)),2);
}));
test('one exact logical question reuses its raw list without a real search or another list job',()=>prove('P02.exact',async()=>{
 const before=server.requests.length;
 const value=await business(made,'list',{query:'plan2-seed-a rainfall',count:10});assert.equal(value.data.items.length,10);
 const evidence=await trace(value);assert.equal(evidence.evidence.cache_lookups[0].questions.length,1);assert.equal(evidence.evidence.cache_lookups[0].search_needed,false);
 assert.ok(!evidence.calls.some(c=>c.kind==='search'));
 assert.ok(!server.requests.slice(before).some(r=>r.path==='/search'&&r.method==='POST'));
 assert.ok(value.data.items.some(i=>i.summary));
 await eventually(()=>active()===0);
}));
test('two different high-confidence questions combine candidates and each receives one reference',()=>prove('P02.double',async()=>{
 const second=await business(made,'list',{query:'plan2-seed-b rainfall',count:1});assert.equal(second.data.items.length,1);
 await eventually(()=>Number(sql(`SELECT count(DISTINCT question) FROM cache_snapshots WHERE scope='${made.project.id}' AND indexed;`))===2);
 const before=refs();const merged=await business(made,'list',{query:'plan2-merge rainfall',count:10});
 assert.equal(merged.data.items.length,10);assert.equal(new Set(merged.data.items.map(i=>i.url)).size,10);
 const evidence=await trace(merged);assert.equal(evidence.evidence.cache_lookups[0].questions.length,2);assert.ok(!evidence.calls.some(c=>c.kind==='search'));
 await eventually(()=>refs().filter(r=>r.text.includes('seed-')).every(r=>r.total===before.find(b=>b.text===r.text).total+1));
 const ids=evidence.evidence.variants[0].hits.filter(h=>h.cache);assert.ok(ids.length>0);assert.ok(ids.every(h=>h.call_id===h.cache.call_id));
}));
test('a similar single hit returns cached links and asynchronously searches the original using the internal browser',()=>prove('P02.single',async()=>{
 const value=await business(made,'list',{query:'plan2-single rainfall',count:1});assert.equal(value.data.items.length,1);
 const evidence=await trace(value);assert.equal(evidence.evidence.cache_lookups[0].questions.length,1);assert.equal(evidence.evidence.cache_lookups[0].search_needed,true);
 await eventually(()=>Number(sql(`SELECT count(*) FROM cache_jobs WHERE scope='${made.project.id}' AND kind='list' AND input->'query'->>'text'='plan2-single rainfall' AND state='completed';`))>0);
 assert.ok(server.requests.some(r=>r.method==='GET'&&['/search','/s'].includes(r.path)&&r.request_url.includes('plan2-single')));
}));
test('full foreground bodies publish directly and later content requests avoid another reader call',()=>prove('P02.content',async()=>{
 const url=upstream+'/article?direct-cache=1';
 const value=await business(made,'content',{url});assert.equal(value.status,'success');
 await eventually(()=>Number(sql(`SELECT count(*) FROM cache_pages WHERE scope='${made.project.id}' AND body->>'url'='${url}';`))===1);
 const second=await business(made,'content',{url});const exported=await trace(second);
 assert.ok(!exported.calls.some(c=>c.kind==='reader'));assert.ok(exported.payloads.flatMap(s=>s.replay).some(m=>m.cache));
 assert.ok(second.data.text.includes('Rainfall'));
}));
test('normal synthesis selects two pages without prefetching the other eight',()=>prove('P02.summary',async()=>{
 const p=await project({cache_enabled:true,source_limit:2},{search:await endpoint('search','cache'),reader:await endpoint('reader','',{provider:'tavily',base_url:upstream})});
 const value=await business(p,'summary',{query:'plan2-normal-summary rainfall',source_count:2});assert.equal(value.status,'success');assert.equal(value.data.sources.length,2);
 await recorded(value.request_id);await sleep(2000);
 assert.equal(Number(sql(`SELECT count(*) FROM cache_jobs WHERE scope='${p.project.id}' AND kind='content';`)),0);
}));
test('cache query deadline falls back to project routing when embedding exceeds the two-second budget',()=>prove('P02.budget',async()=>{
 const value=await business(made,'list',{query:'plan2-delay rainfall',count:1});assert.equal(value.data.items.length,1);
 const exported=await trace(value);assert.equal(exported.evidence.cache_lookups[0].bypass,true);
 const span=exported.request.spans.find(s=>s.stage==='cache_lookup');assert.ok(span);assert.ok(span.duration_ms<2200,JSON.stringify(span));
 assert.ok(exported.calls.some(c=>c.kind==='search'));
 const counted=await fetch('http://127.0.0.1:18790/count?query='+encodeURIComponent('plan2-delay rainfall'));
 assert.equal(await counted.json(),1,'slow foreground embedding must not restart during ranking');
 await eventually(()=>Number(sql(`SELECT count(*) FROM cache_snapshots WHERE scope='${made.project.id}' AND body->'query'->>'text'='plan2-delay rainfall' AND indexed;`))===1);
 const recovered=await business(made,'list',{query:'plan2-delay rainfall',count:1});const exact=await trace(recovered);
 assert.equal(exact.evidence.cache_lookups[0].degraded,true);assert.ok(!exact.calls.some(c=>c.kind==='search'));
}));
test('confirmed refusal blocks further foreground and background reads until access configuration changes',()=>prove('P02.refusal',async()=>{
 const reader=await endpoint('reader','cache-guard',{provider:'tavily'});
 const p=await project({cache_enabled:true},{reader});
 const url=upstream+'/article?guarded=1';
 const calls=()=>server.requests.filter(r=>r.mode==='cache-guard'&&r.path==='/extract').length;
 server.refuseCacheRead=true;
 try {
  const before=calls();const denied=await business(p,'content',{url},502);assert.equal(denied.error.code,'ACCESS_DENIED');
  assert.equal(calls(),before+1);
  server.refuseCacheRead=false;
  const repeated=await business(p,'content',{url},502);assert.equal(repeated.error.code,'ACCESS_DENIED');
  assert.equal(calls(),before+1);assert.ok(!(await trace(repeated)).calls.some(c=>c.kind==='reader'));
  assert.equal(Number(sql(`SELECT count(*) FROM cache_jobs WHERE scope='${p.project.id}' AND kind='content';`)),0);
  const replacement=await endpoint('reader','cache-guard',{provider:'tavily'});
  const current=await admin('projects/'+p.project.id);
  await admin('projects/'+current.id,{...editable(current),reader_pools:[[replacement.id]]},'PUT');
  assert.equal((await business(p,'content',{url})).status,'success');
  assert.equal(calls(),before+2);
 } finally {server.refuseCacheRead=false;}
}));

test('regional summary refresh preserves its query identity and actually runs the internal browser',()=>prove('P02.region',async()=>{
 const p=await project({cache_enabled:true,summary_snippets_only:true,source_limit:1},{search:await endpoint('search','cache')});
 const region='Hangzhou',first='plan2-regional guide',next='plan2-regional question';
 await business(p,'summary',{query:first,region,source_count:1});
 await eventually(()=>Number(sql(`SELECT count(*) FROM cache_snapshots WHERE scope='${p.project.id}' AND indexed;`))===1);
 const answer=await business(p,'summary',{query:next,region,source_count:1});
 assert.equal((await trace(answer)).evidence.cache_lookups[0].search_needed,true);
 await eventually(()=>Number(sql(`SELECT count(*) FROM cache_snapshots WHERE scope='${p.project.id}' AND indexed AND body->'query'->>'text'='${next}' AND body->'query'->>'region'='${region}' AND source='00000000-0000-4000-8000-000000000001';`))===1);
 assert.ok(server.requests.some(r=>r.method==='GET'&&['/search','/s'].includes(r.path)&&r.request_url.includes('plan2-regional')));
 await business(p,'list',{query:first,region},400);
}));

test('a failed snapshot write causes a real refresh retry before the task reports completion',()=>prove('P02.retry',async()=>{
 const p=await project({cache_enabled:true},{search:await endpoint('search','cache')});
 const seed='plan2-ack seed',question='plan2-ack retry';
 await business(p,'list',{query:seed,count:1});
 await eventually(()=>Number(sql(`SELECT count(*) FROM cache_snapshots WHERE scope='${p.project.id}' AND indexed;`))===1);
 // PostgreSQL sequences advance outside a failed transaction. Reject exactly
 // the first write for this query in the isolated acceptance database.
 sql(`CREATE SEQUENCE fixture_cache_receipt_attempt;
 CREATE FUNCTION fixture_cache_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
   IF NEW.scope='${p.project.id}' AND NEW.body->'query'->>'text'='${question}' THEN
     IF nextval('fixture_cache_receipt_attempt')=1 THEN RAISE EXCEPTION 'fixture storage unavailable'; END IF;
   END IF;
   RETURN NEW;
 END $$;
 CREATE TRIGGER fixture_cache_receipt BEFORE INSERT ON cache_snapshots FOR EACH ROW EXECUTE FUNCTION fixture_cache_receipt();`);
 try{
  const hit=await business(p,'list',{query:question,count:1});assert.equal((await trace(hit)).evidence.cache_lookups[0].search_needed,true);
  const job=await eventually(()=>JSON.parse(sql(`SELECT COALESCE((SELECT json_build_object('attempts',attempts,'deadline',deadline,'created',created_at,'limit',attempt_limit) FROM cache_jobs WHERE scope='${p.project.id}' AND kind='list' AND state='completed' AND input->'query'->>'text'='${question}' LIMIT 1),'null'::json);`)));
  assert.equal(job.attempts,2);assert.equal(job.limit,3);assert.equal(job.deadline-job.created,1800000);
  const phases=JSON.parse(sql(`SELECT phases FROM cache_jobs WHERE scope='${p.project.id}' AND target=(SELECT question FROM cache_snapshots WHERE scope='${p.project.id}' AND body->'query'->>'text'='${question}') AND kind='list';`));
  assert.ok(phases.some(p=>p.stage==='round_result'&&p.state==='retry'&&p.error));assert.ok(phases.some(p=>p.stage==='material_committed'));

  assert.equal(Number(sql(`SELECT count(*) FROM cache_snapshots WHERE scope='${p.project.id}' AND body->'query'->>'text'='${question}';`)),1);
 }finally{sql('DROP TRIGGER fixture_cache_receipt ON cache_snapshots; DROP FUNCTION fixture_cache_receipt(); DROP SEQUENCE fixture_cache_receipt_attempt;');}
}));

test('removed content can be restored only by a verified browser receipt and then served from cache',()=>prove('P02.gone',async()=>{
 const fallback=await endpoint('reader','gone-fallback',{provider:'tavily'});
 const p=await project({cache_enabled:true,reader_pools:[['00000000-0000-4000-8000-000000000002'],[fallback.id]]});
 const url=upstream+'/cache-recover';server.cacheOriginGone=true;
 try{
  const removed=await business(p,'content',{url},502);
  assert.ok(!(await trace(removed)).calls.some(c=>c.endpoint_id===fallback.id));
  assert.equal(Number(sql(`SELECT count(*) FROM cache_page_states WHERE scope='${p.project.id}' AND status=410;`)),1);
  server.cacheOriginGone=false;
  const verification=await business(p,'content',{url},502);assert.ok(!(await trace(verification)).calls.some(c=>c.kind==='reader'));
  await eventually(()=>Number(sql(`SELECT count(*) FROM cache_jobs WHERE scope='${p.project.id}' AND reason='origin_recovery' AND state='completed';`))===1);
  const restored=await business(p,'content',{url});assert.ok(restored.data.text.includes('Rainfall'));assert.ok(!(await trace(restored)).calls.some(c=>c.kind==='reader'));
 }finally{server.cacheOriginGone=false;}
}));
test('cached exact list retains the original browser cards without another search',()=>prove('P02.provenance',async()=>{
 const p=await project({cache_enabled:true,search_pools:[['00000000-0000-4000-8000-000000000001']]});
 const query='plan2-weather-card-ai-card';
 const initial=await business(p,'list',{query,count:1});assert.ok(initial.data.cards?.length);
 await eventually(()=>Number(sql(`SELECT count(*) FROM cache_snapshots WHERE scope='${p.project.id}' AND indexed;`))===1);
 const hit=await business(p,'list',{query,count:1});
 assert.deepEqual(hit.data.cards,initial.data.cards);assert.ok(!(await trace(hit)).calls.some(c=>c.kind==='search'));
 assert.ok(initial.data.engine_answer?.sources.length);
 const original=(await trace(initial)).evidence.variants[0].result_call_id;
 assert.ok(original);
 const summary=await business(p,'summary',{query,source_count:1});
 const variant=(await trace(summary)).evidence.variants[0];
 for(const url of [initial.data.cards[0].url,initial.data.engine_answer.sources[0].url]){
  const material=variant.hits.find(h=>h.url===url);
  assert.ok(material?.rank>=1);
  assert.equal(material.call_id,original);
  assert.equal(material.cache.lookup_id,variant.cache_lookup_id);
  assert.equal(material.cache.call_id,original);
 }
}));
test('explicit denial from an external reader stops background work and later reads',()=>prove('P02.explicit_denial',async()=>{
 const reader=await endpoint('reader','',{base_url:upstream+'/target-denied'});
 const p=await project({cache_enabled:true},{reader});
 const url=upstream+'/article?explicit-denial=1';
 for(let attempt=0;attempt<2;attempt++){
  const result=await business(p,'content',{url},502);
  assert.equal(result.error.code,'ACCESS_DENIED');
  assert.equal((await trace(result)).calls.filter(c=>c.kind==='reader').length,attempt===0?1:0);
 }
 assert.equal(Number(sql("SELECT count(*) FROM cache_jobs WHERE scope='"+p.project.id+"' AND kind='content'")),0);
}));

test('origin Retry-After longer than the job lifetime expires the initial fill without dispatch',()=>prove('P02.retry_after',async()=>{
 const p=await project({cache_enabled:true,reader_pools:[['00000000-0000-4000-8000-000000000002']]});
 const url=upstream+'/cache-retry-later';
 const start=Date.now();
 const result=await business(p,'content',{url},502);
 assert.ok(result.error.details.retry_after_ms>=3599000);
 const task=JSON.parse(sql("SELECT json_build_object('state',state,'attempts',attempts,'available',available_at,'deadline',deadline) FROM cache_jobs WHERE scope='"+p.project.id+"' AND kind='content'"));
 assert.equal(task.state,'expired');assert.equal(task.attempts,0);
 assert.ok(task.available>=start+3599000 && task.available>task.deadline);
}));

test('explicit dates never reuse a different dated snapshot at identical cosine similarity',()=>prove('P02.dates',async()=>{
 const p=await project({cache_enabled:true},{search:await endpoint('search','cache')});
 const previous='plan2-date rainfall on 2026-11-26';
 await business(p,'list',{query:previous,count:1});
 await eventually(()=>Number(sql("SELECT count(*) FROM cache_snapshots WHERE indexed AND scope='"+p.project.id+"'"))===1);
 const today=await business(p,'list',{query:'plan2-date rainfall on 2026-11-27',count:1});
 const record=await trace(today);
 assert.equal(record.evidence.cache_lookups[0].hit,false);
 assert.ok(record.calls.some(c=>c.kind==='search'));
}));

test('three real queries preserve thirty distinct pages and fetch only the final two sources',()=>prove('P02.three_queries',async()=>{
 for(const snippets of [false,true]){
  const p=await project({cache_enabled:true,rewrite_count:2,source_limit:2,summary_snippets_only:snippets},
    {search:await endpoint('search','cache'),reader:await endpoint('reader','',{provider:'tavily'})});
  const result=await business(p,'summary',{query:'plan2-three rainfall',source_count:2});
  assert.equal(result.data.sources.length,2);
  const exported=await trace(result);
  assert.equal(exported.evidence.variants.length,3);
  assert.equal(exported.evidence.candidates.length,30);
  assert.equal(new Set(exported.evidence.variants.flatMap(v=>v.hits.map(h=>h.url))).size,30);
  await eventually(()=>Number(sql("SELECT count(*) FROM cache_snapshots WHERE scope='"+p.project.id+"' AND jsonb_array_length(body->'hits')=10"))===3);
  const selected=result.data.sources.map(s=>s.url).sort();
  if(snippets){
   assert.equal(exported.calls.filter(c=>c.kind==='reader').length,0);
   const queued=await eventually(()=>{const urls=JSON.parse(sql("SELECT COALESCE(json_agg(DISTINCT input->>'url'),'[]') FROM cache_jobs WHERE kind='content' AND scope='"+p.project.id+"'"));return urls.length===2&&urls;});
   assert.deepEqual(queued.sort(),selected);
  }else{
   assert.equal(exported.calls.filter(c=>c.kind==='reader').length,2);
   assert.equal(Number(sql("SELECT count(*) FROM cache_jobs WHERE kind='content' AND scope='"+p.project.id+"'")),0);
  }
 }
}));

test('v2 verifies material from both recall lanes and respects explicit version evidence',()=>prove('P02.verified_sources',async()=>{
 const p=await project({cache_enabled:true},{search:await endpoint('search','cache')});
 const scope=p.project.id;
 const adminView=await admin('cache/overview');
 assert.equal(adminView.binding.handler,'v2');assert.equal(adminView.matcher.configured,true);
 await business(p,'list',{query:'plan2-proof desktop startup',count:1});
 await eventually(()=>Number(sql("SELECT count(*) FROM cache_snapshots WHERE indexed AND scope='"+scope+"'"))===1);
 const accepted=await trace(await business(p,'list',{query:'verify-weak Ubuntu 13.04',count:1}));
 const match=accepted.evidence.cache_lookups[0];
 assert.equal(match.hit,true);assert.equal(match.search_needed,true);assert.equal(match.verification.state,'verified');
 assert.ok(match.verification.decisions.some(d=>d.label==='reusable'));
 assert.equal(match.query,'verify-weak Ubuntu 13.04');
 assert.equal(accepted.request.spans.find(s=>s.span_id===match.span_id)?.stage,'cache_lookup');
 assert.ok(match.matched_snapshots.some(s=>s.query==='plan2-proof desktop startup' && !s.exact && s.source===p.search.id));
 assert.ok(match.verification.shortlisted_question_ids.some(id=>match.verification.question_texts[id]==='plan2-proof desktop startup'));
 assert.ok(!accepted.calls.some(c=>c.kind==='search'));
 for(const [query,state] of [['verify-weak Ubuntu 14.04','no_candidates'],['explicit-conflict desktop','verified'],['low-score desktop','verified'],['no-calibration desktop','uncalibrated']]){
  const checked=await trace(await business(p,'list',{query,count:1}));
  const found=checked.evidence.cache_lookups[0];
  assert.equal(found.hit,false);assert.equal(found.verification.state,state);assert.ok(checked.calls.some(c=>c.kind==='search'));
  if(state==='uncalibrated'){assert.ok(found.verification.shortlisted_question_ids.length>0);assert.deepEqual(found.verification.decisions,[]);}
 }
}));

test('v2 matcher timeout and unexpected model revision fall back within the shared deadline',()=>prove('P02.matcher_failover',async()=>{
 const p=await project({cache_enabled:true},{search:await endpoint('search','cache')});
 const q='plan2-matcher-slow seed';
 await business(p,'list',{query:q,count:1});
 await business(p,'list',{query:'plan2-matcher other',count:1});
 await eventually(()=>Number(sql("SELECT count(*) FROM cache_snapshots WHERE indexed AND scope='"+p.project.id+"'"))===2);
 const repeated=await trace(await business(p,'list',{query:q,count:1}));
 assert.equal(repeated.evidence.cache_lookups[0].degraded,true);
 assert.ok(!repeated.calls.some(c=>c.kind==='search'));
 for(const query of ['plan2-matcher-slow miss','plan2-profile-mismatch']){
  const result=await trace(await business(p,'list',{query,count:1}));
  assert.equal(result.evidence.cache_lookups[0].bypass,true);
  assert.equal(result.evidence.cache_lookups[0].verification.state,'fallback');
  if(query.includes('mismatch'))assert.equal(result.evidence.cache_lookups[0].verification.reason,'CACHE_MATCHER_PROFILE_MISMATCH');
  assert.ok(result.request.spans.find(s=>s.stage==='cache_lookup').duration_ms<2200);
 }
}));

test('v2 rechecks approved evidence after in-flight inference',()=>prove('P02.verification_fence',async()=>{
 const p=await project({cache_enabled:true},{search:await endpoint('search','cache')});
 await business(p,'list',{query:'plan2-proof fence seed',count:1});
 await eventually(()=>Number(sql("SELECT count(*) FROM cache_snapshots WHERE indexed AND scope='"+p.project.id+"'"))===1);
 const query='plan2-hold-verify fence',control='http://127.0.0.1:18790/matcher-hold?query='+encodeURIComponent(query);
 const pending=business(p,'list',{query,count:1});
 try {
  const until=Date.now()+2500;
  while(!(await (await fetch(control)).json())){if(Date.now()>until)throw Error('matcher did not receive pending request');await sleep(15);}
  sql("UPDATE cache_snapshots SET expires_at=0 WHERE scope='"+p.project.id+"'");
 }finally{await fetch(control,{method:'POST'});}
 const result=await trace(await pending);
 const lookup=result.evidence.cache_lookups[0];assert.equal(lookup.verification.state,'material_changed');assert.equal(lookup.hit,false);
 assert.ok(result.calls.some(c=>c.kind==='search'));
}));

test('policy floor, optimistic versions, concurrency and cache toggle are enforced by the API',()=>prove('P02.policy',async()=>{
 const config=await admin('settings/cache-policy');const changed=await admin('settings/cache-policy',{expected_version:config.version,list:{...config.list,total_hot_percent:0},content:config.content},'PUT');assert.equal(changed.list.total_hot_percent,1);
 await admin('settings/cache-policy',{expected_version:config.version,list:config.list,content:config.content},'PUT',409);
 await admin('settings/cache-policy',{expected_version:changed.version,list:config.list,content:config.content},'PUT');
 const concurrency=await admin('settings/cache-concurrency');await admin('settings/cache-concurrency',{expected_version:concurrency.version,configured_limit:0},'PUT',400);
 assert.ok(concurrency.effective_limit<concurrency.ready_tabs);
 let current=await admin('projects/'+made.project.id);const oldEpoch=current.cache_epoch;
 current=await admin('projects/'+current.id,{...editable(current),cache_enabled:false},'PUT');assert.equal(current.cache_epoch,oldEpoch+1);
 const value=await business(made,'list',{query:'plan2-seed-a rainfall',count:1});const exported=await trace(value);assert.ok(exported.calls.some(c=>c.kind==='search'));assert.ok(!exported.evidence.cache_lookups?.length);
 current=await admin('projects/'+current.id,{...editable(current),cache_enabled:true},'PUT');assert.equal(current.cache_epoch,oldEpoch+2);
 assert.equal(Number(sql(`SELECT count(*) FROM cache_jobs WHERE scope='${current.id}' AND cache_epoch<${current.cache_epoch} AND state IN ('waiting','retry');`)),0);
}));
test('cache overview and the project switch render in Chinese, English, light and dark themes',()=>prove('P02.console',async()=>{
 const uiProject=await project({cache_enabled:true},{search:await endpoint('search','cache')});
 const uiQuery='plan2-proof console result list';
 await business(uiProject,'list',{query:uiQuery,count:1});
 await eventually(()=>Number(sql("SELECT count(*) FROM cache_snapshots WHERE indexed AND scope='"+uiProject.project.id+"'"))===1);
 const cached=await trace(await business(uiProject,'list',{query:uiQuery,count:1}));
 const lookup=cached.evidence.cache_lookups[0];
 const archivedHits=cached.evidence.variants.find(v=>v.cache_lookup_id===lookup.lookup_id).hits;
 assert.ok(lookup.hit && archivedHits.length>1);
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium'].find(existsSync)});
 for(const language of ['zh','en'])for(const theme of ['light','dark']){
  const en=language==='en';const context=await browser.newContext({viewport:{width:1440,height:1100},colorScheme:theme,reducedMotion:'reduce'});
  try{
   await context.addCookies([{name:'oas_admin_session',value:cookie.slice(cookie.indexOf('=')+1),url:base,httpOnly:true,sameSite:'Strict'}]);
   await context.addInitScript(({language,theme})=>{localStorage.setItem('oas-language',language);localStorage.setItem('oas-theme',theme);},{language,theme});
   const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
   await page.goto(base+'/cache');await page.getByRole('heading',{name:en?'Cache management':'缓存管理',exact:true}).waitFor();await page.getByText(en?'Usable snapshots':'有效快照',{exact:true}).waitFor();
   const controls=page.locator('.cache-filter-grid .select__trigger, .cache-filter-grid .time-window');
   assert.equal(await controls.count(),4);
   const bounds=await controls.evaluateAll(nodes=>nodes.map(n=>{const box=n.getBoundingClientRect();return [box.top,box.bottom];}));
   for(const [top,bottom] of bounds){assert.ok(Math.abs(top-bounds[0][0])<=1);assert.ok(Math.abs(bottom-bounds[0][1])<=1);}
   if(en && theme==='light'){
    const refreshBounds=async()=>{
     const observed=page.waitForRequest(r=>new URL(r.url()).pathname==='/admin/v1/cache/overview');
     await page.getByRole('button',{name:'Refresh',exact:true}).click();
     const params=new URL((await observed).url()).searchParams;
     return [Number(params.get('since')),Number(params.get('until'))];
    };
    const before=await refreshBounds();await page.waitForTimeout(100);const after=await refreshBounds();
    assert.ok(after[1]>before[1]);assert.equal(after[1]-after[0],86400000);
    await page.getByRole('button',{name:'Background model budget',exact:true}).click();
    const editor=page.getByRole('dialog');
    await editor.getByRole('spinbutton',{name:'Background concurrency per endpoint'}).fill('3');
    const previous=await admin('settings/cache-model-budgets');
    await admin('settings/cache-model-budgets',{expected_version:previous.version,concurrency:previous.concurrency,rpm:previous.rpm+1},'PUT');
    const refetched=page.waitForResponse(r=>r.request().method()==='GET'&&r.url().endsWith('/settings/cache-model-budgets'));
    await page.evaluate(()=>window.dispatchEvent(new Event('visibilitychange')));
    await refetched;
    const conflict=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/settings/cache-model-budgets'));
    await editor.getByRole('button',{name:'Save',exact:true}).click();assert.equal((await conflict).status(),409);
    await editor.getByRole('button',{name:'Reload latest settings'}).click();
    assert.equal((await admin('settings/cache-model-budgets')).rpm,previous.rpm+1);
    await editor.getByRole('button',{name:'Close',exact:true}).last().click();
    const fixed=new URL('/cache',base);fixed.searchParams.set('from',new Date(before[0]).toISOString());fixed.searchParams.set('to',new Date(before[1]).toISOString());
    await page.goto(fixed.toString());await page.getByText('Usable snapshots',{exact:true}).waitFor();
    assert.deepEqual(await refreshBounds(),before);
   }
   await page.screenshot({path:'artifacts/cache-'+language+'-'+theme+'.png',fullPage:true});
   if(theme==='light'){
    await page.setViewportSize({width:390,height:850});
    const grid=page.locator('.cache-filter-grid');
    assert.ok(await grid.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
    await page.setViewportSize({width:1440,height:1100});
   }
   await page.goto(base+'/requests/'+cached.request.metadata.request_id+'?tab=execution&stage='+lookup.span_id);
   const stage=page.locator('.cache-stage');
   await stage.getByText(en?'Exact cache hit':'精确命中',{exact:true}).waitFor();
   await stage.locator('.hit').first().waitFor();
   assert.equal(await stage.locator('.hit').count(),archivedHits.length);
   assert.ok((await stage.locator('.hit').first().innerText()).includes(archivedHits[0].title));
   assert.ok((await stage.locator('.hit').first().innerText()).includes(archivedHits[0].snippet));
   assert.ok((await stage.locator('.cache-source-list').innerText()).includes(uiProject.search.name));
   assert.ok(!(await stage.innerText()).includes(lookup.snapshot_ids[0]));
   assert.ok(await stage.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
   await page.goto(base+'/cache');
   await page.getByRole('button',{name:en?'Background concurrency':'调整后台并发',exact:true}).click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');
   await page.goto(base+'/projects');await page.getByRole('button',{name:en?'Create':'新建',exact:true}).click();
   const toggle=page.getByRole('dialog').getByRole('switch',{name:en?'Enable search cache':'启用搜索缓存',exact:true});assert.equal(await toggle.isChecked(),false);await page.getByRole('dialog').getByText(en?'Enable search cache':'启用搜索缓存',{exact:true}).click();assert.equal(await toggle.isChecked(),true);
   await toggle.focus();await page.keyboard.press('Space');assert.equal(await toggle.isChecked(),false);
   await page.getByRole('dialog').getByText(en?'Enable search cache':'启用搜索缓存',{exact:true}).click();
   const name='Cache UI '+language+' '+theme;
   const dialog=page.getByRole('dialog');await dialog.getByLabel(en?'Name':'名称',{exact:true}).fill(name);
   const created=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/admin/v1/projects');
   await dialog.getByRole('button',{name:en?'Save':'保存',exact:true}).click();const creation=await created;assert.equal(creation.status(),201);
   const saved=(await creation.json()).data.project;assert.equal(saved.cache_enabled,true);
   await page.getByRole('heading',{name:en?'Save project key':'保存项目密钥',exact:true}).waitFor();
   await page.getByRole('dialog').getByRole('button',{name:en?'Close':'关闭',exact:true}).last().click();
   await page.getByLabel(en?'Find by name':'按名称查找',{exact:true}).fill(name);
   await page.locator('.project-card').filter({hasText:name}).getByRole('button',{name:en?'Edit':'编辑',exact:true}).click();assert.equal(await toggle.isChecked(),true);
   await dialog.getByText(en?'Enable search cache':'启用搜索缓存',{exact:true}).click();
   const updated=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname==='/admin/v1/projects/'+saved.id);
   await dialog.getByRole('button',{name:en?'Save':'保存',exact:true}).click();assert.equal((await updated).status(),200);assert.equal((await admin('projects/'+saved.id)).cache_enabled,false);
   assert.ok(await page.locator('body').evaluate(el=>el.scrollWidth<=window.innerWidth+1));
  }finally{await context.close();}
 }
}));
