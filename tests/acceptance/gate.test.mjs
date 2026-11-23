import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validate} from './gate.mjs';
import {prove} from './proof.mjs';

test('subitem proof requires an executed assertion',async()=>{
 await assert.rejects(prove('A01.only_three',()=>{}),/real assertion/);
});

test('the acceptance gate rejects incomplete, stale and unbound evidence',async()=>{
 await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/gate-test-'));
 const hash='fixture-source-fingerprint';const source=pathToFileURL(resolve('tests/acceptance/gate.test.mjs')).href+':1:1';
 const event={version:1,run_id:'fixture',fingerprint:hash,suite:'docker',id:'required',status:'passed',assertions:1,source};
 const images=['api','browser','web'].map(image=>({image,id:'fixture-'+image,fingerprint:hash}));
 const docker={version:2,completed:true,suite:'docker',suites:['database','docker','rust'],run_id:'fixture',directory,fingerprint:hash,full:true,images,assertions:[{path:'docker.jsonl'}]};
 const kubernetes={...docker,suite:'kubernetes',suites:['kubernetes'],assertions:[{path:'kube.jsonl'}]};
 const options={root:process.cwd(),fingerprint:hash,catalog:{items:[{id:'required'}]},metadata:[docker,kubernetes]};
 async function files(a=event,b={...event,suite:'kubernetes'}){await writeFile(resolve(directory,'docker.jsonl'),JSON.stringify(a)+'\n');await writeFile(resolve(directory,'kube.jsonl'),JSON.stringify(b)+'\n');}
 try{
  await files();assert.equal((await validate(options)).length,1);
  for(const [patch,message]of [[{version:1},/Old aggregate/],[{completed:false},/did not complete/],[{fingerprint:'old'},/fingerprint mismatch/],[{full:false},/partial Docker/],[{images:[]},/Three tested/],[{images:images.map(i=>({...i,fingerprint:'old'}))},/image source/]])await assert.rejects(validate({...options,metadata:[{...docker,...patch},kubernetes]}),message);
  for(const [patch,message]of [[{fingerprint:'old'},/Stale assertion/],[{status:'failed'},/assertion failed/],[{assertions:0},/no executed assertion/],[{id:'unknown'},/Unknown acceptance/],[{source:source.replace(':1:1',':9999999:1')},/does not exist/],[{source:pathToFileURL(resolve('../outside.mjs')).href+':1:1'},/outside the source/]]){await files({...event,...patch});await assert.rejects(validate(options),message);}
  await files();await assert.rejects(validate({...options,catalog:{items:[{id:'required'},{id:'missing'}]}}),/subitems are missing/);
  await assert.rejects(validate({...options,metadata:[docker]}),/Both Docker and Kubernetes/);
  await assert.rejects(validate({...options,metadata:[{...docker,assertions:[{path:'../escape.jsonl'}]},kubernetes]}),/escaped/);
  await assert.rejects(validate({...options,catalog:{items:[{id:'required',required_suites:['database']}]}}),/Missing required suite/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
