import {assert,check,prove} from './proof.mjs';
import {sql,setup,close,admin,base} from './context.mjs';
if(process.argv[2]==='before'){
 check('A15.empty_database',()=>assert.equal(sql("SELECT count(*) FROM pg_tables WHERE schemaname='public';"),'0'));
}else{
 try{await setup();await prove('A15.empty_database',async()=>{
  assert.equal((await fetch(base+'/health/ready')).status,200);
  assert.equal(sql('SELECT count(*) FROM administrators;'),'1');
  if(process.env.OAS_BOOTSTRAP_DEFAULT_ADMIN==='1')check('A15.default_admin',()=>{assert.equal(process.env.OAS_TEST_PASSWORD,'admin123');assert.equal(sql('SELECT username FROM administrators;'),'admin');});
  assert.equal((await admin('projects')).items.length,0);
  const endpoints=(await admin('endpoints?limit=100')).items;
  assert.ok(endpoints.some(e=>e.id==='00000000-0000-4000-8000-000000000001'&&e.adapter==='browser_search'));
  assert.ok(endpoints.some(e=>e.id==='00000000-0000-4000-8000-000000000002'&&e.adapter==='browser_reader'));
 });}finally{close();}
}
