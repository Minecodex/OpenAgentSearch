import {test,before,after} from 'node:test';
import {assert,prove} from './proof.mjs';
import {createRequire} from 'node:module';
import {existsSync,mkdirSync} from 'node:fs';
import {base,upstream,server,cookie,setup,close,admin,endpoint,project,business,recorded,editable} from './context.mjs';
const require=createRequire(new URL('../../web/package.json',import.meta.url));
const {chromium}=require('playwright-core');
let browser;
const errors=[];
before(async()=>{
 await setup();
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium'].find(existsSync)});
});
after(async()=>{await browser?.close();close();assert.deepEqual(errors,[]);});
async function trace(result){await recorded(result.request_id);return admin('requests/'+result.request_id+'/export');}
function assertListSummary(result,exported){
 assert.equal(result.status,'success');
 assert.deepEqual(result.warnings,[]);
 assert.equal(result.data.sources.length,1);
 assert.equal(result.data.sources[0].kind,'snippet');
 assert.ok(result.data.citations.length>0);
 assert.ok(result.data.citations.every(c=>result.data.sources.some(s=>s.id===c.source_id)));
 assert.equal(exported.request.snapshot.project.summary_snippets_only,true);
 assert.ok(exported.calls.some(c=>c.stage==='score'));
 assert.ok(exported.calls.some(c=>c.stage==='synthesis'));
 assert.ok(!exported.calls.some(c=>c.kind==='reader'));
 const material=exported.evidence.candidates.find(c=>c.material==='search_snippet');
 assert.ok(material);
 assert.deepEqual(material.reader_call_ids,[]);
 assert.ok(material.article_preview.includes('Rainfall field guide'));
 assert.ok(material.article_preview.includes('A rain gauge measures rainfall.'));
}

test('search-list synthesis needs no reader pool and preserves scoring, citations and original material',()=>prove('P02.snippet_evidence',async()=>{
 const made=await project({summary_snippets_only:true,reader_pools:[],allow_snippets:false});
 assert.equal(made.project.summary_snippets_only,true);
 assert.equal((await admin('projects/'+made.project.id)).summary_snippets_only,true);
 const start=server.requests.length;
 const result=await business(made,'summary',{query:'rainfall',source_count:1});
 assertListSummary(result,await trace(result));
 assert.ok(!server.requests.slice(start).some(r=>r.path.includes('extract')||r.path==='/article'));
}));

test('integrated search turns off inline full bodies when the project selects search-list synthesis',async()=>{
 for(const provider of ['tavily','deepseek']){
  const search=await endpoint('search','',{provider,adapter:'integrated_search'});
  const made=await project({summary_snippets_only:true,reader_pools:[]},{search});
  const start=server.requests.length;
  const result=await business(made,'summary',{query:'rainfall',source_count:1});
  assertListSummary(result,await trace(result));
  const sent=server.requests.slice(start).find(r=>provider==='tavily'?r.path==='/search':r.path==='/v1/tools/search');
  assert.ok(sent);
  assert.equal(sent.input[provider==='tavily'?'include_raw_content':'need_content'],false);
 }
});

test('switching the project restores extraction and leaves historical snapshots and standalone APIs accurate',async()=>{
 const made=await project({summary_snippets_only:true,allow_snippets:false});
 const first=await business(made,'summary',{query:'rainfall',source_count:1});
 assertListSummary(first,await trace(first));
 let current=await admin('projects/'+made.project.id);
 current=await admin('projects/'+current.id,{...editable(current),summary_snippets_only:false},'PUT');
 const start=server.requests.length;
 const regular=await business(made,'summary',{query:'rainfall',source_count:1});
 assert.equal(regular.status,'success');
 assert.equal(regular.data.sources[0].kind,'body');
 assert.equal(server.requests.slice(start).filter(r=>r.path==='/v1/extract').length,1);
 assert.equal((await trace(regular)).request.snapshot.project.summary_snippets_only,false);
 current=await admin('projects/'+current.id,{...editable(current),summary_snippets_only:true},'PUT');
 assert.equal((await trace(first)).request.snapshot.project.summary_snippets_only,true);
 const list=await business(made,'list',{query:'rainfall'});
 assert.ok(list.data.items.length>0);
 const articleStart=server.requests.length;
 const article=await business(made,'content',{url:upstream+'/article'});
 assert.equal(article.status,'success');
 assert.ok(article.data.text.includes('Rainfall measurements'));
 assert.equal(server.requests.slice(articleStart).filter(r=>r.path==='/v1/extract').length,1);
 const final=await business(made,'summary',{query:'rainfall',source_count:1});
 assertListSummary(final,await trace(final));
});

test('project defaults preserve article synthesis and only accept a boolean material switch',async()=>{
 const made=await project();
 assert.equal(made.project.summary_snippets_only,false);
 for(const value of [null,'true',1])await admin('projects',{name:'Invalid material policy',search_pools:[],reader_pools:[],summary_snippets_only:value},'POST',400);
});

test('project create and edit expose a persistent HeroUI switch in both languages and themes',async()=>{
 for(const language of ['zh','en'])for(const theme of ['light','dark']){
  const en=language==='en';
  const context=await browser.newContext({viewport:{width:1440,height:1100},colorScheme:theme,reducedMotion:'reduce'});
  try{
   await context.addCookies([{name:'oas_admin_session',value:cookie.slice(cookie.indexOf('=')+1),url:base,httpOnly:true,sameSite:'Strict'}]);
   await context.addInitScript(({language,theme})=>{localStorage.setItem('oas-language',language);localStorage.setItem('oas-theme',theme);},{language,theme});
   const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
   await page.goto(base+'/projects');
   await page.getByRole('button',{name:en?'Create':'新建',exact:true}).click();
   const dialog=page.getByRole('dialog');
   const label=en?'Summarize search results only':'直接使用搜索列表总结';
   const toggle=dialog.getByRole('switch',{name:label,exact:true});
   assert.equal(await toggle.isChecked(),false);
   await dialog.getByText(label,{exact:true}).click();
   assert.equal(await toggle.isChecked(),true);
   await toggle.focus();await page.keyboard.press('Space');
   assert.equal(await toggle.isChecked(),false);
   await dialog.getByText(label,{exact:true}).click();
   assert.equal(await toggle.isChecked(),true);
   assert.equal(await dialog.getByRole('checkbox',{name:en?'Allow snippets after ordinary extraction failure':'普通取文失败时允许使用简介',exact:true}).isDisabled(),true);
   assert.ok(await dialog.getByLabel(en?'Search material character limit':'搜索材料字数上限',{exact:true}).isVisible());
   const name='Search-list UI '+language+' '+theme;
   await dialog.getByLabel(en?'Name':'名称',{exact:true}).fill(name);
   mkdirSync('artifacts',{recursive:true});
   await page.screenshot({path:'artifacts/project-snippets-'+language+'-'+theme+'.png'});
   const created=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/admin/v1/projects');
   await dialog.getByRole('button',{name:en?'Save':'保存',exact:true}).click();
   const creation=await created;assert.equal(creation.status(),201);
   const saved=(await creation.json()).data.project;
   assert.equal(saved.summary_snippets_only,true);
   await page.getByRole('heading',{name:en?'Save project key':'保存项目密钥',exact:true}).waitFor();
   await page.getByRole('dialog').getByRole('button',{name:en?'Close':'关闭',exact:true}).last().click();
   await page.getByLabel(en?'Find by name':'按名称查找',{exact:true}).fill(name);
   const card=page.locator('.project-card').filter({hasText:name});
   await card.getByRole('button',{name:en?'Edit':'编辑',exact:true}).click();
   assert.equal(await toggle.isChecked(),true);
   await dialog.getByText(label,{exact:true}).click();
   assert.equal(await toggle.isChecked(),false);
   const updated=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname==='/admin/v1/projects/'+saved.id);
   await dialog.getByRole('button',{name:en?'Save':'保存',exact:true}).click();
   assert.equal((await updated).status(),200);
   assert.equal((await admin('projects/'+saved.id)).summary_snippets_only,false);
   await page.getByRole('dialog').waitFor({state:'hidden'});
   await card.getByRole('button',{name:en?'Edit':'编辑',exact:true}).click();
   assert.equal(await toggle.isChecked(),false);
   assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
  }finally{await context.close();}
 }
});
