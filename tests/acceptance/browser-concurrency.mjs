import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {setup,close,admin,project,business,recorded,sql} from './context.mjs';
before(setup);after(close);
function peak(rows){
 const events=rows.flatMap(call=>{const phase=call.browser_job.phases.find(phase=>phase.stage==='execute');assert.ok(phase);return [[phase.start_offset_ms,1],[phase.start_offset_ms+phase.duration_ms,-1]];}).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
 let active=0,maximum=0;for(const[,delta]of events){active+=delta;maximum=Math.max(maximum,active);}return maximum;
}
test('real Firefox searches and four article jobs overlap within one summary and return independent source text',async()=>{
 for(const proxy of (await admin('proxies?limit=100')).items.filter(proxy=>proxy.enabled)){
  const body=Object.fromEntries(['name','scheme','host','port','auth_mode','max_concurrency'].map(key=>[key,proxy[key]]));
  await admin('proxies/'+proxy.id,{...body,enabled:false,expected_version:proxy.version,secret_action:'keep'},'PUT');
 }
 sql(`DELETE FROM browser_engine_health; INSERT INTO probes(egress_id,version,body,generation) VALUES('default_network',1,'{"reachable":false,"checked_at":"${new Date().toISOString()}","probe_pod_uid":"fixture"}',nextval('oas_probe_generation')) ON CONFLICT(egress_id) DO UPDATE SET version=1,body=EXCLUDED.body,generation=EXCLUDED.generation;`);
 const made=await project({rewrite_count:1,source_limit:4,search_pools:[['00000000-0000-4000-8000-000000000001']],reader_pools:[['00000000-0000-4000-8000-000000000002']],summary_snippets_only:false});
 const result=await business(made,'summary',{query:'concurrent-readers rainfall',source_count:4});await recorded(result.request_id);
 const trace=await admin('requests/'+result.request_id+'/export');await writeFile('artifacts/browser-concurrency-e2e.json',JSON.stringify(trace,null,2));
 assert.equal(result.status,'success',JSON.stringify(result));
 const searches=trace.calls.filter(call=>call.kind==='search'),readers=trace.calls.filter(call=>call.kind==='reader');
 assert.equal(searches.length,2);assert.equal(readers.length,4);assert.equal(peak(searches),2);assert.ok(peak(readers)>=2&&peak(readers)<=4);
 assert.equal(new Set([...searches,...readers].map(call=>call.browser_job.job_id)).size,6);
 assert.equal(result.data.sources.length,4);
 for(const source of trace.evidence.sources){const index=new URL(source.url).searchParams.get('parallel_source'),extraction=trace.payloads.find(payload=>payload.span.stage==='extract'&&payload.input.url===source.url);assert.ok(extraction.output.body.includes('Independent source '+index));}
 for(const call of [...searches,...readers])assert.equal(call.browser_job.phases.filter(phase=>phase.stage==='cleanup').length,1);
 assert.equal(sql('SELECT count(*) FROM browser_jobs;'),'0');
 const diagnostics=await admin('diagnostics');assert.ok(Object.values(diagnostics.scheduler.active_leases).every(value=>value===0));
 console.log(JSON.stringify({search_peak:peak(searches),reader_peak:peak(readers),jobs:6}));
});
