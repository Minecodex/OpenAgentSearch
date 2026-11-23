import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,stat,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,sep,extname} from 'node:path';
import {createRequire} from 'node:module';
import {traceFixture} from './fixtures/trace.mjs';

const {chromium}=createRequire(new URL('../web/package.json',import.meta.url))('playwright-core');
const fixture=traceFixture(),dist=resolve('web/dist');
let server,browser,base;
const errors=[];
before(async()=>{
 server=http.createServer(async(req,res)=>{
   let file=resolve(dist,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
   const info=file.startsWith(dist+sep)?await stat(file).catch(()=>null):null;
   if(!info?.isFile())file=resolve(dist,'index.html');
   const types={'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.json':'application/json'};
   res.writeHead(200,{'Content-Type':types[extname(file)]||'text/html'});
   res.end(await readFile(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||
   ['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium'].find(existsSync)});
});
after(async()=>{await browser?.close();server?.closeAllConnections();server?.close();assert.deepEqual(errors,[]);});

async function pageFor(language='zh',theme='light',width=1440,overrides={}) {
 const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
 await context.addInitScript(({language,theme})=>{if(window.top===window){localStorage.setItem('oas-language',language);localStorage.setItem('oas-theme',theme);}},{language,theme});
 const page=await context.newPage();page.setDefaultTimeout(10000);
 page.on('pageerror',error=>errors.push(error.message));
 const layoutReads=[];
 await page.route('**/admin/v1/**',async route=>{
   const path=new URL(route.request().url()).pathname.replace('/admin/v1/','');
   let data;
   if(path==='session')data={username:'fixture',csrf_token:'fixture-token',expires_at:'2030-01-01T00:00:00Z'};
   else if(['projects','endpoints','proxies','proxy-pools'].includes(path)){
     data={items:path==='projects'?[fixture.project]:[],next_cursor:null};
   }else if(path==='endpoint-calls')data={items:overrides.calls||fixture.calls,next_cursor:null};
   else if(path==='requests/'+fixture.id)data=overrides.record||fixture.record;
   else if(path.endsWith('/evidence'))data=overrides.evidence||fixture.evidence;
   else if(path.includes('/spans/'))data=(overrides.payloads||fixture.payloads)[decodeURIComponent(path.split('/spans/')[1])];
   else if(path.endsWith('/layout')){layoutReads.push(path);data=overrides.layout||fixture.layout;}
   else throw Error('Unexpected trace API request '+path);
   await route.fulfill({json:{request_id:'fixture',status:'success',data,warnings:[],error:null}});
 });
 await page.goto(base+'/requests/'+fixture.id);
 await page.locator('.stage-list .step-pick').first().waitFor();
 return {page,context,layoutReads};
}
async function stage(page,key){
 await page.locator('.stage-list [data-stage='+key+']').click();
 await page.waitForFunction(key=>document.querySelector('.stage-list [data-stage="'+key+'"]')?.getAttribute('aria-pressed')==='true',key);
}

test('execution tabs retain each outcome and duration, including URL-selected failed attempts',async()=>{
 const {page:p,context}=await pageFor();
 try{
   await stage(p,'search');
   const tabs=p.getByRole('tablist',{name:'本阶段的执行'}).getByRole('tab');
   assert.equal(await tabs.count(),3);
   assert.ok(await tabs.evaluateAll(es=>es.every(e=>Math.abs(e.getBoundingClientRect().top-es[0].getBoundingClientRect().top)<1)));
   assert.equal(await tabs.first().evaluate(e=>getComputedStyle(e.closest('.execution-tab-container')).borderTopLeftRadius),'0px');
   assert.ok((await p.locator('.stage-heading .state-chip').innerText()).includes('部分完成'));
   assert.equal(await p.getByRole('button',{name:'本阶段的执行',exact:true}).count(),0);
   assert.match(await tabs.nth(0).innerText(),/第1次.*搜索甲/s);
   assert.match(await tabs.nth(0).innerText(),/失败.*5 毫秒/s);
   assert.match(await tabs.nth(1).innerText(),/成功.*15 毫秒/s);
   assert.ok(await tabs.nth(1).evaluate(e=>{
     const tab=e.getBoundingClientRect(),meta=e.querySelector('.execution-tab-meta').getBoundingClientRect();
     return meta.top>=tab.top && meta.bottom<=tab.bottom && e.closest('[role="tablist"]').clientHeight>=tab.height;
   }));
   const rgb=await tabs.nth(1).locator('.state-chip').evaluate(e=>getComputedStyle(e).color.match(/\d+/g).map(Number));
   assert.ok(rgb[1]>rgb[0]&&rgb[1]>rgb[2]);
   const red=await tabs.nth(0).locator('.state-chip').evaluate(e=>getComputedStyle(e).color.match(/\d+/g).map(Number));
   assert.ok(red[0]>red[1]&&red[0]>red[2]);
   await tabs.nth(1).click();assert.ok(p.url().includes('stage=search-good'));
   await p.reload();await tabs.nth(1).waitFor();
   assert.equal(await tabs.nth(1).getAttribute('aria-selected'),'true');
   await tabs.nth(0).click();
   assert.ok((await p.locator('.stage-inspect').innerText()).includes('搜索或访问受到风控限制'));
 }finally{await context.close();}
});

test('candidate scoring lists every title and final selection with selected rows first',async()=>{
 const {page:p,context}=await pageFor();
 try{
   await stage(p,'score');
   const rows=p.locator('.candidate-scoring tbody tr');
   await rows.first().waitFor();assert.equal(await rows.count(),4);
   assert.ok((await rows.nth(0).innerText()).includes('雨量计说明'));
   assert.ok((await rows.nth(1).innerText()).includes('观测站记录'));
   assert.equal(await rows.nth(0).getAttribute('data-evidence-selected'),'true');
   assert.ok((await rows.nth(0).innerText()).includes('90 / 100'));
   assert.ok((await rows.nth(2).innerText()).includes('超出来源数量上限'));
   assert.ok(await rows.nth(2).locator('.source-address').evaluate(e=>
     e.getBoundingClientRect().right<=e.closest('td').getBoundingClientRect().right));
   await rows.nth(0).getByRole('button',{name:'雨量计说明',exact:true}).click();
   await p.locator('.inspect-sheet').waitFor();
 }finally{await context.close();}
});

test('webpage materials group readers by page and load the successful archive inline',async()=>{
 const {page:p,context,layoutReads}=await pageFor();
 try{
   await stage(p,'materials');
   assert.equal(await p.locator('.stage-list [data-stage=source],.stage-list [data-stage=extract]').count(),0);
   const pages=p.getByRole('tablist',{name:'网页材料',exact:true}).getByRole('tab');
   assert.equal(await pages.count(),2);
   assert.ok((await pages.first().innerText()).includes('雨量计说明'));
   const attempts=p.getByRole('tablist',{name:'取文尝试',exact:true}).getByRole('tab');
   assert.equal(await attempts.count(),2);
   assert.equal(await attempts.nth(1).getAttribute('aria-selected'),'true');
   assert.ok((await attempts.nth(1).innerText()).includes('正文乙'));
   const frame=p.frameLocator('.stage-inspect iframe');
   await frame.getByRole('heading',{name:'归档雨量计页面'}).waitFor();
   assert.equal(layoutReads.length,1);
   assert.equal(await p.locator('.stage-inspect iframe').getAttribute('sandbox'),'');
   assert.equal(await p.getByRole('dialog').count(),0);
   const formats=p.getByRole('tablist',{name:'归档格式'}).getByRole('tab');
   assert.equal(await formats.count(),5);
   assert.ok(await formats.nth(4).evaluate(e=>e.getBoundingClientRect().top===e.parentElement.firstElementChild.getBoundingClientRect().top));
   assert.equal(await frame.getByAltText('归档图片不可用').count(),1);
   await p.getByRole('tab',{name:'Markdown 预览',exact:true}).click();
   assert.ok((await p.locator('.material-preview .markdown').innerText()).includes('记录降水'));
   await attempts.nth(0).click();
   assert.equal(await p.locator('.stage-inspect iframe').count(),0);
   assert.ok((await p.locator('.stage-inspect').innerText()).includes('上游响应超时'));
   await p.reload();await attempts.first().waitFor();
   assert.equal(await attempts.first().getAttribute('aria-selected'),'true');
   await pages.nth(1).click();await p.waitForFunction(()=>location.search.includes('read-station'));
   assert.equal(await attempts.count(),1);
   assert.ok((await p.locator('.web-material-page').innerText()).includes('阶段处理时限已用尽'));
   assert.equal(await p.locator('.stage-inspect iframe').count(),0);
 }finally{await context.close();}
});

test('inline search articles render without inventing a reader attempt',async()=>{
 const record=structuredClone(fixture.record),evidence=structuredClone(fixture.evidence);
 const root={span_id:'inline-root',stage:'source',status:'success',duration_ms:2,start_offset_ms:34};
 record.spans=[record.spans[0],root];
 evidence.candidates=[{...evidence.candidates[1],material:'inline_body'}];
 const material=fixture.payloads['read-success'].replay[0];
 const payloads={'inline-root':{span:root,input:{candidate_id:'c2',source_id:'s1',url:material.url},output:{segments:1},replay:[material]}};
 const {page:p,context}=await pageFor('zh','light',1440,{record,evidence,calls:[],payloads});
 try{
   await stage(p,'materials');await p.locator('.stage-inspect iframe').waitFor();
   assert.equal(await p.getByRole('tablist',{name:'取文尝试',exact:true}).count(),0);
   assert.ok((await p.locator('.web-material-page').innerText()).includes('搜索随附正文'));
   assert.ok((await p.locator('.web-material-page').innerText()).includes('无需调用正文接入点'));
 }finally{await context.close();}
});

test('snippet fallback remains visible alongside failed reader attempts',async()=>{
 const evidence=structuredClone(fixture.evidence),payloads=structuredClone(fixture.payloads);
 evidence.candidates[2].material='snippet';
 evidence.candidates[2].snippet_preview='观测站搜索简介';
 payloads['source-two'].output={segments:1,reason:'CONTENT_UNAVAILABLE'};
 payloads['source-two'].replay=[{...fixture.payloads['read-success'].replay[0],material_id:'snippet-two',layout_state:undefined,
   source_id:'s2',url:evidence.candidates[2].url,markdown:'# 观测站搜索简介'}];
 const {page:p,context}=await pageFor('zh','light',1440,{evidence,payloads});
 try{
   await stage(p,'materials');
   await p.getByRole('tablist',{name:'网页材料',exact:true}).getByRole('tab').nth(1).click();
   await p.locator('.final-snippet .markdown').waitFor();
   assert.ok((await p.locator('.final-snippet').innerText()).includes('观测站搜索简介'));
   assert.equal(await p.getByRole('tablist',{name:'取文尝试',exact:true}).getByRole('tab').count(),1);
 }finally{await context.close();}
});

test('standalone content reader attempts share one webpage material tab',async()=>{
 const record=structuredClone(fixture.record);
 record.metadata.operation='content';
 record.spans=record.spans.filter(s=>['admit','read-failed','read-success'].includes(s.span_id)).map(s=>({...s,parent_id:null}));
 const calls=fixture.calls.filter(c=>['read-fail','read-good'].includes(c.call_id)).map(c=>({...c,input_preview:'https://example.test/gauge'}));
 const {page:p,context}=await pageFor('zh','light',1440,{record,calls,evidence:{candidates:[],variants:[],sources:[],segments:[]}});
 try{
   await stage(p,'materials');await p.locator('.stage-inspect iframe').waitFor();
   assert.equal(await p.getByRole('tablist',{name:'网页材料',exact:true}).getByRole('tab').count(),1);
   assert.equal(await p.getByRole('tablist',{name:'取文尝试',exact:true}).getByRole('tab').count(),2);
 }finally{await context.close();}
});

test('synthesis strategy and passage labels are localized while raw model exchange remains available',async()=>{
 const {page:p,context}=await pageFor();
 try{
   await stage(p,'synthesis');
   const text=await p.locator('.stage-inspect').innerText();
   assert.ok(text.includes('总结方式')&&text.includes('原文一次性总结')&&text.includes('段落分析结果'));
   assert.ok(!text.includes('whole_sources'));
   await p.getByRole('tab',{name:'模型输入',exact:true}).waitFor();
   assert.ok((await p.locator('.model-replay').innerText()).includes('messages'));
   await p.getByRole('tab',{name:'模型输出',exact:true}).click();
   assert.ok((await p.locator('.model-replay').innerText()).includes('choices'));
 }finally{await context.close();}
});

for(const language of ['zh','en'])for(const theme of ['light','dark']){
 test('execution and inline replay support '+language+' '+theme+' at narrow width',async()=>{
   const {page:p,context}=await pageFor(language,theme,390);
   try{
     await stage(p,'materials');
     await p.locator('.stage-inspect iframe').waitFor();
     assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
     assert.equal(await p.locator('html').getAttribute('data-theme'),theme);
     const tabs=p.getByRole('tablist',{name:language==='zh'?'网页材料':'Webpage materials',exact:true}).getByRole('tab');
     await tabs.nth(0).focus();await p.keyboard.press('ArrowRight');
     await p.waitForFunction(()=>location.search.includes('read-station') && document.querySelectorAll('.execution-tab-list')[0]?.querySelectorAll('[role="tab"]')[1]?.getAttribute('aria-selected')==='true');
     assert.equal(await tabs.nth(1).getAttribute('aria-selected'),'true');
     if(process.env.OAS_TRACE_SCREENSHOTS){
       await mkdir('artifacts/trace-review',{recursive:true});
       await p.screenshot({path:'artifacts/trace-review/narrow-'+language+'-'+theme+'.png',fullPage:true});
     }
   }finally{await context.close();}
 });
}
