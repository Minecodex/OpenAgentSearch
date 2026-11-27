// Deliberately deterministic vectors for isolated acceptance only. Production
// always calls the configured embedding provider; it has no hash-vector fallback.
import http from 'node:http';
export const fixtureMatcherProfile='a3'.repeat(32);
export function embeddingFixture(port=18790){
 const held=new Map();
 const requests=[];
 const server=http.createServer(async(req,res)=>{
  const route=new URL(req.url,'http://fixture');
  if(route.pathname==='/matcher-hold'){
   const k=route.searchParams.get('query');
   if(req.method==='POST')held.get(k)?.();
   res.end(JSON.stringify(held.has(k)));return;
  }
  if(req.method==='GET'){
   const text=new URL(req.url,'http://fixture').searchParams.get('query');
   res.setHeader('Content-Type','application/json');
   res.end(JSON.stringify(requests.filter(r=>r.input?.length===1&&r.input[0]===text).length));return;
  }
  const chunks=[];for await(const c of req)chunks.push(c);
  let input;try{input=JSON.parse(Buffer.concat(chunks).toString());}catch{res.writeHead(400);res.end();return;}
  if(route.pathname==='/v1/cache/match'){
   if(req.headers.authorization!=='Bearer cache-fixture-only' || input.profile!==fixtureMatcherProfile || input.input_format!=='oas-cache-material-v1' || !/^[0-9a-f]{64}$/.test(input.embedding_version) || !(input.budget_ms>0)){res.writeHead(401);res.end();return;}
   const q=input.query.text;const candidates=input.candidates;
   if(!candidates?.length || candidates.length>8 || candidates.some(c=>!c.materials?.length || c.materials.length>3)){res.writeHead(400);res.end();return;}
   if(q.includes('matcher-slow'))await new Promise(r=>setTimeout(r,3000));
   if(q.includes('hold-verify')){
    await new Promise(resolve=>{const timer=setTimeout(resolve,3200);held.set(q,()=>{clearTimeout(timer);resolve();});});held.delete(q);
   }
   const decisions=candidates.map(c=>{
    const seedA=c.question.includes('plan2-seed-a'),seedB=c.question.includes('plan2-seed-b');
    const supported=c.materials.some(m=>m.title.includes('Ubuntu 13.04'));
    const use=(q.includes('plan2-merge') && (seedA||seedB)) || (q.includes('plan2-single') && seedA) ||
      (q.includes('plan2-regional question') && c.question.includes('plan2-regional guide')) ||
      (q.includes('plan2-ack retry') && c.question.includes('plan2-ack seed')) ||
      ((q.includes('verify-weak') || q.includes('hold-verify')) && supported);
    return {question_id:c.question_id,label:q.includes('explicit-conflict')?'conflict':(use||q.includes('low-score'))?'reusable':'insufficient',
     reusable_score:q.includes('explicit-conflict')||use?0.99:0.02};
   });
   res.setHeader('Content-Type','application/json');
   res.end(JSON.stringify({profile:q.includes('profile-mismatch')?'wrong':fixtureMatcherProfile,
     threshold:q.includes('no-calibration')?null:0.95,decisions:q.includes('no-calibration')?[]:decisions}));return;
  }
  requests.push(input);
  const texts=Array.isArray(input.input)?input.input:[input.input];
  if(texts.some(t=>String(t).includes('plan2-delay')))await new Promise(r=>setTimeout(r,3000));
  const vector=text=>String(text).includes('verify-weak')?[0,0,1]:String(text).includes('plan2-three')&&text.endsWith(' east')?[0,1,0]:String(text).includes('plan2-three')&&text.endsWith(' west')?[0,0,1]:String(text).includes('plan2-seed-b')?[0.75,Math.sqrt(1-0.75**2),0]:String(text).includes('plan2-merge')?[Math.sqrt(0.875),Math.sqrt(0.125),0]:[1,0,0];
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:texts.map((text,index)=>({index,embedding:vector(text)}))}));
 });
 server.requests=requests;
 return new Promise(resolve=>server.listen(port,'0.0.0.0',()=>resolve(server)));
}
