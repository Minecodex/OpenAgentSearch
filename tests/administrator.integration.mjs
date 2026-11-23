import {test} from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
import {assert,prove} from './acceptance/proof.mjs';
const base=process.env.OAS_TEST_API||'http://127.0.0.1:18080';
const original=process.env.OAS_TEST_PASSWORD||'admin123';
const container=process.env.OAS_TEST_SERVER;
function reset(pass){assert.match(container||'',/^oas-local-[a-f0-9]{8}-api$/);return new Promise((resolve,reject)=>{const child=spawn('docker',['exec','-i',container,'/app/oas-server','reset-admin-password'],{stdio:['pipe','pipe','pipe']});let text='';child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b);child.stdin.end(pass+'\n');child.once('error',reject);child.once('exit',code=>code===0?resolve(text):reject(Error('Administrator reset failed: '+text)));});}
async function login(pass) {
 const deadline=Date.now()+65_000;
 for (;;) {
  const response=await fetch(base+'/admin/v1/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:pass})});
  if(response.status!==429 || Date.now()>=deadline) return response;
  await response.body?.cancel();
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
}
test('explicit administrator reset revokes passwords and sessions and initialization never resets an existing account',async()=>{
 const before=await login(original);assert.equal(before.status,200);const oldCookie=before.headers.get('set-cookie').split(';')[0];
 try{await prove('A02.admin_password_reset',async()=>{
  const output=await reset('changed123');assert.ok(!output.includes('changed123'));assert.equal((await login(original)).status,401);
  assert.equal((await fetch(base+'/admin/v1/session',{headers:{Cookie:oldCookie}})).status,401);assert.equal((await login('changed123')).status,200);
  const restart=spawnSync('docker',['restart',container],{encoding:'utf8'});assert.equal(restart.status,0,restart.stderr);
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/health/ready')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  assert.equal((await login('changed123')).status,200);assert.equal((await login(original)).status,401);
 });}finally{await reset(original);assert.equal((await login(original)).status,200);}
});
