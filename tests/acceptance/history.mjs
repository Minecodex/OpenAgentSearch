import {test,before,after} from 'node:test';
import {assert,check,prove} from './proof.mjs';
import {setup,close,admin,project,business,recorded,sql,q,upstream} from './context.mjs';
before(setup);after(close);
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
async function retention(days){const current=await admin('settings/retention');if(current.retention_days!==days)await admin('settings/retention',{retention_days:days,expected_version:current.version},'PUT');}
function shift(request,started,expires){
 sql(`UPDATE requests SET started_at=${quote(started)}::timestamptz,expires_at=${quote(expires)}::timestamptz,record=record||jsonb_build_object('started_at',${quote(started)}::timestamptz,'expires_at',${quote(expires)}::timestamptz) WHERE id=${quote(request)}::uuid;
 UPDATE endpoint_calls SET finished_at=${quote(started)}::timestamptz+interval '100 milliseconds',expires_at=${quote(expires)}::timestamptz,body=body||jsonb_build_object('started_at',${quote(started)}::timestamptz,'finished_at',${quote(started)}::timestamptz+interval '100 milliseconds') WHERE request_id=${quote(request)}::uuid;`);
}
function moveBuckets(project){
 for(const[table,period]of [['endpoint_stats_hour','hour'],['endpoint_stats_day','day']])sql(`UPDATE ${table} s SET bucket_at=c.bucket,first_expiry=c.first_expiry,last_expiry=c.last_expiry FROM (SELECT dimension_hash,retention_version,date_trunc('${period}',MIN(finished_at),'UTC') bucket,MIN(expires_at) first_expiry,MAX(expires_at) last_expiry FROM endpoint_calls WHERE body->>'project_id'=${quote(project)} GROUP BY dimension_hash,retention_version)c WHERE s.dimension_hash=c.dimension_hash AND s.retention_version=c.retention_version;`);
}
async function response(made,op='summary'){const result=await business(made,op,op==='content'?{url:upstream+'/article'}:{query:'rain'});await recorded(result.request_id);return result;}
test('A13 whole-day rollups plus partial-hour edges, local calendar regrouping and raw search filters never double count',async()=>{
 const a=await project(),b=await project({}, {search:a.search});const one=await response(a,'list'),two=await response(a,'list'),edge=await response(b,'list');
 const day=new Date();day.setUTCHours(0,0,0,0);day.setUTCDate(day.getUTCDate()-2);const expiry=new Date(Date.now()+86400000).toISOString();
 shift(one.request_id,new Date(+day+10*3600000+5*60000).toISOString(),expiry);shift(two.request_id,new Date(+day+10*3600000+45*60000).toISOString(),expiry);shift(edge.request_id,new Date(+day-10*60000).toISOString(),expiry);moveBuckets(a.project.id);moveBuckets(b.project.id);
 const scope={endpoint_id:a.search.id,from:new Date(+day-15*60000).toISOString(),to:new Date(+day+86400000+15*60000).toISOString(),granularity:'day',timezone:'UTC'};
 const full=await admin('endpoint-statistics?'+q(scope));check('A13.day_and_edges',()=>assert.equal(full.overview.calls,3));assert.equal(full.series.reduce((n,b)=>n+b.metrics.calls,0),3);
 const raw=await admin('endpoint-statistics?'+q({...scope,q:'rain'}));check('A13.no_double_count',()=>assert.deepEqual(raw.overview,full.overview));
 const local=await admin('endpoint-statistics?'+q({...scope,timezone:'Asia/Shanghai'}));check('A13.calendar_timezone',()=>assert.equal(local.overview.calls,3));
 const partial=await admin('endpoint-statistics?'+q({...scope,project_id:a.project.id,from:new Date(+day+10*3600000+30*60000).toISOString(),to:new Date(+day+11*3600000).toISOString()}));assert.equal(partial.overview.calls,1);
});

test('A27 seven-to-three retention affects new records only and every expired read stays closed before physical cleanup',async()=>{
 await retention(7);const a=await project({name:'Retention A'}),b=await project({name:'Retention B'});const old=await response(a);const before=await admin('requests/'+old.request_id);
 const start=new Date(Date.now()-4*86400000),oldExpiry=new Date(+start+7*86400000);shift(old.request_id,start.toISOString(),oldExpiry.toISOString());moveBuckets(a.project.id);
 await retention(3);const recent=await response(b),expired=await response(a);shift(expired.request_id,start.toISOString(),new Date(+start+3*86400000).toISOString());moveBuckets(a.project.id);
 const oldAfter=await admin('requests/'+old.request_id),newAfter=await admin('requests/'+recent.request_id);assert.equal(oldAfter.metadata.retention_days,7);check('A27.seven_to_three',()=>{assert.equal(oldAfter.metadata.retention_days,7);assert.equal(newAfter.metadata.retention_days,3);assert.notEqual(oldAfter.metadata.retention_version,newAfter.metadata.retention_version);});check('A27.fixed_expiry',()=>assert.equal(Date.parse(oldAfter.metadata.expires_at),+oldExpiry));check('A27.four_day_old_visible',()=>assert.equal(oldAfter.metadata.request_id,old.request_id));assert.notEqual(oldAfter.metadata.retention_version,newAfter.metadata.retention_version);assert.equal(before.snapshot.project.id,oldAfter.snapshot.project.id);
 const oldExport=await admin('requests/'+old.request_id+'/export');assert.ok(oldExport.payloads.flatMap(s=>s.replay).some(m=>m.model_input));const oldCall=oldExport.calls[0];assert.equal((await admin('endpoint-calls/'+oldCall.call_id)).request_id,old.request_id);
 const allScope={project_id:a.project.id,from:new Date(+start-3600000).toISOString(),to:new Date(Date.now()+3600000).toISOString(),granularity:'day',timezone:'UTC'};
 const stats=await admin('endpoint-statistics?'+q(allScope));check('A27.mixed_versions',()=>assert.equal(stats.overview.calls,oldExport.calls.length));assert.equal((await admin('requests/aggregates?'+q(allScope))).requests,1);
 check('A27.physical_cleanup_lag',()=>assert.equal(sql(`SELECT count(*) FROM requests WHERE id=${quote(expired.request_id)}::uuid;`),'1'));
 for(const suffix of ['', '/evidence','/export'])await prove(suffix==='/export'?'A27.export_expire':'A13.expired_payload',async()=>{await admin('requests/'+expired.request_id+suffix,undefined,'GET',404);});
 assert.equal((await admin('requests?'+q({...allScope,q:expired.request_id}))).items.length,0);assert.equal((await admin('endpoint-calls?request_id='+expired.request_id)).items.length,0);
 const expiredMetadata=JSON.parse(sql(`SELECT payload::text FROM requests WHERE id=${quote(expired.request_id)}::uuid;`));const span=expiredMetadata.spans[0].span.span_id;await admin('requests/'+expired.request_id+'/spans/'+span,undefined,'GET',404);
 const page=expiredMetadata.spans.flatMap(s=>s.replay).find(m=>m.layout_state);await prove('A27.materials_expire',async()=>{assert.ok(page);await admin('requests/'+expired.request_id+'/replay/'+page.material_id+'/layout',undefined,'GET',404);});
 const expiredCall=JSON.parse(sql(`SELECT body::text FROM endpoint_calls WHERE request_id=${quote(expired.request_id)}::uuid LIMIT 1;`));await prove('A27.calls_expire',async()=>{await admin('endpoint-calls/'+expiredCall.call_id,undefined,'GET',404);});
 await retention(10);const extended=await response(b,'list');assert.equal((await admin('requests/'+extended.request_id)).metadata.retention_days,10);await prove('A27.extend_new_only',async()=>{assert.equal((await admin('requests/'+recent.request_id)).metadata.expires_at,newAfter.metadata.expires_at);assert.equal((await admin('requests/'+extended.request_id)).metadata.retention_days,10);});check('A27.new_only',()=>assert.equal(oldAfter.metadata.retention_days,7));await retention(7);
});

test('A27 partially expired contributions within one policy version and hour fall back to only valid detail',async()=>{
 await retention(7);const made=await project();const first=await response(made,'list'),second=await response(made,'list');const now=Date.now(),hour=now-now%3600000;
 const earlyExpiry=hour+Math.max(1,(now-hour)/2),lateExpiry=now+(hour+3600000-now)/2;
 shift(first.request_id,new Date(earlyExpiry-7*86400000).toISOString(),new Date(earlyExpiry).toISOString());shift(second.request_id,new Date(lateExpiry-7*86400000).toISOString(),new Date(lateExpiry).toISOString());moveBuckets(made.project.id);
 const from=new Date(hour-7*86400000).toISOString(),to=new Date(hour-7*86400000+3600000).toISOString();const stats=await admin('endpoint-statistics?'+q({project_id:made.project.id,from,to,granularity:'hour',timezone:'UTC'}));check('A27.mixed_same_version',()=>assert.equal(stats.overview.calls,1));assert.equal((await admin('requests/aggregates?'+q({project_id:made.project.id,from,to}))).requests,1);
 await admin('requests/'+first.request_id,undefined,'GET',404);await admin('requests/'+second.request_id);
});
