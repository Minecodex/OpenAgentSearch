import {parseModelPrompt} from '../prompt-fixture.mjs';
import {test,before,after} from 'node:test';
import {assert,check,prove} from './proof.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../web/package.json',import.meta.url));
import {base,upstream,server,cookie,csrf,setup,close,admin,endpoint,project,business,recorded,q,sql,sleep,blockDiagnostics,editable} from './context.mjs';
before(setup);after(close);

test('all-irrelevant known passages return empty while preserving the original model explanation',async()=>{
 const made=await project({}, {model:await endpoint('model','no-evidence-explanation')});
 const result=await business(made,'summary',{query:'rainfall'});assert.equal(result.status,'empty');await recorded(result.request_id);
 const trace=await admin('requests/'+result.request_id+'/export'),span=trace.payloads.find(payload=>payload.span.stage==='synthesis');
 assert.equal(span.output.summary,'');assert.equal(span.diagnostics.normalization,'no_relevant_passages');
 assert.ok(span.replay[0].model_output.choices[0].message.content.includes('There is no relevant evidence'));
 assert.equal(trace.calls.filter(call=>call.stage==='synthesis').length,1);
});

test('a rewrite echo is recorded as unusable fallback and an excluded original is never silently searched',async()=>{
 const model=await endpoint('model','duplicate-rewrite');
 const made=await project({rewrite_count:1},{model});
 const value=await business(made,'summary',{query:'rainfall',region:'Shanghai',current_time:'2026-05-01T00:30:00+08:00'});await recorded(value.request_id);
 assert.equal(value.status,'partial');assert.ok(value.warnings.some(w=>w.code==='query_rewrite_fallback'));
 assert.ok(!value.warnings.some(w=>w.code==='source_incomplete'));
 const exported=await admin('requests/'+value.request_id+'/export'),span=exported.payloads.find(p=>p.span.stage==='rewrite');
 assert.equal(span.span.status,'partial');assert.equal(span.diagnostics.rewrite.used,0);assert.equal(span.diagnostics.rewrite.state,'fallback');
 assert.equal(span.diagnostics.rewrite.entries[0].state,'duplicate_original');assert.equal(span.diagnostics.rewrite.entries[0].variant_id,undefined);
 assert.deepEqual(exported.evidence.variants.map(v=>v.variant_id),['Q0']);
 assert.equal(exported.calls.find(call=>call.stage==='rewrite').status,'success');
 const disabled=await project({rewrite_count:1,search_original_query:false},{model});
 const failed=await business(disabled,'summary',{query:'rainfall'},502);assert.equal(failed.error.code,'QUERY_REWRITE_FAILED');await recorded(failed.request_id);
 assert.ok((await admin('endpoint-calls?request_id='+failed.request_id)).items.every(call=>call.kind==='model'));
});

test('project original-query switch persists, preserves Q1 identities and never falls back to an excluded question',async()=>{
 const invalid=await fetch(base+'/admin/v1/projects',{method:'POST',headers:{Cookie:cookie,Origin:base,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({name:'Invalid query policy',search_pools:[],reader_pools:[],rewrite_count:0,search_original_query:false})});
 assert.equal(invalid.status,400);assert.equal((await invalid.json()).error.details.field,'rewrite_count');
 const made=await project({rewrite_count:1,search_original_query:false});
 assert.equal((await admin('projects/'+made.project.id)).search_original_query,false);
 const result=await business(made,'summary',{query:'rainfall'});await recorded(result.request_id);
 const trace=await admin('requests/'+result.request_id+'/export');
 assert.equal(trace.request.snapshot.project.search_original_query,false);
 assert.deepEqual(trace.evidence.variants.map(v=>v.variant_id),['Q1']);
 assert.ok(trace.evidence.variants.every(v=>v.query!=='rainfall'));
 const list=await business(made,'list',{query:'rainfall'});await recorded(list.request_id);
 const listed=await admin('requests/'+list.request_id+'/export');
 assert.deepEqual(listed.evidence.variants.map(v=>[v.variant_id,v.query]),[['Q0','rainfall']]);
 const broken=await project({rewrite_count:1,search_original_query:false},{model:await endpoint('model','rewrite-failed')});
 const failed=await business(broken,'summary',{query:'rainfall'},502);assert.equal(failed.error.code,'QUERY_REWRITE_FAILED');
 await recorded(failed.request_id);assert.ok((await admin('endpoint-calls?request_id='+failed.request_id)).items.every(c=>c.kind==='model'));
});

test('A01 strict public contract subitems',async()=>{
 const made=await project();check('A01.only_three',()=>{const spec=require('yaml').parse(require('node:fs').readFileSync('docs/plan1/contracts/business.openapi.yaml','utf8'));assert.deepEqual(Object.keys(spec.paths).sort(),['/v1/search/content','/v1/search/list','/v1/search/summary']);});for(const op of ['list','content','summary']){
  const input=op==='content'?{url:upstream+'/article'}:{query:'rainfall'};
  for(const language of ['en','zh'])await prove(`A01.auth.${op}.${language}`,async()=>{const bad=await business({...made,api_key:'wrong'},op,input,401,{'Accept-Language':language});assert.equal(bad.error.code,'UNAUTHORIZED');assert.match(bad.error.message,language==='zh'?/[\u3400-\u9fff]/:/[a-zA-Z]/);});
  await prove('A01.unknown.'+op,async()=>{const r=await business(made,op,{...input,unknown:true},400);assert.equal(r.error.code,'INVALID_ARGUMENT');});
  await prove('A01.duplicate.'+op,async()=>{const key=op==='content'?'url':'query';const r=await business(made,op,`{"${key}":"a","${key}":"b"}`,400);assert.equal(r.error.code,'INVALID_ARGUMENT');});
  await prove('A01.large.'+op,async()=>{const r=await business(made,op,{...input,unknown:'x'.repeat(70000)},413);assert.equal(r.status,'error');});
 }
 await prove('A01.blank',async()=>{for(const query of ['','  \t\n'])await business(made,'list',{query},400);});
 await prove('A01.integer',async()=>{await business(made,'list','{"query":"rain","count":1.0}',400);});
});

test('A02 concurrent version writes, key rotation and an already admitted immutable project snapshot',async()=>{
 const made=await project(),draft=editable(made.project);
 const writes=await Promise.all(['First','Second'].map(name=>fetch(base+'/admin/v1/projects/'+made.project.id,{method:'PUT',headers:{Cookie:cookie,Origin:base,'X-CSRF-Token':(awaitableCsrf()),'Content-Type':'application/json'},body:JSON.stringify({...draft,name})})));
 check('A02.concurrent_write',()=>assert.deepEqual(writes.map(r=>r.status).sort(),[200,409]));
 const current=await admin('projects/'+made.project.id);const rotated=await admin('projects/'+made.project.id+'/key',{expected_version:current.version});
 await prove('A02.rotate_key',async()=>{await business(made,'list',{query:'rain'},401);await business({...made,api_key:rotated.api_key},'list',{query:'rain'});});
 const slow=await endpoint('search','',{base_url:upstream+'/slow'}),p=await project({}, {search:slow});const id=crypto.randomUUID();
 const running=business(p,'list',{query:'rain'},200,{'X-Request-ID':id});
 for(let n=0;n<100;n++){const response=await fetch(base+'/admin/v1/requests/'+id,{headers:{Cookie:cookie}});if(response.ok)break;await sleep(10);}
 await sleep(60);const before=await admin('projects/'+p.project.id);await admin('projects/'+p.project.id,{...editable(before),name:'Changed during request',search_pools:[]},'PUT');
 const result=await running,detail=await recorded(result.request_id);assert.equal(detail.config_version,1);assert.equal(detail.snapshot.project.name,'Acceptance project');assert.ok(result.data.items.length);check('A02.immutable_snapshot',()=>{assert.equal(detail.config_version,1);assert.equal(detail.snapshot.project.name,'Acceptance project');});
});

// Keep credentials in the common authenticated client rather than duplicating
// the login flow for a concurrency test.
import {csrf as commonCsrf} from './context.mjs';
const awaitableCsrf=()=>commonCsrf;

test('A03 list results deduplicate stably, tolerate a missing title, and distinguish valid empty from malformed and failed upstreams',async()=>{
 for(const[mode,status,length]of [['duplicate','success',2],['missing-title','success',1],['empty','empty',0],['mixed','partial',1]]){
  const made=await project({}, {search:await endpoint('search',mode)}),result=await business(made,'list',{query:'rain'});assert.equal(result.status,status);assert.equal(result.data.items.length,length);
  check(({duplicate:'A03.dedup','missing-title':'A03.missing_title',empty:'A03.legal_empty',mixed:'A03.partial'})[mode],()=>{assert.equal(result.status,status);assert.equal(result.data.items.length,length);if(mode==='missing-title')assert.equal(result.data.items[0].title,'');});await recorded(result.request_id);const calls=await admin('endpoint-calls?request_id='+result.request_id);check('A03.no_model',()=>assert.equal(calls.items.filter(c=>c.kind==='model').length,0));
 }
 for(const mode of ['malformed']){const made=await project({}, {search:await endpoint('search',mode)});await prove('A03.malformed',async()=>{await business(made,'list',{query:'rain'},502);});}
 const failed=await project();await prove('A03.upstream_error',async()=>{await business(failed,'list',{query:'upstream-failure'},502);});
});

test('A04 one URL returns matching Markdown and text, Unicode lengths and only a confirmed final URL',async()=>{
 for(const mode of ['', 'final']){const made=await project({}, {reader:await endpoint('reader',mode)});const result=await business(made,'content',{url:upstream+'/article'});assert.ok(result.data.markdown.includes('|'));assert.ok(result.data.markdown.includes('```'));assert.ok(result.data.text.includes('雨量计'));assert.ok(!result.data.text.includes('```'));assert.equal(result.data.url,upstream+'/article');assert.equal('final_url'in result.data,mode==='final');assert.equal(Array.from(result.data.text).length,result.data.lengths.text.retained);await recorded(result.request_id);const calls=await admin('endpoint-calls?request_id='+result.request_id);check('A04.no_search_model',()=>assert.deepEqual(calls.items.map(c=>c.kind),['reader']));check('A04.one_url',()=>assert.equal(result.data.url,upstream+'/article'));check('A04.dual_formats',()=>{assert.ok(result.data.markdown.includes('|'));assert.ok(result.data.markdown.includes('```'));assert.ok(!result.data.text.includes('```'));});check('A04.unicode',()=>assert.ok(result.data.text.includes('雨量计')&&result.data.text.includes('🙂')));check('A04.lengths',()=>{assert.equal(Array.from(result.data.text).length,result.data.lengths.text.retained);assert.equal(Array.from(result.data.markdown).length,result.data.lengths.markdown.retained);});check('A04.confirmed_final',()=>assert.equal('final_url'in result.data,mode==='final'));}
});

test('A05 extraction truncates by semantic blocks and rejects empty, login, unsafe and unreachable targets',async()=>{
 const made=await project({}, {reader:await endpoint('reader','long')});const result=await business(made,'content',{url:upstream+'/article',max_chars:200});assert.equal(result.data.truncated,true);assert.ok(Array.from(result.data.text).length<=200);assert.ok(Array.from(result.data.markdown).length<=200);check('A05.truncation',()=>{assert.ok(result.data.truncated);assert.ok(Array.from(result.data.text).length<=200);assert.ok(Array.from(result.data.markdown).length<=200);assert.ok(result.data.lengths.text.original>result.data.lengths.text.retained);});
 const escaped=await project({}, {reader:await endpoint('reader','escaped')});await prove('A05.minimum_limit',async()=>{await business(escaped,'content',{url:upstream+'/article',max_chars:1},400);});
 for(const mode of ['emptycontent','login']){const p=await project({}, {reader:await endpoint('reader',mode)});await business(p,'content',{url:upstream+'/article'},502);const tested=await admin('endpoints/'+p.reader.id+'/test',{});assert.equal(tested.status,'error');const trace=await admin('requests/'+tested.trace_request_id+'/export');check(mode==='login'?'A05.login':'A05.empty_article',()=>{assert.equal(tested.status,'error');assert.ok(trace.calls.every(c=>c.status==='error'));});if(mode==='login')assert.ok(trace.payloads.flatMap(s=>s.replay).some(m=>m.state==='incomplete'));}
 const denied=await business(made,'content',{url:'http://127.0.0.1/secrets'},400);await recorded(denied.request_id);await prove('A05.unsafe_input',async()=>{assert.equal(denied.error.code,'URL_NOT_ALLOWED');assert.equal((await admin('endpoint-calls?request_id='+denied.request_id)).items.length,0);});
});

test('A06 duplicate hits keep stable ranks, invalid scoring IDs are corrected once and all irrelevant is a legal empty answer',async()=>{
 for(const mode of ['invalid-score','tied']){
  const made=await project({source_limit:2,rewrite_count:1}, {search:await endpoint('search',mode),model:await endpoint('model',mode)}),result=await business(made,'summary',{query:'rain'});assert.equal(result.data.sources.length,2);assert.equal(result.data.sources[0].url,upstream+'/article');const detail=await recorded(result.request_id);const evidence=await admin('requests/'+result.request_id+'/evidence');assert.equal(evidence.candidates.length,2);assert.ok(evidence.candidates[0].hits.length>=2);assert.ok(evidence.candidates.every(c=>c.relevant&&c.score_call_id));check('A06.variant_merge',()=>{assert.equal(evidence.variants.length,2);assert.equal(evidence.candidates.length,2);assert.ok(evidence.candidates[0].hits.some(h=>h.variant_id==='Q1'));});if(mode==='tied')check('A06.stable_ties',()=>assert.equal(result.data.sources[0].url,upstream+'/article'));check('A06.invalid_ids',()=>assert.ok(evidence.candidates.every(c=>c.relevant&&c.score_call_id&&c.candidate_id!=='unknown')));assert.equal(detail.execution_summary.score_batches.length,1);
  const calls=await admin('endpoint-calls?request_id='+result.request_id);check('A06.correction_once',()=>assert.equal(calls.items.filter(c=>c.stage==='score').length,mode==='invalid-score'?2:1));
 }
 const made=await project({}, {model:await endpoint('model','irrelevant')});const result=await business(made,'summary',{query:'rain'});assert.equal(result.status,'empty');check('A06.all_irrelevant',()=>{assert.equal(result.status,'empty');assert.deepEqual(result.data.citations,[]);});
});

test('A07 long CJK passages obey exact model budgets, cap segment count, preserve partial evidence and reject invented citations',async()=>{
 const model=await endpoint('model','verbose-segments',{options:{model:'fixture',tokenizer:'cl100k_base',max_input_tokens:1536,max_output_tokens:2048}});
 const made=await project({source_limit:2,body_limit:200000},{model,search:await endpoint('search','duplicate'),reader:await endpoint('reader','long')});
 const result=await business(made,'summary',{query:'rainfall'});assert.ok(['success','partial'].includes(result.status));await recorded(result.request_id);const evidence=await admin('requests/'+result.request_id+'/evidence');assert.ok(evidence.segments.length>2);check('A07.long_passages',()=>assert.ok(evidence.segments.length>2));check('A07.segment_cap',()=>assert.ok(evidence.segments.length<=32));check('A07.stable_order',()=>{assert.deepEqual(result.data.sources.map(s=>s.id),['s1','s2']);for(const source of result.data.sources){const ids=source.segments.map(s=>Number(s.id.slice(1)));assert.deepEqual(ids,[...ids].sort((a,b)=>a-b));}});assert.ok(result.data.citations.every(c=>evidence.segments.some(s=>s.source_id===c.source_id&&s.segment_id===c.segment_id)));
 const calls=await admin('endpoint-calls?request_id='+result.request_id+'&limit=100');check('A07.exact_tokens',()=>assert.ok(calls.items.filter(c=>c.kind==='model').every(c=>c.estimated_input_tokens<=1536)));const exported=await admin('requests/'+result.request_id+'/export');check('A07.compression_bound',()=>{const compressed=exported.payloads.filter(s=>s.span.stage==='compress');assert.ok(compressed.length>0);assert.ok(compressed.every(s=>s.input.round>=1&&s.input.round<=2));});
 const partial=await project({source_limit:2,body_limit:900},{search:await endpoint('search','partial-segment'),reader:await endpoint('reader','long'),model:await endpoint('model','partial-segment',{options:{model:'fixture',tokenizer:'cl100k_base',max_input_tokens:1536,max_output_tokens:512}})});const partialResult=await business(partial,'summary',{query:'rain'});check('A07.partial_passages',()=>assert.equal(partialResult.status,'partial'));check('A07.short_passage',()=>assert.equal(partialResult.data.sources[0].segments.length,1));
 const invalid=await project({}, {model:await endpoint('model','invalid-citation')});const bad=await business(invalid,'summary',{query:'rain'},502);await recorded(bad.request_id);const exchange=await admin('requests/'+bad.request_id+'/export');check('A07.invalid_citation',()=>assert.equal(bad.error.code,'MODEL_FAILED'));check('A07.format_retry_once',()=>assert.equal(exchange.calls.filter(c=>c.stage==='synthesis').length,2));assert.ok(exchange.payloads.flatMap(s=>s.replay).filter(m=>m.task==='synthesis').every(m=>m.model_output.choices));
});

test('A12 separate project keys produce distinct requests, endpoint ownership, source attribution and configuration versions',async()=>{
 const a=await project({name:'Project A'}),b=await project({name:'Project B'});const results=await Promise.all([a,b].map(m=>business(m,'summary',{query:'rain'})));check('A12.distinct_ids',()=>assert.notEqual(results[0].request_id,results[1].request_id));
 for(const[i,made]of [a,b].entries()){const result=results[i],detail=await recorded(result.request_id),calls=await admin('endpoint-calls?request_id='+result.request_id);assert.equal(detail.metadata.project_id,made.project.id);assert.ok(calls.items.every(c=>c.project_id===made.project.id));check('A12.project_calls',()=>assert.ok(calls.items.every(c=>c.project_id===made.project.id)&&calls.items.some(c=>c.endpoint_id===made.search.id)));check('A12.snapshot_version',()=>{assert.equal(detail.config_version,1);assert.equal(detail.snapshot.project.id,made.project.id);});check('A12.scoped_citations',()=>assert.ok(result.data.citations.every(c=>result.data.sources.some(s=>s.id===c.source_id&&s.segments.some(s=>s.id===c.segment_id)))));}
});

test('A17 all rewrite context combinations, original offsets, invalid times and zero rewriting are independently enforced',async()=>{
 const made=await project({rewrite_count:1});
 for(const context of [{},{region:'Shanghai'},{current_time:'2026-05-01T00:30:00+08:00'},{region:'Shanghai',current_time:'2026-05-01T00:30:00+08:00'},{current_time:'2026-04-30T16:30:00Z'}]){
  const result=await business(made,'summary',{query:'rainfall nearby today',...context});await recorded(result.request_id);
  const exported=await admin('requests/'+result.request_id+'/export'),material=exported.payloads.flatMap(s=>s.replay).find(m=>m.task==='rewrite');assert.ok(material);
  const system=material.model_input.messages[0].content,input=parseModelPrompt(material.model_input.messages);
  const verify=()=>{
   assert.equal(material.model_input.messages[1].content,'rainfall nearby today');assert.ok(system.includes('不能原样返回原问题'));
   assert.equal('region' in input,'region' in context);assert.equal('current_time' in input,'current_time' in context);
   if(!context.current_time){assert.match(input.local_time,/^\d{4}-\d\d-\d\dT/);assert.ok(system.includes('服务在请求开始时固定'));}
   for(const[k,v]of Object.entries(context))assert.equal(input[k],v);
  };verify();check('A17.context.'+(context.region?(context.current_time?'both':'region'):(context.current_time?'time':'none')),verify);
  if(context.current_time)check('A17.midnight_offset',()=>{assert.equal(input.current_time,context.current_time);const reply=JSON.parse(material.model_output.choices[0].message.content);assert.ok(reply.queries[0].includes(context.current_time.slice(0,10)));assert.equal(Date.parse('2026-05-01T00:30:00+08:00'),Date.parse('2026-04-30T16:30:00Z'));});
 }
 for(const current_time of ['2026-02-30T00:00:00Z','2026-05-01T00:30:00','invalid']){const result=await business(made,'summary',{query:'rain',current_time},400);check(current_time.includes('2026-05-01')?'A17.offset_required':'A17.invalid_date',()=>assert.equal(result.error.details.field,'current_time'));}
 const disabled=await project({rewrite_count:0});const result=await business(disabled,'summary',{query:'rain',region:'Shanghai',current_time:'2026-05-01T00:30:00+08:00'});await recorded(result.request_id);await prove('A17.rewrite_disabled',async()=>assert.equal((await admin('endpoint-calls?request_id='+result.request_id)).items.filter(c=>c.stage==='rewrite').length,0));
});

test('A18 edited endpoint secrets and original test versions are isolated from stale receipts and project pool order',async()=>{
 const e=await endpoint('search','',{base_url:upstream+'/slow'});const running=admin('endpoints/'+e.id+'/test',{});await sleep(100);const changed=await admin('endpoints/'+e.id,{...editable(e),name:'Changed endpoint',secret_action:'replace',secret:{api_key:'acceptance-secret-value'}},'PUT');const receipt=await running;assert.equal(receipt.resource_version,1);await recorded(receipt.trace_request_id);assert.ok((await admin('endpoint-calls?request_id='+receipt.trace_request_id)).items.every(c=>c.project_id===null));const latest=await admin('endpoints/'+e.id);assert.equal(latest.version,changed.version);check('A18.test_version',()=>{assert.equal(receipt.resource_version,1);assert.equal(latest.version,changed.version);assert.equal(latest.last_test,null);});assert.equal(latest.has_secret,true);assert.ok(!JSON.stringify(latest).includes('acceptance-secret-value'));
 await admin('endpoints/'+e.id,{...editable(changed),secret_action:'clear'},'PUT');await prove('A18.credential_actions',async()=>{assert.equal(changed.has_secret,true);assert.equal((await admin('endpoints/'+e.id)).has_secret,false);const again=await admin('endpoints/'+e.id);const kept=await admin('endpoints/'+e.id,{...editable(again),secret_action:'keep'},'PUT');assert.equal(kept.has_secret,false);});
 const made=await project();const result=await business(made,'summary',{query:'rain '+made.api_key});await recorded(result.request_id);assert.ok(!JSON.stringify(await admin('requests/'+result.request_id+'/export')).includes(made.api_key));
});

test('A19 snippet fallback, absent material and explicit target denial remain distinguishable with verifiable original ranges',async()=>{
 const unavailable=await endpoint('reader','emptycontent');const made=await project({allow_snippets:true},{reader:unavailable});const result=await business(made,'summary',{query:'rain'});assert.equal(result.status,'partial');assert.equal(result.data.sources[0].kind,'snippet');await recorded(result.request_id);const exported=await admin('requests/'+result.request_id+'/export');const c=exported.evidence.candidates[0],s=exported.evidence.segments[0],m=exported.payloads.flatMap(s=>s.replay).find(m=>m.source_id===s.source_id&&m.state==='complete');assert.equal(c.material,'snippet');check('A19.snippet_fallback',()=>{assert.equal(result.status,'partial');assert.equal(c.material,'snippet');assert.equal(result.data.sources[0].kind,'snippet');});check('A19.unicode_ranges',()=>assert.equal(Array.from(m.text).slice(s.start_char,s.end_char).join(''),s.text_preview));check('A19.citation_scope',()=>assert.ok(result.data.citations.every(c=>exported.evidence.segments.some(s=>s.source_id===c.source_id&&s.segment_id===c.segment_id))));
 const noFallback=await project({allow_snippets:false},{reader:unavailable});await prove('A19.missing_material',async()=>{const missing=await business(noFallback,'summary',{query:'rain'},502);await recorded(missing.request_id);const value=await admin('requests/'+missing.request_id+'/evidence');assert.ok(value.candidates.every(c=>c.material==null));});
 const deniedReader=await endpoint('reader','',{base_url:upstream+'/target-denied'}),denied=await project({allow_snippets:true},{reader:deniedReader});await prove('A19.unsafe_no_snippet',async()=>{const value=await business(denied,'summary',{query:'rain'},502);assert.equal(value.error.code,'ACCESS_DENIED');});
});

test('A13 diagnostic backpressure drops only observations and database keyset cursors bind their filters',async()=>{
 const made=await project();const before=await admin('diagnostics');const blocked=blockDiagnostics(4);await sleep(350);
 const results=await Promise.all(Array.from({length:20},(_,index)=>business(made,'list',{query:'rain '+index})));check('A13.queue_business_independent',()=>assert.ok(results.every(r=>r.status==='success')));await blocked;await sleep(350);
 const after=await admin('diagnostics');check('A13.drop_counter',()=>assert.ok(after.diagnostics.dropped>before.diagnostics.dropped));assert.equal(after.scheduler.active_requests,0);assert.ok(Object.values(after.scheduler.active_leases).every(n=>n===0));
 const query='endpoint-calls?'+q({project_id:made.project.id,limit:'1'}),page=await admin(query);assert.ok(page.next_cursor);const next=await admin(query+'&cursor='+page.next_cursor);assert.notEqual(page.items[0].call_id,next.items[0].call_id);await admin(query+'&language=zh&cursor='+page.next_cursor,undefined,'GET',400);
 await prove('A13.unknown_ratio',async()=>{const value=await admin('endpoint-statistics?'+q({project_id:made.project.id,from:'2001-01-01T00:00:00Z',to:'2001-01-02T00:00:00Z'}));assert.equal(value.overview.p95_ms,null);assert.equal(value.overview.quality_denominator,0);});
});

test('A15 reproducible mixed workload reports latency, errors, queueing, usage, evidence coverage and model replacement quality',async()=>{
 const made=await project();const results=[];
 for(const modelName of ['fixture','fixture-alternate']){
  if(modelName!==made.model.options.model){const current=await admin('endpoints/'+made.model.id);made.model=await admin('endpoints/'+made.model.id,{...editable(current),options:{...current.options,model:modelName}},'PUT');}
  const round=[];
  for(let offset=0;offset<18;offset+=6)await Promise.all(Array.from({length:6},async(_,j)=>{const i=offset+j,op=['list','content','summary'][i%3],language=i%2?'en':'zh',started=performance.now();const result=await business(made,op,op==='content'?{url:upstream+'/article'}:{query:'rainfall measurement',language});const ms=performance.now()-started;await recorded(result.request_id);round.push({result,op,language,ms});}));
  let upstreamCalls=0,queued=0,input=0,output=0,citations=0,valid=0,sources=0,covered=0;const failures=[];
  for(const row of round){await recorded(row.result.request_id);const exported=await admin('requests/'+row.result.request_id+'/export');upstreamCalls+=exported.calls.length;queued+=exported.calls.reduce((n,c)=>n+c.queue_ms,0);input+=exported.calls.reduce((n,c)=>n+(c.input_tokens||0),0);output+=exported.calls.reduce((n,c)=>n+(c.output_tokens||0),0);if(row.op==='summary'){
   const data=row.result.data;citations+=data.citations.length;valid+=data.citations.filter(c=>exported.evidence.segments.some(s=>s.source_id===c.source_id&&s.segment_id===c.segment_id)).length;sources+=data.sources.length;covered+=data.sources.filter(s=>exported.payloads.flatMap(p=>p.replay).some(m=>m.source_id===s.id&&m.text)).length;
   if(!(row.language==='zh'?/雨量计.*毫米/.test(data.summary):/rain.*millimetres/i.test(data.summary)))failures.push('language or fact');if(data.summary.includes('2027'))failures.push('unsupported time');
  }}
  const times=round.map(r=>r.ms).sort((a,b)=>a-b);const report={model:modelName,input_query_chars:20,concurrency:6,requests:round.length,p50_ms:times[Math.ceil(times.length*.5)-1],p95_ms:times[Math.ceil(times.length*.95)-1],error_rate:round.filter(r=>r.result.error).length/round.length,upstream_calls:upstreamCalls,queue_ms:queued,input_tokens:input,output_tokens:output,citation_validity:valid/citations,material_coverage:covered/sources,quality_failures:failures,quality_basis:'deterministic protocol fixtures; fixed rainfall fact, target language, no invented date and exact citation ranges'};
  assert.equal(report.error_rate,0);assert.equal(report.citation_validity,1);assert.equal(report.material_coverage,1);assert.deepEqual(failures,[]);assert.ok(input>0&&output>0);check('A15.mixed_load',()=>{assert.equal(round.length,18);assert.deepEqual([...new Set(round.map(r=>r.op))].sort(),['content','list','summary']);});check('A15.latency',()=>assert.ok(report.p50_ms>=0&&report.p95_ms>=report.p50_ms));check('A15.error_rate',()=>assert.equal(report.error_rate,0));check('A15.queue_time',()=>assert.ok(report.queue_ms>=0));check('A15.token_usage',()=>assert.ok(report.input_tokens>0&&report.output_tokens>0));check('A15.citation_quality',()=>assert.equal(report.citation_validity,1));check('A15.material_coverage',()=>assert.equal(report.material_coverage,1));check('A15.fact_language_time',()=>assert.deepEqual(report.quality_failures,[]));results.push(report);
 }
 check('A15.model_replacement',()=>assert.deepEqual(results.map(r=>r.model),['fixture','fixture-alternate']));await mkdir('artifacts',{recursive:true});await writeFile('artifacts/acceptance-quality.json',JSON.stringify(results,null,2));
});

test('A24 every native provider proves its protocol, credentials, success, empty and error',async()=>{
 const paths={tavily:'/search',anysearch:'/v1/search',deepseek:'/v1/tools/search',searxng:'/search'};
 for(const provider of Object.keys(paths))await prove('A24.search.'+provider,async()=>{
  const e=await endpoint('search','',{provider,base_url:upstream+'/requires-key',secret:{api_key:'sample-native-key'},options:{...(provider==='searxng'?{engines:[]}: {})}}),made=await project({}, {search:e});
  for(const[query,status]of [['rain','success'],['no-match','empty']]){const start=server.requests.length;const result=await business(made,'list',{query});assert.equal(result.status,status);assert.ok(server.requests.slice(start).some(r=>r.path==='/requires-key'+paths[provider]&&r.authorization==='Bearer sample-native-key'));await recorded(result.request_id);assert.ok((await admin('endpoint-calls?request_id='+result.request_id)).items.every(c=>!c.browser_job));}
  await business(made,'list',{query:'upstream-failure'},502);const invalid=await endpoint('search','business-error',{provider,options:{...(provider==='searxng'?{engines:[]}: {})}});const rejected=await business(await project({}, {search:invalid}),'list',{query:'rain'},502);assert.equal(rejected.error.code,'UPSTREAM_BUSINESS_ERROR');
 });
 const readPaths={tavily:'/extract',anysearch:'/v1/extract',deepseek:'/v1/tools/fetch',crawl4ai:'/crawl'};
 for(const provider of Object.keys(readPaths))await prove('A24.reader.'+provider,async()=>{
  const e=await endpoint('reader','',{provider,base_url:upstream+'/requires-key',secret:{api_key:'sample-native-key'},options:{format:'markdown'}}),made=await project({}, {reader:e});const before=server.requests.length;const result=await business(made,'content',{url:upstream+'/article?redirected=1'});assert.ok(result.data.text.length);assert.ok(server.requests.slice(before).some(r=>r.path==='/requires-key'+readPaths[provider]&&r.authorization==='Bearer sample-native-key'));check('A24.unknown_final_url',()=>{assert.equal(result.data.url,upstream+'/article?redirected=1');assert.ok(!('final_url'in result.data));});await recorded(result.request_id);assert.ok((await admin('endpoint-calls?request_id='+result.request_id)).items.every(c=>!c.browser_job));
  const empty=await endpoint('reader','emptycontent',{provider,options:{format:'markdown'}});await business(await project({}, {reader:empty}),'content',{url:upstream+'/article'},502);
  const invalid=await endpoint('reader','business-error',{provider,options:{format:'markdown'}});const businessFailed=await business(await project({}, {reader:invalid}),'content',{url:upstream+'/article'},502);assert.equal(businessFailed.error.code,'UPSTREAM_BUSINESS_ERROR');const failed=await endpoint('reader','',{provider,base_url:upstream+'/upstream-denied',options:{format:'markdown'}});await business(await project({}, {reader:failed}),'content',{url:upstream+'/article'},502);
 });
 await prove('A24.no_firefox',async()=>{const d=await admin('diagnostics');assert.ok(Object.entries(d.scheduler.active_leases).filter(([key])=>key.startsWith('worker:')).every(([,n])=>n===0));});
});

test('A19 reader provenance retains every dispatched failure and successful or snippet material',async()=>{
 const failed=await endpoint('reader','emptycontent'),reader=await endpoint('reader');const made=await project({reader_pools:[[failed.id,reader.id]]});const value=await business(made,'summary',{query:'rain'});await recorded(value.request_id);const data=await admin('requests/'+value.request_id+'/export');const c=data.evidence.candidates[0];const attempts=c.reader_call_ids.map(id=>data.calls.find(call=>call.call_id===id));
 check('A19.reader_retry_chain',()=>{assert.equal(attempts.length,2);assert.deepEqual(attempts.map(call=>call.endpoint_id),[failed.id,reader.id]);assert.deepEqual(attempts.map(call=>call.status),['error','success']);assert.ok(attempts.every(call=>call.candidate_id===c.candidate_id&&call.source_id===c.source_id));});
 check('A19.reader_article',()=>assert.equal(c.material,'reader_body'));
 const other=await endpoint('reader','login');const snippet=await project({reader_pools:[[failed.id,other.id]],allow_snippets:true});const partial=await business(snippet,'summary',{query:'rain'});await recorded(partial.request_id);const trace=await admin('requests/'+partial.request_id+'/export');
 check('A19.reader_failed_chain',()=>{const candidate=trace.evidence.candidates[0];assert.equal(candidate.material,'snippet');assert.equal(candidate.reader_call_ids.length,2);assert.ok(candidate.reader_call_ids.every(id=>trace.calls.some(call=>call.call_id===id&&call.status==='error')));});
 const integrated=await endpoint('search','',{adapter:'integrated_search'});const inline=await project({}, {search:integrated});const answer=await business(inline,'summary',{query:'rain'});await recorded(answer.request_id);const recordedInline=await admin('requests/'+answer.request_id+'/export');
 check('A19.inline_article',()=>{assert.equal(recordedInline.evidence.candidates[0].material,'inline_body');assert.ok(!recordedInline.calls.some(c=>c.kind==='reader'));});check('A24.inline_scoring',()=>assert.ok(recordedInline.calls.some(c=>c.stage==='score')&&answer.data.sources[0].score>0));
});


test('completed search branches remain queryable after cancellation and a sibling timeout',async()=>{
 for(const cancel of [true,false]){
  const search=await endpoint('search','fanout',{timeout_ms:cancel?2000:250});const made=await project({rewrite_count:1},{search});const id=crypto.randomUUID();const start=server.requests.length;
  const pending=business(made,'summary',{query:'rain'},cancel?499:200,{'X-Request-ID':id});
  try{
   for(let n=0;n<100&&!(server.fanoutHeld?.length);n++)await sleep(20);
   assert.ok(server.fanoutHeld?.length);assert.ok(server.requests.slice(start).some(r=>r.input?.query==='rain'));await sleep(100);
   if(cancel)await admin('requests/'+id+'/cancel',{});await pending;await recorded(id);const exported=await admin('requests/'+id+'/export');
   check(cancel?'A08.completed_cancel':'A08.completed_timeout',()=>{const variants=exported.evidence.variants;assert.equal(variants.length,2);assert.equal(variants[0].hits.length,1);assert.equal(variants[1].hits,null);assert.equal(exported.request.execution_summary.retrieval.known_raw_candidates,1);assert.equal(exported.request.execution_summary.retrieval.raw_candidates,null);});
   check('A13.completed_evidence',()=>{assert.equal(exported.request.execution_summary.retrieval.completed_variants,1);assert.equal(exported.request.execution_summary.retrieval.incomplete_variants,1);});
  }finally{for(const release of server.fanoutHeld||[])release();server.fanoutHeld=[];await pending.catch(()=>{});}
 }
});

test('Language preferences only select a starting pool and native date support controls eligibility',async()=>{
 const basic=await endpoint('search','',{provider:'anysearch'}),dated=await endpoint('search');
 const made=await project({search_pools:[[basic.id],[dated.id]]});
 const original=await admin('language-routes');
 let active=await admin('language-routes',{expected_version:original.version,entries:[{language:'fr',endpoint_ids:[dated.id]}]},'PUT');
 async function run(input){
   const r=await business(made,'list',input);await recorded(r.request_id);
   const calls=(await admin('endpoint-calls?request_id='+r.request_id)).items;
   assert.equal(calls.length,1);return calls[0];
 }
 try {
   const unspecified=await run({query:'automatic'}),other=await run({query:'日本語',language:'ja'}),regional=await run({query:'pluie',language:'FR-ca'});
   check('A21.open_languages',()=>{assert.equal(unspecified.endpoint_id,basic.id);assert.equal(unspecified.language,null);assert.equal(other.endpoint_id,basic.id);assert.equal(regional.endpoint_id,dated.id);assert.equal(regional.language,'fr-CA');assert.equal(regional.reason,'language');});
   const date=await run({query:'雨量',language:'sw',time_range:'day'});
   const only=await project({search_pools:[[basic.id]]});const failed=await business(only,'list',{query:'rainfall',time_range:'year'},400);await recorded(failed.request_id);
   const unavailable=(await admin('endpoint-calls?request_id='+failed.request_id)).items;
   check('A21.native_time_capabilities',()=>{assert.equal(date.endpoint_id,dated.id);assert.equal(failed.error.code,'TIME_RANGE_UNSUPPORTED');assert.equal(unavailable.length,0);assert.ok(!('languages'in made.project));assert.ok(!('default_language'in made.project));assert.ok(!('time_ranges'in basic.options));});
   await business(made,'list',{query:'bad tag',language:'not a tag'},400);
 }finally{await admin('language-routes',{expected_version:active.version,entries:original.entries},'PUT');}
});
