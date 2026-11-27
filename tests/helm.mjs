// Real install/upgrade acceptance against an existing disposable local cluster.
// Images must be loaded into its node runtime or reachable from a registry.
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {writeFile,rm,mkdir} from 'node:fs/promises';
import {assert,check,prove} from './acceptance/proof.mjs';
import {fixture} from './fixture.mjs';
const suffix=randomBytes(6).toString('hex'),namespace='oas-e2e-'+suffix,release='oas';
const base=process.env.OAS_TEST_API||'http://127.0.0.1:18083',port=new URL(base).port;
const source=process.env.OAS_TEST_FIXTURE_BASE||'http://host.docker.internal:18780';
const prefix=process.env.OASCTL_PREFIX_JSON?JSON.parse(process.env.OASCTL_PREFIX_JSON):[process.env.OASCTL||'target/release/oasctl'];
const chart=process.env.OAS_HELM_CHART_PATH||'deploy/helm/openagentsearch';
const valuesFile='artifacts/helm-'+suffix+'.json';
const passwordFile='artifacts/helm-'+suffix+'-password.txt';const initialUsername='installer-admin',initialPassword='test-password-2026';
const kube=process.env.OAS_KUBE_CONTEXT?['--context',process.env.OAS_KUBE_CONTEXT]:[];
const run=(program,args)=>new Promise((resolve,reject)=>{
  const child=spawn(program,args,{stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(program+' exited '+code)));
});
const ctlArgs=(action,timeout='3m')=>[...prefix.slice(1),action,'--namespace',namespace,'--release',release,'--chart',chart,'--values',valuesFile,'--timeout',timeout];
const ctl=(action)=>run(prefix[0],[...ctlArgs(action),...(action==='install'?['--admin-username',initialUsername,'--admin-password-file',process.env.OASCTL_PREFIX_JSON?'/work/'+passwordFile:passwordFile]:[])]);
const kubectl=(...args)=>run('kubectl',[...kube,'--namespace',namespace,...args]);
// The acceptance release uses two slots per Pod, including the three-Pod scaling check.
const browserTestResources={requests:{cpu:'250m',memory:'1Gi'},limits:{memory:'2Gi'}};
const values={
  publicOrigin:base,
  images:process.env.OAS_TEST_IMAGES_JSON?JSON.parse(process.env.OAS_TEST_IMAGES_JSON):Object.fromEntries(['api','web','browser'].map(k=>[k,{repository:'oas/'+k,tag:'task',pullPolicy:'Never'}])),
  credentials:{adminPassword:'values-must-not-win'},postgres:{storage:'1Gi',password:'fixture:@#/?[]%Ab123'},
  api:{extraEnv:[{name:'OAS_EGRESS_ALLOW_HOSTS',value:'host.docker.internal'}]},
  browser:{replicas:2,slots:2,resources:browserTestResources,extraEnv:[{name:'OAS_EGRESS_ALLOW_HOSTS',value:'host.docker.internal'},{name:'OAS_TEST_GOOGLE_ORIGIN',value:source},{name:'OAS_TEST_BAIDU_ORIGIN',value:source}]},
  searxng:{enabled:false,settings:{use_default_settings:{engines:{keep_only:[]}},search:{formats:['html','json']},engines:[{name:'fixture',shortcut:'fixture',engine:'json_engine',network:{enable_http:true},search_url:source+'/search?format=json&q={query}',results_query:'results',url_query:'url',title_query:'title',content_query:'content',paging:false}]}},
  crawl4ai:{enabled:false,extraEnv:[{name:'CRAWL4AI_ALLOW_INTERNAL_URLS',value:'true'}]},
};
const save=()=>writeFile(valuesFile,JSON.stringify(values));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let cookie='',csrf='',forward,server;let retainedAddon;
async function ready(){for(let n=0;n<120;n++){try{const r=await fetch(base+'/health/ready',{signal:AbortSignal.timeout(1000)});if(r.ok)return;}catch{}await pause(500);}assert.fail('API not ready');}
async function admin(path,body,method=body?'POST':'GET'){
  const r=await fetch(base+'/admin/v1/'+path,{method,headers:{Cookie:cookie,Origin:base,'X-CSRF-Token':csrf,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v.data;
}
async function business(key,op,input){
  const r=await fetch(base+'/v1/search/'+op,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(input)});
  const v=await r.json();assert.equal(r.status,200,JSON.stringify(v));return v;
}
async function capacity(n){for(let i=0;i<80;i++){const e=await admin('endpoints?limit=100');const found=e.items.find(e=>e.adapter==='browser_search');if(found.ready_pods===n)return found;await pause(250);}assert.fail('discovery did not converge');}
async function openForward(){forward?.kill();await pause(150);forward=spawn('kubectl',[...kube,'--namespace',namespace,'port-forward','service/'+release+'-web',port+':80'],{stdio:'ignore'});await ready();}
async function upgrade(){await save();await ctl('upgrade');await openForward();}
async function available(provider,expected){for(let i=0;i<80;i++){const e=(await admin('endpoints?limit=100')).items.find(e=>e.provider===provider);if(e.availability===expected)return e;await pause(250);}assert.fail(provider+' readiness did not converge');}
function capture(program,args){return new Promise((resolve,reject)=>{const child=spawn(program,args,{stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b);child.once('error',reject);child.once('exit',code=>resolve({code,text}));});}
async function database(statement){const result=await capture('kubectl',[...kube,'--namespace',namespace,'exec','statefulset/oas-postgres','--','psql','-X','-U','oas','-d','oas','-At','-v','ON_ERROR_STOP=1','-c',statement]);assert.equal(result.code,0,result.text);return result.text.trim();}

async function componentShape(search,crawl){
 const result=await capture('kubectl',[...kube,'--namespace',namespace,'get','deployments,services','-o','json']);assert.equal(result.code,0,result.text);const objects=JSON.parse(result.text).items;
 for(const [name,enabled]of [['searxng',search],['crawl4ai',crawl]])for(const kind of ['Deployment','Service'])assert.equal(objects.some(o=>o.kind===kind&&o.metadata.name==='oas-'+name),enabled,kind+' '+name);
 for(const name of ['api','web','browser'])assert.ok(objects.some(o=>o.kind==='Deployment'&&o.metadata.name==='oas-'+name&&o.status.readyReplicas===o.spec.replicas));
 check('A16.independent_switches',()=>{assert.equal(objects.filter(o=>o.kind==='Deployment'&&['oas-searxng','oas-crawl4ai'].includes(o.metadata.name)).length,Number(search)+Number(crawl));});
}
async function readyUids(){const result=await capture('kubectl',[...kube,'--namespace',namespace,'get','pods','-l','app=oas-browser','-o','json']);assert.equal(result.code,0,result.text);return new Set(JSON.parse(result.text).items.filter(p=>p.status.conditions.some(c=>c.type==='Ready'&&c.status==='True')).map(p=>p.metadata.uid));}
async function callsFor(id){for(let i=0;i<80;i++){const calls=await admin('endpoint-calls?request_id='+id);if(calls.items.length)return calls.items;await pause(100);}assert.fail('calls were not persisted');}

async function kubeObject(ns, kind, name) {
  const response = await capture('kubectl', [...kube, '-n', ns, 'get', kind, name, '-o', 'json']);
  assert.equal(response.code, 0, response.text);
  return JSON.parse(response.text);
}

async function verifyCrawlResolver() {
  const before = await kubeObject(namespace, 'deployment', 'oas-crawl4ai');
  assert.equal(before.spec.template.spec.containers.length, 1);
  const clusterDns = await kubeObject('kube-system', 'service', 'kube-dns');
  const clusterDomain = process.env.OAS_TEST_CLUSTER_DOMAIN || 'cluster.local';
  values.crawl4ai.publicDns = {enabled:true, clusterServer:clusterDns.spec.clusterIP, clusterDomain};
  values.crawl4ai.extraEnv = [];
  await upgrade();
  const app = (await kubeObject(namespace, 'deployment', 'oas-crawl4ai')).spec.template.spec;
  assert.equal(app.dnsPolicy, 'None');
  assert.deepEqual(app.dnsConfig.nameservers, ['127.0.0.1']);
  assert.ok(app.containers.some(c => c.name === 'public-dns'));
  assert.ok(!app.containers.find(c => c.name === 'crawl4ai').env.some(v => v.name === 'CRAWL4AI_ALLOW_INTERNAL_URLS'));
  const corefile = (await kubeObject(namespace, 'configmap', 'oas-crawl4ai-dns')).data.Corefile;
  assert.match(corefile, /bind 127\.0\.0\.1/);
  assert.match(corefile, /forward \. tls:\/\/1\.1\.1\.1/);
  assert.match(corefile, /tls_servername cloudflare-dns\.com/);
  const api = await kubeObject(namespace, 'service', 'oas-api');
  const lookup = await capture('kubectl', [...kube,'-n',namespace,'exec','deployment/oas-crawl4ai','-c','crawl4ai','--','python','-c',`import socket; print(socket.gethostbyname('oas-api.${namespace}.svc.${clusterDomain}'))`]);
  assert.equal(lookup.code, 0, lookup.text);
  assert.equal(lookup.text.trim(), api.spec.clusterIP);
  assert.notEqual((await kubeObject(namespace, 'deployment', 'oas-browser')).spec.template.spec.dnsPolicy, 'None');
}

try{
  await mkdir('artifacts',{recursive:true});await save();await writeFile(passwordFile,initialPassword+'\n');
  if(process.env.OAS_FIXTURE_RUNNING!=='1')server=await fixture(Number(new URL(source).port||18780));
  await prove('A25.install',async()=>{await ctl('install');const pods=JSON.parse((await capture('kubectl',[...kube,'--namespace',namespace,'get','pods','-o','json'])).text);assert.ok(pods.items.some(p=>p.metadata.name.includes('oas-api')&&p.status.phase==='Running'));});
  await openForward();
  const response=await fetch(base+'/admin/v1/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:initialUsername,password:initialPassword})});
  assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];csrf=(await response.json()).data.csrf_token;
  await prove('A25.initial_admin_options',async()=>{const wrong=await fetch(base+'/admin/v1/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})});assert.equal(wrong.status,401);const session=await admin('session');assert.equal(session.username,initialUsername);assert.equal(await database("SELECT count(*) FROM administrators"),'1');});
  const native=await admin('endpoints',{name:'Upgrade credential',kind:'search',provider:'tavily',adapter:'http_search',base_url:source+'/requires-key',timeout_ms:8000,max_concurrency:4,rpm:1000,options:{},secret:{api_key:'sample-native-key'}});
  const model=await admin('endpoints',{name:'Fixture model',kind:'model',provider:'openai_compatible',adapter:'chat_model',base_url:source+'/v1',timeout_ms:8000,max_concurrency:4,rpm:1000,options:{model:'fixture',tokenizer:'cl100k_base',max_input_tokens:8192,max_output_tokens:2048}});
  const project=await admin('projects',{name:'Upgrade persistence',search_pools:[[native.id]],reader_pools:[],rewrite_count:0});
  const first=await business(project.api_key,'list',{query:'rainfall'});assert.equal(first.data.items.length,1);
  const browser=await admin('projects',{name:'Stable browser capacity',search_pools:[['00000000-0000-4000-8000-000000000001']],reader_pools:[['00000000-0000-4000-8000-000000000002']],model_endpoint_id:model.id,rewrite_count:0});
  await capacity(2);
  const originalAdmin=await database("SELECT md5(password_hash) FROM administrators WHERE username='"+initialUsername+"'");
  const originalProject=await admin('projects/'+project.project.id);
  const originalSecret=await database("SELECT md5(secret::text) FROM resources WHERE id='"+native.id+"'");
  await prove('A16.combination.00',()=>componentShape(false,false));
  for(const [search,crawl]of [[true,false],[false,true],[true,true]]){
    values.searxng.enabled=search;values.crawl4ai.enabled=crawl;await upgrade();
    assert.equal((await business(project.api_key,'list',{query:'rainfall'})).data.items.length,1);
    await prove('A16.combination.'+Number(search)+Number(crawl),()=>componentShape(search,crawl));
    await available('searxng',search?'available':'component_disabled');
    await available('crawl4ai',crawl?'available':'component_disabled');
    const addon=await admin('projects',{name:'Optional native services',search_pools:search?[['00000000-0000-4000-8000-000000000003']]:[],reader_pools:crawl?[['00000000-0000-4000-8000-000000000004']]:[],model_endpoint_id:model.id,rewrite_count:0});
    retainedAddon=addon;
    if(search)await prove('A16.native_search',async()=>{const result=await business(addon.api_key,'list',{query:'!fixture rainfall'});assert.equal(result.data.items[0].url,source+'/article');});
    if(crawl)await prove('A16.native_reader',async()=>{const result=await business(addon.api_key,'content',{url:source+'/article'});assert.ok(result.data.text.includes('rainfall'));});
    if(search&&crawl)await prove('A16.combined_pipeline',async()=>{const result=await business(addon.api_key,'summary',{query:'!fixture rainfall'});assert.ok(result.data.citations.length);const calls=await callsFor(result.request_id);assert.ok(calls.some(c=>c.endpoint_id==='00000000-0000-4000-8000-000000000003'));assert.ok(calls.some(c=>c.endpoint_id==='00000000-0000-4000-8000-000000000004'));assert.ok(calls.every(c=>!c.browser_job));});
  }
  await prove('A16.crawl4ai_dns', verifyCrawlResolver);
  values.browser.replicas=3;values.searxng.enabled=false;values.crawl4ai.enabled=false;await upgrade();await prove('A22.scale_2_to_3',async()=>assert.equal((await capacity(3)).ready_pods,3));
  await prove('A16.disabled_reference',async()=>{await available('searxng','component_disabled');await available('crawl4ai','component_disabled');const saved=await admin('projects/'+retainedAddon.project.id);assert.deepEqual(saved.search_pools,[['00000000-0000-4000-8000-000000000003']]);assert.deepEqual(saved.reader_pools,[['00000000-0000-4000-8000-000000000004']]);});
  const pods=new Set(),history=[];const readyPods=await readyUids();
  for(let n=0;n<3;n++){
    const result=await business(browser.api_key,'content',{url:source+'/article'});
    for(let i=0;i<40;i++){const calls=await admin('endpoint-calls?request_id='+result.request_id);if(calls.items.length){const uid=calls.items[0].browser_job.pod_uid;pods.add(uid);history.push({id:result.request_id,uid});check('A22.ready_only',()=>assert.ok(readyPods.has(uid)));break;}await pause(100);}
  }
  check('A22.new_capacity',()=>assert.equal(pods.size,3));
  await kubectl('rollout','restart','deployment/oas-browser');await kubectl('rollout','status','deployment/oas-browser','--timeout=120s');await capacity(3);
  const replaced=await business(browser.api_key,'content',{url:source+'/article'});
  for(let i=0;i<60;i++){const calls=await admin('endpoint-calls?request_id='+replaced.request_id);if(calls.items.length){check('A22.rolling_replace',()=>assert.ok(!pods.has(calls.items[0].browser_job.pod_uid)));break;}if(i===59)assert.fail('replacement call not recorded');await pause(100);}

  values.browser.replicas=0;await upgrade();await capacity(0);
  await prove('A22.zero_preserves_refs',async()=>{const saved=await admin('projects/'+browser.project.id);assert.deepEqual(saved.search_pools,[['00000000-0000-4000-8000-000000000001']]);assert.deepEqual(saved.reader_pools,[['00000000-0000-4000-8000-000000000002']]);const r=await fetch(base+'/v1/search/content',{method:'POST',headers:{Authorization:'Bearer '+browser.api_key,'Content-Type':'application/json'},body:JSON.stringify({url:source+'/article'})});assert.equal(r.status,503);});
  assert.equal((await business(project.api_key,'list',{query:'rainfall'})).data.items.length,1);
  values.browser.replicas=2;await upgrade();await prove('A22.restore',async()=>{assert.equal((await capacity(2)).ready_pods,2);assert.ok((await business(browser.api_key,'content',{url:source+'/article'})).data.text.length);});
  await prove('A22.historical_pod',async()=>{for(const row of history){const calls=await callsFor(row.id);assert.equal(calls[0].browser_job.pod_uid,row.uid);}});
  await prove('A25.preserve_config',async()=>assert.deepEqual(await admin('projects/'+project.project.id),originalProject));
  await prove('A25.preserve_key',async()=>assert.equal((await business(project.api_key,'list',{query:'rainfall'})).data.items.length,1));
  await prove('A25.preserve_secret',async()=>assert.equal(await database("SELECT md5(secret::text) FROM resources WHERE id='"+native.id+"'"),originalSecret));
  await prove('A25.preserve_admin_credentials',async()=>{assert.equal(await database("SELECT md5(password_hash) FROM administrators WHERE username='"+initialUsername+"'"),originalAdmin);const login=await fetch(base+'/admin/v1/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:initialUsername,password:initialPassword})});assert.equal(login.status,200);});
  await prove('A25.preserve_history',async()=>assert.equal((await admin('requests/'+first.request_id)).metadata.project_id,project.project.id));
  const checksum=await database("SELECT encode(checksum,'hex') FROM _sqlx_migrations WHERE version=4");
  try{
    await database("UPDATE _sqlx_migrations SET checksum=decode(repeat('00',length(checksum)),'hex') WHERE version=4");
    await prove('A25.migration_failure',async()=>{const failed=await capture(prefix[0],ctlArgs('upgrade','8s'));assert.notEqual(failed.code,0);assert.match(failed.text,/Helm apply\/wait stage failed/);assert.match(failed.text,/migrat|checksum/i);});
  }finally{await database("UPDATE _sqlx_migrations SET checksum=decode('"+checksum+"','hex') WHERE version=4");}
  await upgrade();assert.equal((await business(project.api_key,'list',{query:'rainfall'})).data.items.length,1);
  values.browser.resources={requests:{cpu:'100000',memory:'512Mi'},limits:{memory:'2Gi'}};await save();
  await prove('A25.command_timeout',async()=>{const timeout=await capture(prefix[0],ctlArgs('upgrade','8s'));assert.notEqual(timeout.code,0);assert.match(timeout.text,/Helm apply\/wait stage failed/);assert.match(timeout.text,/timed out|deadline|timeout/i);});
  values.browser.resources=browserTestResources;await upgrade();await capacity(2);
  const inspected=await capture(prefix[0],ctlArgs('status'));check('A25.retry_inspection',()=>{assert.equal(inspected.code,0);assert.match(inspected.text,/deployed/);});
  const diagnosis=await capture(prefix[0],[...ctlArgs('doctor'),'--json']);assert.equal(diagnosis.code,0,diagnosis.text);const doctor=JSON.parse(diagnosis.text);
  check('A25.doctor_service_account',()=>{const checks=doctor.checks.filter(c=>c.check.startsWith('service-account/'));assert.equal(checks.length,3);assert.ok(checks.every(c=>c.status==='ok'));});
  check('A25.doctor_storage',()=>assert.ok(doctor.checks.some(c=>c.check==='postgres-storage'&&c.status==='ok'&&c.message.includes('ownership'))));
  check('A25.doctor_components',()=>{const components=doctor.checks.filter(c=>c.check.startsWith('native-api/'));assert.equal(components.length,2);assert.ok(components.every(c=>c.status==='ok'&&c.message==='component_disabled'));assert.ok(doctor.checks.some(c=>c.check==='schema'&&c.status==='ok'));});

  console.log('Helm installation, optional services, scaling and credential persistence passed');
}finally{
  forward?.kill();server?.closeAllConnections();server?.close();
  await run('helm',[...kube.flatMap((value,index)=>index===0?['--kube-context']:[value]),'uninstall',release,'--namespace',namespace]).catch(()=>{});
  await run('kubectl',[...kube,'delete','namespace',namespace,'--wait=true','--timeout=60s']).catch(()=>{});
  await rm(valuesFile,{force:true});await rm(passwordFile,{force:true});
}
