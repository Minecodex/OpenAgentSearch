// A disposable three-node kind cluster exercises the HA values and replica recovery.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir, writeFile, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {fingerprint} from './acceptance/fingerprint.mjs';

const tag='oas-ha-'+randomBytes(4).toString('hex');
const dir=resolve('artifacts',tag), config=resolve(dir,'kubeconfig'), kind=process.env.OAS_KIND||'kind';
const image='qdrant/qdrant:v1.20.0', nodeImage=process.env.OAS_KIND_NODE_IMAGE||'kindest/node:v1.36.1';
const key=randomBytes(24).toString('hex'), chart='deploy/helm/openagentsearch';
const local=ref=>spawnSync('docker',['image','inspect',ref],{stdio:'ignore'}).status===0;
const createdImages=[image,nodeImage].filter(ref=>!local(ref));
const run=(exe,args,input)=>new Promise((ok,fail)=>{
 const child=spawn(exe,args,{stdio:['pipe','pipe','pipe']});let out='',err='';
 child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
 child.on('error',fail);child.on('close',code=>code===0?ok(out.trim()):fail(Error(exe+' exited '+code+' '+err.replaceAll(key,'[redacted]'))));
 child.stdin.end(input);
});
const kube=(...args)=>run('kubectl',['--kubeconfig',config,...args]);
async function until(fn,ms=180000) {
 const end=Date.now()+ms;let last;
 while(Date.now()<end){try{const result=await fn();if(result)return result;}catch(e){last=e;}await pause(800);}
 throw Error('Timed out waiting for cluster convergence',{cause:last});
}
const forwards=[];
async function forward(pod){
 const child=spawn('kubectl',['--kubeconfig',config,'port-forward','pod/'+pod,':6333','--address','127.0.0.1'],{stdio:['ignore','pipe','pipe']});
 forwards.push(child);
 const port=await new Promise((ok,fail)=>{
  let log='',errors='';child.stderr.on('data',b=>errors+=b);const timer=setTimeout(()=>fail(Error('port-forward timeout')),15000);
  child.stdout.on('data',b=>{log+=b;const m=log.match(/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);ok(m[1]);}});
  child.on('error',fail);child.on('exit',code=>{clearTimeout(timer);fail(Error(pod+' port-forward exited '+code+' '+errors));});
 });
 return async(method,path,body)=>{
  const res=await fetch('http://127.0.0.1:'+port+path,{method,headers:{'api-key':key,'Content-Type':'application/json'},
   ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(7000)});
  assert.ok(res.ok,'Qdrant '+method+' '+path+' HTTP '+res.status);
  const data=await res.json();return data.result;
 };
}
let stopped,owned=false;
try{
 await mkdir(dir,{recursive:true});
 const source=await fingerprint();
 await writeFile(resolve(dir,'kind.yaml'),'kind: Cluster\napiVersion: kind.x-k8s.io/v1alpha4\nnodes:\n- role: control-plane\n- role: worker\n- role: worker\n');
 owned=true;
 await run(kind,['create','cluster','--name',tag,'--config',resolve(dir,'kind.yaml'),'--image',nodeImage,'--kubeconfig',config,'--wait','180s']);
 await kube('taint','node',tag+'-control-plane','node-role.kubernetes.io/control-plane:NoSchedule-');
 if(!local(image))await run('docker',['pull',image]);
 // Loading an explicit platform archive also works with a containerd image store.
 const archive=resolve(dir,'qdrant.tar');
 await run('docker',['save','--platform','linux/amd64','-o',archive,image]);
 await run(kind,['load','image-archive',archive,'--name',tag]);
 const rendered=await run('helm',['template','oas',chart,'-f',chart+'/cache-ha.example.yaml','--show-only','templates/cache.yaml',
  '--set-string','cache.existingSecret=','--set-string','cache.qdrant.apiKey='+key,'--set-string','cache.qdrant.image='+image,
  '--set','cache.qdrant.storage=1Gi','--set-string','cache.qdrant.storageClassName=standard']);
 await run('kubectl',['--kubeconfig',config,'apply','-f','-'],rendered);
 await kube('rollout','status','statefulset/oas-cache-qdrant','--timeout=240s');
 const pods=JSON.parse(await kube('get','pods','-l','app=oas-cache-qdrant','-o','json')).items;
 const hosts=pods.map(p=>p.spec.nodeName);assert.equal(new Set(hosts).size,3);
 const victim=pods.find(p=>p.spec.nodeName===tag+'-worker'),survivor=pods.find(p=>p.spec.nodeName===tag+'-control-plane');
 assert.ok(victim&&survivor);
 console.log('Three distinct ready peers. Checking shard replication.');
 const api=await until(()=>forward(survivor.metadata.name)),victimApi=await until(()=>forward(victim.metadata.name));
 await until(async()=>Object.keys((await api('GET','/cluster')).peers).length===3);
 const coll='/collections/ha_acceptance';
 await api('PUT',coll,{vectors:{size:3,distance:'Cosine'},shard_number:6,replication_factor:2,write_consistency_factor:2});
 const topology=async fn=>fn('GET',coll+'/cluster');
 await until(async()=>{const s=await topology(api);return s.local_shards.length+s.remote_shards.length===12&&[...s.local_shards,...s.remote_shards].every(x=>x.state==='Active');});
 assert.ok((await topology(victimApi)).local_shards.length>0);
 const points=Array.from({length:64},(_,i)=>({id:i+1,vector:[1,i/64,0],payload:{sequence:i}}));
 await api('PUT',coll+'/points?wait=true',{points});
 async function check(fn){const rows=await fn('POST',coll+'/points',{ids:points.map(p=>p.id),with_payload:true});
  assert.equal(rows.length,64);assert.ok(rows.every(p=>p.id===p.payload.sequence+1));return true;}
 await check(api);
 stopped=victim.spec.nodeName;
 await run('docker',['stop','-t','5',stopped]);
 assert.equal(await run('docker',['inspect','--format','{{.State.Running}}',stopped]),'false');
 await until(()=>check(api),90000);
 console.log('Read all 64 points during worker outage. Restarting the worker.');
 await run('docker',['start',stopped]);stopped=null;
 await kube('wait','--for=condition=Ready','node/'+victim.spec.nodeName,'--timeout=180s');
 await until(async()=>{const s=await topology(api);return s.local_shards.length+s.remote_shards.length===12&&[...s.local_shards,...s.remote_shards].every(x=>x.state==='Active');});
 const restored=await until(async()=>{
   const fn=await forward(victim.metadata.name);
   return await check(fn) && fn;
 });
 await until(async()=>{await api('PUT',coll+'/points?wait=true',{points:[{id:65,vector:[0,1,0]}]});
   return (await restored('GET',coll+'/points/65')).id===65;});
 await writeFile(resolve(dir,'result.json'),JSON.stringify({fingerprint:source,nodes:hosts,shards:6,replicas:2,
  verified_points_during_outage:64,restored_read:true,replicated_write_after_recovery:true},null,2));
 console.log('HA node loss, read continuity and replicated recovery passed: '+dir);
}finally{
 for(const child of forwards)child.kill();
 if(stopped)await run('docker',['start',stopped]).catch(()=>{});
 if(owned)await run(kind,['delete','cluster','--name',tag,'--kubeconfig',config]);
 await rm(config,{force:true});await rm(resolve(dir,'qdrant.tar'),{force:true});
 for(const ref of createdImages)if(local(ref))await run('docker',['image','rm',ref]);
}
