import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.mjs';
import {settled} from './support.mjs';
import {proxies} from './proxies.mjs';
const base=process.env.OAS_TEST_API||'http://127.0.0.1:18080';
let server,outlets,cookie,csrf;
async function call(path,body,method='POST'){
  const r=await fetch(base+path,{method,headers:{Cookie:cookie||'',Origin:base,'X-CSRF-Token':csrf||'','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value.data;
}
before(async()=>{
  server=await fixture();outlets=await proxies();
  const r=await fetch(base+'/admin/v1/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:process.env.OAS_TEST_PASSWORD||'admin123'})});
  assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];csrf=(await r.json()).data.csrf_token;
});
after(()=>{server?.closeAllConnections();server?.close();outlets?.close();});
test('Firefox uses authenticated SOCKS5 and verified HTTPS proxies as configured',async()=>{
  const entities=await call('/admin/v1/endpoints?limit=100',null,'GET');
  const reader=entities.items.find(e=>e.adapter==='browser_reader');
  for(const [scheme,port]of[['socks5',18781],['https',18782]]){
    const proxy=await call('/admin/v1/proxies',{name:scheme+' fixture',scheme,host:'host.docker.internal',port,auth_mode:'password',secret:{username:'sample',password:'sample-password'},max_concurrency:2,enabled:true});
    assert.equal(proxy.has_secret,true);assert.ok(!JSON.stringify(proxy).includes('sample-password'));
    const pool=await call('/admin/v1/proxy-pools',{name:scheme+' pool',members:[{proxy_id:proxy.id,weight:1}]});
    const made=await call('/admin/v1/projects',{name:scheme+' browser',search_pools:[],reader_pools:[[reader.id]],browser_proxy_pool_id:pool.id});
    const r=await fetch(base+'/v1/search/content',{method:'POST',headers:{Authorization:'Bearer '+made.api_key,'Content-Type':'application/json'},body:JSON.stringify({url:'http://host.docker.internal:18780/article'})});
    const result=await r.json();assert.equal(r.status,200,scheme+' '+JSON.stringify(outlets.count)+' '+JSON.stringify(result));assert.ok(result.data.text.includes('rainfall'));
    await settled(base,result.request_id,{Cookie:cookie});
    const calls=await call('/admin/v1/endpoint-calls?request_id='+result.request_id,null,'GET');
    assert.equal(calls.items[0].browser_job.proxy_id,proxy.id);assert.equal(calls.items[0].browser_job.scheme,scheme);
  }
  assert.ok(outlets.count.socks>0);assert.ok(outlets.count.https>0);
});
