// Build and import only this run's images into an existing local Kubernetes
// node. The suite owns a helper namespace and its own Helm test namespace.
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import assert from 'node:assert/strict';
import {fingerprint} from './acceptance/fingerprint.mjs';
const id=randomBytes(4).toString('hex'),namespace='oas-load-'+id,tag='oas-helm-'+id;
const work=resolve('artifacts/kubernetes-'+id),container=process.env.OAS_BUILD_CONTAINER;
assert.ok(container,'OAS_BUILD_CONTAINER must identify the owned Rust validation container');
const images=Object.fromEntries(['api','browser','web'].map(k=>[k,tag+':'+k]));
const context=process.env.OAS_KUBE_CONTEXT||'docker-desktop';const k=['--context',context,'--namespace',namespace];
const run=(program,args,{capture=false,input,env={}}={})=>new Promise((resolve,reject)=>{
 const child=spawn(program,args,{stdio:[input?'pipe':'ignore',capture?'pipe':'inherit',capture?'pipe':'inherit'],env:{...process.env,...env}});let out='',err='';if(capture){child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);}if(input)child.stdin.end(input);child.once('error',reject);child.once('exit',code=>code===0?resolve(out.trim()):reject(Error(program+' exited '+code+' '+err)));
});
const kube=(...args)=>run('kubectl',[...k,...args]);
const exec=(...args)=>run('kubectl',[...k,'exec','image-loader','--',...args],{capture:true});
const ctr=['/host/ctr','--address','/run/containerd/containerd.sock','--namespace','k8s.io'];
let baseline=new Set(),helperReady=false,completed=false;let sourceFingerprint;const evidence=[];const reports=resolve('artifacts/acceptance-'+tag);
async function download(url,file){let error;for(let n=0;n<3;n++){try{const response=await fetch(url,{signal:AbortSignal.timeout(30000)});assert.ok(response.ok,url);const bytes=Buffer.from(await response.arrayBuffer());await writeFile(resolve(work,file),bytes);return bytes;}catch(failure){error=failure;}}throw error;}
async function tools(){
 const existing=await run('docker',['exec',container,'helm','version','--template','{{.Version}}'],{capture:true}).catch(()=>null);
 if(existing!=='v3.16.4'){
  const helm=await download('https://get.helm.sh/helm-v3.16.4-linux-amd64.tar.gz','helm.tgz');const checksum=(await download('https://get.helm.sh/helm-v3.16.4-linux-amd64.tar.gz.sha256sum','helm.sha256')).toString().split(/\s+/)[0];assert.equal(createHash('sha256').update(helm).digest('hex'),checksum);
  await run('tar',['-xzf',resolve(work,'helm.tgz'),'-C',work]);await run('docker',['cp',resolve(work,'linux-amd64/helm'),container+':/usr/local/bin/helm']);
 }
 const toolContainer=tag+'-kubectl';
 try{
  await run('docker',['create','--name',toolContainer,'--label','oas.task=completion','--entrypoint','/bin/true','kindest/node:v1.36.1'],{capture:true});
  await run('docker',['cp',toolContainer+':/usr/bin/kubectl',resolve(work,'kubectl')]);
 }finally{await run('docker',['rm',toolContainer]).catch(()=>{});}
 await run('docker',['cp',resolve(work,'kubectl'),container+':/usr/local/bin/kubectl']);await run('docker',['exec',container,'chmod','755','/usr/local/bin/helm','/usr/local/bin/kubectl']);
 const version=JSON.parse(await run('docker',['exec',container,'kubectl','version','--client','-o','json'],{capture:true}));assert.equal(version.clientVersion.gitVersion,'v1.36.1');
 // Capture credentials to a temporary ignored file without sending them to logs.
 const config=JSON.parse(await run('kubectl',['--context',context,'config','view','--minify','--raw','--flatten','-o','json'],{capture:true}));
 for(const entry of config.clusters){const url=new URL(entry.cluster.server);if(['127.0.0.1','localhost'].includes(url.hostname)){entry.cluster['tls-server-name']=url.hostname;url.hostname='host.docker.internal';}entry.cluster.server=url.toString().replace(/\/$/,'');}
 await writeFile(resolve(work,'kubeconfig.json'),JSON.stringify(config));
 await run('docker',['cp',resolve(work,'kubeconfig.json'),container+':/tmp/oas-kube-'+id+'.json']);await run('docker',['exec',container,'chmod','600','/tmp/oas-kube-'+id+'.json']);
 await run('docker',['exec','-e','KUBECONFIG=/tmp/oas-kube-'+id+'.json',container,'kubectl','--request-timeout=10s','get','--raw','/version'],{capture:true});

 await run('docker',['exec',container,'cargo','build','--release','-p','oasctl']);
}
try{
 await mkdir(work,{recursive:true});await mkdir(reports,{recursive:true});sourceFingerprint=await fingerprint();await tools();
 for(const target of Object.keys(images))await run('docker',['build','-f','deploy/Dockerfile','--target',target,'--label','org.openagentsearch.source='+sourceFingerprint,'-t',images[target],'.']);
 for(const image of Object.values(images)){const found=JSON.parse(await run('docker',['image','inspect',image],{capture:true}))[0];evidence.push({image,id:found.Id,fingerprint:found.Config.Labels?.['org.openagentsearch.source']});}
 const node=JSON.parse(await run('kubectl',['--context',context,'get','nodes','-o','json'],{capture:true}));assert.equal(node.items.length,1,'the local importer expects one explicitly selected node');// Kubelet can omit a cached image from its size-limited NodeStatus list.
 await kube('create','namespace',namespace);
 const pod={apiVersion:'v1',kind:'Pod',metadata:{name:'image-loader',namespace,labels:{'oas.task':tag}},spec:{nodeName:node.items[0].metadata.name,restartPolicy:'Never',containers:[{name:'loader',image:'postgres:18.6-alpine',imagePullPolicy:'Never',command:['sleep','1800'],securityContext:{privileged:true},volumeMounts:[{name:'ctr',mountPath:'/host/ctr',readOnly:true},{name:'socket',mountPath:'/run/containerd/containerd.sock'},{name:'linker',mountPath:'/lib64',readOnly:true},{name:'libraries',mountPath:'/lib/x86_64-linux-gnu',readOnly:true}]}],volumes:[{name:'ctr',hostPath:{path:'/usr/local/bin/ctr',type:'File'}},{name:'socket',hostPath:{path:'/run/containerd/containerd.sock',type:'Socket'}},{name:'linker',hostPath:{path:'/lib64',type:'Directory'}},{name:'libraries',hostPath:{path:'/lib/x86_64-linux-gnu',type:'Directory'}}]}};
 await run('kubectl',[...k,'apply','-f','-'],{input:JSON.stringify(pod)});await kube('wait','--for=condition=Ready','pod/image-loader','--timeout=180s');helperReady=true;
 baseline=new Set((await exec(...ctr,'images','list','-q')).split('\n'));
 await run('docker',['save','--output',resolve(work,'images.tar'),...Object.values(images)]);await kube('cp',relative(process.cwd(),resolve(work,'images.tar')).replaceAll('\\','/'),'image-loader:/tmp/images.tar');await exec(...ctr,'images','import','--platform','linux/amd64','/tmp/images.tar');
 const env={OAS_SUITE:'kubernetes',OAS_RUN_ID:tag,OAS_SOURCE_FINGERPRINT:sourceFingerprint,OAS_ASSERTIONS_FILE:resolve(reports,'helm.assertions.jsonl'),OAS_TEST_API:"http://127.0.0.1:18083",OAS_TEST_FIXTURE_BASE:process.env.OAS_KUBE_FIXTURE_BASE||"http://host.docker.internal:18791",OAS_KUBE_CONTEXT:context,OASCTL_PREFIX_JSON:JSON.stringify(['docker','exec','-e','KUBECONFIG=/tmp/oas-kube-'+id+'.json',container,'/work/target/linux/release/oasctl']),OAS_HELM_CHART_PATH:'/work/deploy/helm/openagentsearch',OAS_TEST_IMAGES_JSON:JSON.stringify(Object.fromEntries(Object.entries(images).map(([k,v])=>[k,{repository:tag,tag:k,pullPolicy:'Never'}])))};
 await run(process.execPath,['tests/helm.mjs'],{env});
 if(await fingerprint()!==sourceFingerprint)throw Error('Source changed during Kubernetes acceptance');completed=true;
}finally{
 if(helperReady){
  const current=(await exec(...ctr,'images','list','-q').catch(()=>'' )).split('\n');const owned=current.filter(ref=>!baseline.has(ref)&&(ref.startsWith('docker.io/library/'+tag+':')||ref.includes('searxng/searxng')||ref.includes('unclecode/crawl4ai')));
  for(const ref of owned)await exec(...ctr,'images','remove',ref).catch(()=>{});
 }
 await kube('delete','namespace',namespace,'--ignore-not-found','--wait=true','--timeout=60s').catch(()=>{});
 for(const image of Object.values(images))await run('docker',['image','rm',image]).catch(()=>{});
 await run('docker',['exec',container,'rm','-f','/tmp/oas-kube-'+id+'.json']).catch(()=>{});
 assert.equal(resolve(work,'..'),resolve('artifacts'));await rm(work,{recursive:true,force:true});
 if(completed)await writeFile('artifacts/acceptance-kubernetes.json',JSON.stringify({version:2,suite:'kubernetes',suites:['kubernetes'],run_id:tag,fingerprint:sourceFingerprint,directory:reports,completed:true,assertions:[{path:'helm.assertions.jsonl'}],images:evidence},null,2));
}
