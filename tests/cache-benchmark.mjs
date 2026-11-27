// Feed real, desensitized queries as JSONL: {"query":"...","language":"en"}.
// Uses a dedicated cache-enabled project, including its ordinary miss routing.
import {readFile,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
const file=process.argv[2];
if(!file||!process.env.OAS_BENCH_API_KEY)throw Error('Usage: OAS_BENCH_API_KEY=... node tests/cache-benchmark.mjs queries.jsonl [concurrency=4] [output.json]');
const base=process.env.OAS_TEST_API||'http://127.0.0.1:18080';
const queries=(await readFile(file,'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const concurrency=Math.max(1,Math.min(128,Number(process.argv[3]||4)));
let next=0;const samples=[];const started=performance.now();
await Promise.all(Array.from({length:concurrency},async()=>{
 while(next<queries.length){const index=next++,at=performance.now();
  try{const response=await fetch(base+'/v1/search/list',{method:'POST',headers:{Authorization:'Bearer '+process.env.OAS_BENCH_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({...queries[index],count:10}),signal:AbortSignal.timeout(45000)});const value=await response.json();samples.push({index,ms:performance.now()-at,status:response.status,request_id:value.request_id,items:value.data?.items?.length||0});}
  catch(error){samples.push({index,ms:performance.now()-at,status:0,error:error.name});}
 }
}));
const sorted=samples.map(s=>s.ms).sort((a,b)=>a-b);const percentile=p=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]??null;
const report={count:samples.length,concurrency,elapsed_ms:performance.now()-started,p50_ms:percentile(.5),p95_ms:percentile(.95),p99_ms:percentile(.99),failures:samples.filter(s=>s.status!==200).length,samples};
await writeFile(process.argv[4]||'artifacts/cache-benchmark.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,samples:undefined},null,2));
