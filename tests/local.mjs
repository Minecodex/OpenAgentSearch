// Isolated Docker acceptance stack. Every owned container, volume and image is
// removed in finally, including when a test fails. Requires Node 24 and Docker.
import {spawn,spawnSync} from 'node:child_process';
import {createWriteStream,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fingerprint} from './acceptance/fingerprint.mjs';
import {execFileSync} from 'node:child_process';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
process.chdir(root);
const tag='oas-local-'+randomBytes(4).toString('hex'), network=tag+'-net';
const names=Object.fromEntries(['db','api','browser','web'].map(k=>[k,tag+'-'+k]));
const images=Object.fromEntries(['api','browser','web'].map(k=>[k,tag+':'+k]));
const api=process.env.OAS_TEST_API||'http://127.0.0.1:18080';const port=new URL(api).port||'18080';
const password=process.env.OAS_TEST_PASSWORD||'admin123';
const artifacts=resolve('artifacts/local-'+tag);
const cert=(name)=>resolve(artifacts,name);
const run=(program,args,env={},log)=>new Promise((resolve,reject)=>{
  const sink=log?createWriteStream(log):null;
  const child=spawn(program,args,{cwd:root,stdio:log?['ignore','pipe','pipe']:'inherit',env:{...process.env,...env}});
  if(sink){child.stdout.on('data',b=>{process.stdout.write(b);sink.write(b);});child.stderr.on('data',b=>{process.stderr.write(b);sink.write(b);});}
  child.once('error',reject);child.once('exit',code=>{const done=()=>code===0?resolve():reject(new Error(program+' exited '+code));if(sink)sink.end(done);else done();});
});
const docker=(...args)=>run('docker',args);
const npm=(...args)=>process.platform==='win32'?run(process.execPath,[resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),...args]):run('npm',args);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function ready(url){for(let n=0;n<120;n++){try{const r=await fetch(url,{signal:AbortSignal.timeout(1000)});if(r.ok)return;}catch{}await wait(500);}throw Error('Service not ready: '+url);}
let failed,createdBuilder=false,sourceFingerprint,completed=false;const proofFiles=[];const imageEvidence=[];
const builder=process.env.OAS_BUILD_CONTAINER||tag+'-build';
const reports=resolve('artifacts/acceptance-'+tag);
try{
  await mkdir(artifacts,{recursive:true});
  await mkdir(reports,{recursive:true});
  if(!process.env.OAS_TEST_FILES&&!process.env.OAS_TEST_PATTERN)await rm('artifacts/acceptance-subset.json',{force:true});
  await npm('--prefix','web','ci');
  await run(process.execPath,[resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),'--prefix','web','test'],{},resolve(reports,'web-unit.log'));
  await run(process.execPath,['--test','tests/acceptance/gate.test.mjs']);
  await run(process.execPath,['--test','tests/native-extension.test.mjs']);
  await npm('--prefix','web','run','generate');
  sourceFingerprint=await fingerprint(root);
  await mkdir(reports,{recursive:true});
  await docker('network','create',network);
  if(!process.env.OAS_BUILD_CONTAINER){
    const registry=resolve(homedir(),'.cargo/registry');
    await docker('run','-d','--name',builder,'--label','oas.task='+tag,'-v',root+':/work',...(existsSync(registry)?['-v',registry+':/usr/local/cargo/registry']:[]),'-e','CARGO_TARGET_DIR=/work/target/linux','-w','/work','rust:1.97.1-slim-bookworm','sleep','3600');createdBuilder=true;
    await docker('exec',builder,'rustup','component','add','clippy');
  }
  await docker('exec',builder,'rustup','component','add','clippy','rustfmt');
  await docker('exec',builder,'cargo','fmt','--all','--check');
  await docker('exec',builder,'cargo','clippy','--workspace','--all-targets','--','-D','warnings');
  const unitProof=resolve(reports,'unit.assertions.jsonl');proofFiles.push({path:'unit.assertions.jsonl'});
  const linuxProof='/work/'+relative(root,unitProof).replaceAll('\\','/');
  await run('docker',['exec','-e','OAS_SOURCE_FINGERPRINT='+sourceFingerprint,'-e','OAS_RUN_ID='+tag,'-e','OAS_SUITE=rust','-e','OAS_ASSERTIONS_FILE='+linuxProof,builder,'cargo','test','--workspace'],{},resolve(reports,'unit.log'));


  for(const target of ['api','browser','web']){
    for(let attempt=0;attempt<3;attempt++){
      try{await docker('build','-f','deploy/Dockerfile','--target',target,'--build-arg','CARGO_BUILD_JOBS='+ (process.env.CARGO_BUILD_JOBS||'2'),'--label','org.openagentsearch.source='+sourceFingerprint,'-t',images[target],'.');break;}
      catch(error){if(attempt===2)throw error;await wait(2000);}
    }
  }
  for(const image of Object.values(images)){const found=JSON.parse(execFileSync('docker',['image','inspect',image],{encoding:'utf8'}))[0];imageEvidence.push({image,id:found.Id,fingerprint:found.Config.Labels?.['org.openagentsearch.source']});}
  // Fixture CA is trusted only by the disposable worker. TLS validation stays on.
  const openssl=(...args)=>docker('run','--rm','-v',artifacts+':/cert','--entrypoint','openssl',images.api,...args);
  await openssl('req','-x509','-newkey','rsa:2048','-nodes','-keyout','/cert/proxy-ca-key.pem','-out','/cert/proxy-ca-cert.pem','-days','2','-subj','/CN=OAS local fixture CA','-addext','basicConstraints=critical,CA:TRUE');
  await openssl('req','-newkey','rsa:2048','-nodes','-keyout','/cert/proxy-key.pem','-out','/cert/proxy.csr','-subj','/CN=host.docker.internal');
  await writeFile(cert('proxy-leaf.ext'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:host.docker.internal\n');
  await openssl('x509','-req','-in','/cert/proxy.csr','-CA','/cert/proxy-ca-cert.pem','-CAkey','/cert/proxy-ca-key.pem','-CAcreateserial','-out','/cert/proxy-cert.pem','-days','2','-extfile','/cert/proxy-leaf.ext');
  await docker('run','-d','--name',names.db,'--network',network,'-e','POSTGRES_DB=oas','-e','POSTGRES_USER=oas','-e','POSTGRES_PASSWORD=oas-local-only','postgres:18.6-alpine');
  for(let n=0;n<120;n++){
    try{execFileSync('docker',['exec',names.db,'pg_isready','-h','127.0.0.1','-U','oas','-d','oas'],{stdio:'ignore'});break;}
    catch(error){if(n===119)throw error;await wait(500);}
  }
  const bootstrapEnv={OAS_TEST_DB:names.db,OAS_SUITE:'docker',OAS_SOURCE_FINGERPRINT:sourceFingerprint,OAS_RUN_ID:tag,OAS_ASSERTIONS_FILE:resolve(reports,'bootstrap.assertions.jsonl')};proofFiles.push({path:'bootstrap.assertions.jsonl'});
  await run(process.execPath,['tests/acceptance/bootstrap.mjs','before'],bootstrapEnv);
  const common=['--label','oas.test.run='+tag,'--network',network,'--add-host','host.docker.internal:host-gateway','--add-host','wrong-proxy.test:host-gateway'];
  const workerKey=randomBytes(24).toString('hex');
  await docker('run','-d','--name',names.browser,...common,'--shm-size=512m','-v',cert('proxy-ca-cert.pem')+':/app/test-ca.pem:ro',
    '-e','OAS_PROXY_TEST_URL=http://host.docker.internal:18780/probe','-e','OAS_PROXY_TEST_EXPECTED_BODY=oas-probe-ok','-e','SSL_CERT_FILE=/app/test-ca.pem','-e','OAS_WORKER_KEY='+workerKey,'-e','POD_UID=local-worker','-e','OAS_WORKER_SLOTS=4','-e','OAS_NATIVE_DEBUG='+(process.env.OAS_TEST_NATIVE_DEBUG||'0'),'-e','OAS_EGRESS_ALLOW_HOSTS=host.docker.internal',
    '-e','OAS_TEST_GOOGLE_ORIGIN=http://host.docker.internal:18780','-e','OAS_TEST_BAIDU_ORIGIN=http://host.docker.internal:18780','-e','OAS_TEST_GOOGLE_PROBE_URL=http://host.docker.internal:18780/probe',images.browser);
  await docker('run','-d','--name',names.api,...common,'-e','DATABASE_URL=postgres://oas:oas-local-only@'+names.db+':5432/oas',
    '-e','OAS_MASTER_KEY='+randomBytes(32).toString('hex'),'-e','OAS_WORKER_KEY='+workerKey,...(process.env.OAS_TEST_PASSWORD?['-e','OAS_ADMIN_PASSWORD='+password]:[]),'-e','OAS_PUBLIC_ORIGIN='+api,
    '-e','OAS_WORKERS='+JSON.stringify([{uid:'local-worker',name:'worker-a',address:'http://'+names.browser+':8090',slots:4}]),
    '-e','OAS_HISTORY_GC_SECONDS=3600','-e','OAS_PROXY_TEST_URL=http://host.docker.internal:18780/probe','-e','OAS_EGRESS_ALLOW_HOSTS=host.docker.internal',images.api);
  await docker('run','-d','--name',names.web,...common,'-p',port+':80','-e','OAS_API_HOST='+names.api,images.web);
  await ready(api+'/health/ready');
  const env={OAS_TEST_API:api,OAS_TEST_PASSWORD:password,OAS_PROXY_FIXTURE_DIR:artifacts,OAS_TEST_DB:names.db,OAS_TEST_BROWSER:names.browser,OAS_TEST_BROWSER_IMAGE:images.browser,OAS_TEST_SERVER:names.api,OAS_TEST_WORKER_KEY:workerKey,OAS_BOOTSTRAP_DEFAULT_ADMIN:process.env.OAS_TEST_PASSWORD?'0':'1'};
  await run(process.execPath,['tests/acceptance/bootstrap.mjs','after'],{...env,...bootstrapEnv});
  for(const test of (process.env.OAS_TEST_FILES?.split(',')||['integration.mjs','deepseek.integration.mjs','regression.integration.mjs','browser.integration.mjs','native-browser.integration.mjs','browser-reaping.integration.mjs','proxy.integration.mjs','web.e2e.mjs','acceptance/api.mjs','acceptance/project-snippets.mjs','acceptance/history.mjs','acceptance/browser.mjs','acceptance/ui.mjs','administrator.integration.mjs'])){
    const file=test.replaceAll('/','-')+'.assertions.jsonl';
    if(test.startsWith('acceptance/')||test==='administrator.integration.mjs')proofFiles.push({path:file});
    await run(process.execPath,['--test',...(process.env.OAS_TEST_PATTERN?['--test-name-pattern='+process.env.OAS_TEST_PATTERN]:[]),'--test-reporter=spec','--test-reporter=tap','--test-reporter-destination=stdout','--test-reporter-destination='+resolve(reports,test.replaceAll('/','-')+'.tap'),'tests/'+test],{...env,OAS_SUITE:'docker',OAS_SOURCE_FINGERPRINT:sourceFingerprint,OAS_RUN_ID:tag,OAS_ASSERTIONS_FILE:resolve(reports,file)});
  }

  if(builder){
    await docker('network','connect',network,builder);
    try{proofFiles.push({path:'storage.assertions.jsonl'});await run('docker',['exec','-e','OAS_SOURCE_FINGERPRINT='+sourceFingerprint,'-e','OAS_RUN_ID='+tag,'-e','OAS_SUITE=database','-e','OAS_ASSERTIONS_FILE=/work/'+relative(root,resolve(reports,'storage.assertions.jsonl')).replaceAll('\\','/'),'-e','OAS_TEST_DATABASE_URL=postgres://oas:oas-local-only@'+names.db+':5432/oas',builder,'cargo','test','-p','oas-adapters','--features','database-tests','--test','storage','--test','administrators'],{},resolve(reports,'storage.log'));}
    finally{await docker('network','disconnect',network,builder);}
  }
  await run(process.env.PYTHON||'python',['tests/contracts.py'],{...env,...(existsSync(resolve("artifacts/python-deps"))?{PYTHONPATH:resolve("artifacts/python-deps")}: {})});
  if(await fingerprint(root)!==sourceFingerprint)throw Error('Source changed while tests were running');
  completed=true;

}catch(error){failed=error;}
finally{
  if(failed)for(const name of [names.api,names.browser]){
    const logs=spawnSync('docker',['logs','--tail','500',name],{encoding:'utf8',timeout:5000});
    await writeFile(resolve(reports,name+'.log'),(logs.stdout||'')+'\n'+(logs.stderr||''));
  }
  if(createdBuilder)await docker('rm','-fv',builder).catch(()=>{});
  for(const name of Object.values(names).reverse())await docker('rm','-fv',name).catch(()=>{});
  await docker('network','rm',network).catch(()=>{});
  for(const image of Object.values(images))await docker('image','rm',image).catch(()=>{});
  if(dirname(artifacts)!==resolve(root,'artifacts'))throw Error('Unexpected artifact path');
  await rm(artifacts,{recursive:true,force:true});
  if(completed)await writeFile((process.env.OAS_TEST_FILES||process.env.OAS_TEST_PATTERN)?'artifacts/acceptance-subset.json':'artifacts/acceptance-docker.json',JSON.stringify({version:2,suite:'docker',suites:['rust','database','docker'],run_id:tag,fingerprint:sourceFingerprint,directory:reports,report_directory:reports,full:!process.env.OAS_TEST_FILES&&!process.env.OAS_TEST_PATTERN,completed:true,assertions:proofFiles,images:imageEvidence},null,2));

}
if(failed)throw failed;
