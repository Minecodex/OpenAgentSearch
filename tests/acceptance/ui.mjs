import {test,before,after} from 'node:test';
import {assert,check,prove} from './proof.mjs';
import {createRequire} from 'node:module';
import {existsSync,mkdirSync} from 'node:fs';
import {base,upstream,server,cookie,setup,close,admin,endpoint,project,business,recorded,sleep,editable,sql} from './context.mjs';
const require=createRequire(new URL('../../web/package.json',import.meta.url));const{chromium}=require('playwright-core');
let browser,made,summary,content,retrySummary,snippetSummary,readerCalls;const errors=[];
before(async()=>{
 await setup();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium'].find(existsSync)});
 made=await project({name:'Acceptance UI'});summary=await business(made,'summary',{query:'rainfall',language:'en'});await recorded(summary.request_id);
 const browserProject=await project({name:'Offline archive',reader_pools:[['00000000-0000-4000-8000-000000000002']]});content=await business(browserProject,'content',{url:upstream+'/article'});await recorded(content.request_id);
 const failed=await endpoint('reader','emptycontent'),good=await endpoint('reader'),other=await endpoint('reader','login');
 const retry=await project({reader_pools:[[failed.id,good.id]]});retrySummary=await business(retry,'summary',{query:'rain'});await recorded(retrySummary.request_id);
 const snippets=await project({reader_pools:[[failed.id,other.id]],allow_snippets:true});snippetSummary=await business(snippets,'summary',{query:'rain'});await recorded(snippetSummary.request_id);
 readerCalls=await admin('endpoint-calls?request_id='+content.request_id);
});
after(async()=>{await browser?.close();close();assert.deepEqual(errors,[]);});
// General UI cases share a normally authenticated session. Login and logout
// cases explicitly create independent sessions so they cannot revoke that cookie.
async function login(width=1440,theme='light',reuseSession=true){
 const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme,reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
 if(reuseSession){await context.addCookies([{name:'oas_admin_session',value:cookie.slice(cookie.indexOf('=')+1),url:base,httpOnly:true,sameSite:'Strict'}]);await page.goto(base);await page.getByRole('heading',{name:'运行总览',exact:true}).waitFor();return page;}
 await page.goto(base);await page.getByLabel('用户名',{exact:true}).fill('admin');await page.getByLabel('口令',{exact:true}).fill(process.env.OAS_TEST_PASSWORD||'admin123');const signing=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/admin/v1/session');await page.getByRole('button',{name:'登录',exact:true}).click();const signed=await signing;assert.equal(signed.status(),200,await signed.text());await page.getByRole('heading',{name:'运行总览',exact:true}).waitFor();await prove('A14.login',async()=>assert.ok(await page.getByRole('heading',{name:'运行总览',exact:true}).isVisible()));return page;
}
async function choose(page,label,option){const field=page.getByRole('button',{name:label,exact:false}).filter({has:page.locator('.select__value')});if(await field.count())await field.last().click();else await page.getByLabel(label,{exact:true}).click();await page.getByRole('option',{name:option,exact:true}).click();}

test('A14 A20 HeroUI project and pool creation, independent discard confirmation, language drafts and readable resource details',async()=>{
 const p=await login(1440,'light',false);await p.getByTestId('nav-projects').click();await p.getByRole('button',{name:'新建',exact:true}).click();let dialog=p.getByRole('dialog');await dialog.getByLabel('名称',{exact:true}).fill('Created through HeroUI');await dialog.getByRole('button',{name:'保存',exact:true}).click();await p.getByRole('heading',{name:'保存项目密钥',exact:true}).waitFor();
 const row=p.locator('.secret-row'),button=row.getByRole('button',{name:'复制密钥'});await button.click();await row.getByRole('button',{name:'已复制'}).waitFor();
 assert.ok(await row.evaluate(async el=>{const key=el.querySelector('code'),button=el.querySelector('button');return key.textContent===await navigator.clipboard.readText() && button.getBoundingClientRect().left>=key.getBoundingClientRect().right;}));
 await p.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).last().click();await p.getByLabel('按名称查找',{exact:true}).fill('Created through HeroUI');await p.locator('.project-card').filter({hasText:'Created through HeroUI'}).waitFor();await prove('A14.project_create',async()=>assert.equal(await p.locator('.project-card').filter({hasText:'Created through HeroUI'}).count(),1));
 const card=p.locator('.project-card').filter({hasText:'Created through HeroUI'});await card.getByRole('button',{name:'编辑',exact:true}).click();await p.getByRole('dialog').getByLabel('名称',{exact:true}).fill('Unsaved project');await p.keyboard.press('Escape');const confirm=p.getByRole('alertdialog');await confirm.waitFor();await prove('A14.focus_restore',async()=>assert.ok(await confirm.getByRole('button',{name:'继续编辑'}).evaluate(el=>el===document.activeElement)));await prove('A20.discard_dialog',async()=>assert.ok(await confirm.isVisible()));await confirm.getByRole('button',{name:'继续编辑'}).click();assert.equal(await p.getByRole('dialog').getByLabel('名称',{exact:true}).inputValue(),'Unsaved project');await p.keyboard.press('Escape');await p.getByRole('alertdialog').getByRole('button',{name:'放弃修改',exact:true}).click();
 const proxy=await admin('proxies',{name:'UI pool member',scheme:'socks5',host:'host.docker.internal',port:18781,auth_mode:'none',max_concurrency:1,enabled:true},'POST',201);
 await p.goto(base+'/proxy-pools');await p.getByRole('button',{name:'新建',exact:true}).click();dialog=p.getByRole('dialog');await dialog.getByLabel('名称',{exact:true}).fill('Created UI pool');await dialog.getByLabel('UI pool member',{exact:true}).check();await dialog.getByLabel('权重',{exact:true}).fill('2');await dialog.getByRole('button',{name:'保存',exact:true}).click();await p.getByRole('dialog').waitFor({state:'detached'});await p.getByLabel('按名称查找',{exact:true}).fill('Created UI pool');await p.getByText('Created UI pool',{exact:true}).waitFor({state:'visible'});await prove('A14.pool_create',async()=>assert.ok(await p.getByText('Created UI pool',{exact:true}).isVisible()));
 await p.getByText('Created UI pool',{exact:true}).click();await p.getByRole('dialog').waitFor();await prove('A20.pool_detail',async()=>{const dialog=p.getByRole('dialog');assert.ok((await dialog.innerText()).includes('UI pool member'));assert.ok((await dialog.innerText()).includes('权重 2'));assert.equal(await dialog.getByRole('textbox').count(),0);});await p.keyboard.press('Escape');
 await p.goto(base+'/proxies?resource='+proxy.id);await p.getByRole('dialog').waitFor();await prove('A20.proxy_detail',async()=>{const dialog=p.getByRole('dialog');assert.ok((await dialog.innerText()).includes('host.docker.internal'));assert.ok((await dialog.innerText()).includes('18781'));assert.ok(await dialog.getByRole('button',{name:'编辑配置',exact:true}).isVisible());assert.equal(await dialog.getByRole('textbox').count(),0);});await p.keyboard.press('Escape');
 await p.getByTestId('nav-language-routes').click();
 const composer=p.locator('.route-composer'),languageRow=composer.locator('.form-grid');
 const titleBounds=await composer.getByRole('heading').boundingBox(),fields=await languageRow.boundingBox(),add=await composer.getByRole('button',{name:'添加规则',exact:true}).boundingBox();
 assert.ok(Math.abs(titleBounds.x-fields.x)<2 && add.x>=fields.x+fields.width-1 && Math.abs(add.y+add.height-fields.y-fields.height)<2);
 await choose(p,'优先搜索接入点',made.search.name);await p.getByRole('button',{name:'添加规则',exact:true}).click();await p.getByTestId('nav-projects').click();await p.getByTestId('nav-language-routes').click();await prove('A20.route_draft',async()=>{
   const restored=p.getByRole('button',{name:made.search.name+' ×',exact:true});
   await restored.waitFor({state:'visible',timeout:5000});
   assert.ok(await restored.isVisible());
 });await p.getByRole('button',{name:'保存路由',exact:true}).click();await prove('A18.save_language_route',async()=>{for(let n=0;n<30;n++){const routes=await admin('language-routes');if(routes.entries.some(r=>r.endpoint_ids.includes(made.search.id))){assert.ok(routes.entries.some(r=>r.endpoint_ids.includes(made.search.id)));return;}await sleep(50);}assert.fail('route was not saved');});
 await p.getByTestId('nav-projects').click();await p.getByLabel('按名称查找',{exact:true}).fill('Acceptance UI');const projectCard=p.locator('.project-card').filter({hasText:'Acceptance UI'});
 const cardBounds=await projectCard.boundingBox();assert.ok(cardBounds.width>348);assert.equal(Math.round(cardBounds.height),384);
 assert.ok(await projectCard.locator('h2').evaluate(e=>e.getBoundingClientRect().height>=parseFloat(getComputedStyle(e).lineHeight)));
 assert.ok(await p.locator('.resource-toolbar').evaluate(e=>{const [search,total]=e.children;return Math.abs(search.getBoundingClientRect().y+search.clientHeight/2-total.getBoundingClientRect().y-total.clientHeight/2)<3;}));await projectCard.getByRole('button',{name:'详情',exact:true}).click();const info=await p.getByRole('dialog').innerText();check('A20.project_detail',()=>assert.ok(info.includes(made.search.name)));await prove('A20.separate_edit',async()=>{assert.equal(await p.getByRole('dialog').getByRole('textbox').count(),0);assert.ok(await p.getByRole('dialog').getByRole('button',{name:'编辑配置',exact:true}).isVisible());});await p.keyboard.press('Escape');await p.context().close();
});

test('A14 A19 A20 every locale and theme supports citation-to-original drawers, narrow layout, keyboard tabs and preserved observation filters',async()=>{
 for(const language of ['zh','en'])for(const theme of ['light','dark']){
  const p=await login(language==='en'?390:1440,theme);if(language==='en')await p.getByRole('button',{name:'EN',exact:true}).click();
  await p.goto(base+'/requests/'+summary.request_id+'?tab=evidence');await p.locator('.execution-overview dl>div').first().waitFor();assert.equal(await p.locator('.execution-overview dl>div').count(),10);
  await p.getByRole('button',{name:language==='en'?'Open citation 1':'查看引用 1',exact:true}).click();const sheet=p.locator('.inspect-sheet');await sheet.waitFor();await sheet.locator('.original-range mark').waitFor();await prove('A14.citation_range',async()=>assert.ok((await sheet.locator('.original-range mark').innerText()).includes('rainfall')));const size=await sheet.boundingBox();assert.ok(size.width<=Math.max(language==='en'?390:1440,520));
  await p.keyboard.press('Escape');await sheet.waitFor({state:'detached'});await p.getByRole('tab',{name:language==='en'?'Execution':'执行过程',exact:true}).focus();await p.keyboard.press('ArrowRight');await prove('A14.keyboard',async()=>assert.equal(await p.getByRole('tab',{name:language==='en'?'Request and result':'请求与结果',exact:true}).getAttribute('aria-selected'),'true'));
  await p.goto(base+'/observability?project_id='+made.project.id+'&language=en&timezone=Asia%2FShanghai&granularity=hour');await p.getByRole('tab',{name:language==='en'?'Calls':'调用明细',exact:true}).click();await p.locator('.data-table .row-link').first().click();await p.getByRole('heading',{name:language==='en'?'Call detail':'调用详情',exact:true}).waitFor();const observed=p.url();await p.locator('.inspect-sheet').getByRole('link',{name:language==='en'?'Open request':'查看所属请求',exact:true}).click();await p.locator('.execution-overview').waitFor();await p.getByRole('button',{name:language==='en'?'Back':'返回',exact:true}).click();check('A20.return_filters',()=>assert.equal(p.url(),observed));await p.locator('.inspect-sheet').waitFor();await p.keyboard.press('Escape');
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await prove('A14.display.'+language+'.'+theme,async()=>{assert.equal(await p.locator('html').getAttribute('data-theme'),theme);assert.equal(await p.locator('html').getAttribute('lang'),language==='en'?'en':'zh-CN');});if(language==='en')await prove('A14.narrow',async()=>assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)));mkdirSync('artifacts',{recursive:true});await p.screenshot({path:`artifacts/acceptance-ui-${language}-${theme}.png`});await p.context().close();
 }
});

test('A20 generated API examples copy and load the matching operation with the exact supplied context',async()=>{
 const p=await login();await p.getByTestId('nav-api').click();await p.getByRole('navigation',{name:'接口目录'}).getByRole('button',{name:/POST \/v1\/search\/summary/}).click();const operation=p.locator('.reference-detail');await operation.getByRole('button',{name:'复制 cURL',exact:true}).click();assert.ok((await p.evaluate(()=>navigator.clipboard.readText())).includes('/v1/search/summary'));
 const sample=require('./src/generated/reference.json').find(doc=>doc.path==='/v1/search/summary').examples.complete.value;
 await operation.getByRole('link',{name:'载入调试台',exact:false}).click();
 await p.getByRole('tab',{name:'综合总结',exact:true}).waitFor();
 assert.equal(await p.getByLabel('搜索问题',{exact:true}).inputValue(),sample.query);
 await p.getByRole('button',{name:'参数',exact:true}).click();
 assert.equal(await p.getByLabel('调用方地区',{exact:true}).inputValue(),sample.region);
 const submitted=p.waitForResponse(r=>r.url().includes('/debug/summary')&&r.request().method()==='POST');
 await p.getByRole('button',{name:'运行请求',exact:true}).click();
 assert.equal((await submitted).request().postDataJSON().current_time,sample.current_time);
 await p.context().close();
});

test('A14 A18 provider catalog forms preserve fractional seconds and all three playground operations use the selected project',async()=>{
 const p=await login();await p.getByTestId('nav-endpoints').click();
 for(const[kind,label,provider]of [['search','搜索','anysearch'],['reader','正文','crawl4ai'],['model','模型','openai_compatible']]){
  await p.getByRole('button',{name:label,exact:true}).click();await p.getByRole('button',{name:'新建',exact:true}).click();
  if(kind!=='model')await choose(p,'服务商',provider);
  const dialog=p.getByRole('dialog');await dialog.getByLabel('名称',{exact:true}).fill('Catalog UI '+kind);await dialog.getByLabel('原生服务基址',{exact:true}).fill(upstream+(kind==='model'?'/v1':''));await dialog.getByLabel('单次超时（秒）',{exact:true}).fill('2.5');if(kind==='model')await dialog.getByLabel('模型标识',{exact:true}).fill('fixture');
  const sent=p.waitForResponse(r=>r.url().endsWith('/admin/v1/endpoints')&&r.request().method()==='POST');await dialog.getByRole('button',{name:'保存',exact:true}).click();const saved=await(await sent).json();assert.equal(saved.data.timeout_ms,2500);check('A18.catalog.'+kind,()=>{assert.equal(saved.data.provider,provider);assert.equal(saved.data.kind,kind);});check('A18.fractional_timeout',()=>assert.equal(saved.data.timeout_ms,2500));await prove('A20.endpoint_detail',async()=>{const view=await admin('endpoints/'+saved.data.id);assert.equal(view.provider,provider);assert.equal(view.timeout_ms,2500);});await p.getByRole('dialog').waitFor({state:'detached'});await p.goto(base+'/endpoints?resource='+saved.data.id);await p.getByRole('dialog').waitFor();await prove('A20.endpoint_detail',async()=>{const dialog=p.getByRole('dialog');assert.ok((await dialog.innerText()).includes(provider));assert.ok((await dialog.innerText()).includes('2500'));assert.equal(await dialog.getByRole('textbox').count(),0);});await p.keyboard.press('Escape');
 }
 await p.goto(base+'/playground?op=list');await choose(p,'调试项目','Acceptance UI');await p.getByLabel('搜索问题',{exact:true}).fill('rainfall');await p.getByTestId('run').click();await p.locator('.search-hit').first().waitFor();await prove('A18.committed_debug',async()=>assert.ok((await p.locator('.search-hit').first().innerText()).includes('Rainfall')));
 await p.getByRole('tab',{name:'网页正文',exact:true}).click();await p.getByLabel('网页 URL',{exact:true}).fill(upstream+'/article');await p.getByTestId('run').click();await p.locator('.read-result').waitFor();await p.getByRole('tab',{name:'纯文本',exact:true}).click();await prove('A14.markdown_plaintext',async()=>assert.ok((await p.locator('.read-result .code-box').innerText()).includes('雨量计')));
 await p.getByRole('tab',{name:'综合总结',exact:true}).click();await p.getByLabel('搜索问题',{exact:true}).fill('rainfall');await p.getByTestId('run').click();await p.locator('.summary-result').waitFor();await prove('A14.three_operations',async()=>assert.ok((await p.locator('.summary-result').innerText()).includes('rainfall')));
 await p.getByRole('button',{name:'查看引用 1',exact:true}).click();await p.locator('.focused-passage').getByRole('button',{name:'查看原文范围'}).click();
 await p.locator('.inspect-sheet .original-range mark').waitFor();await p.keyboard.press('Escape');await p.locator('.inspect-sheet').waitFor({state:'detached'});await p.getByRole('button',{name:'返回',exact:true}).click();await p.locator('.summary-result').waitFor();await p.context().close();
});

test('project pool ordering is saved and used by the next debug call',async()=>{
 const other=await endpoint('search');const ordered=await project({name:'UI ordered pools',search_pools:[[made.search.id],[other.id]]});
 const p=await login();await p.goto(base+'/projects?resource='+ordered.project.id);await p.getByRole('dialog').getByRole('button',{name:'编辑配置',exact:true}).click();
 await p.getByRole('button',{name:'搜索接入点池 优先级 2 上移',exact:true}).click();await p.getByRole('dialog').getByRole('button',{name:'保存',exact:true}).click();await p.getByRole('dialog').waitFor({state:'detached'});
 await prove('A18.pool_order',async()=>{const saved=await admin('projects/'+ordered.project.id);assert.deepEqual(saved.search_pools,[[other.id],[made.search.id]]);const result=await business(ordered,'list',{query:'rain'});await recorded(result.request_id);assert.equal((await admin('endpoint-calls?request_id='+result.request_id)).items[0].endpoint_id,other.id);});await p.context().close();
});

test('candidate drawers display failed reader attempts and readable browser phase diagnostics',async()=>{
 const p=await login();for(const result of [retrySummary,snippetSummary]){await p.goto(base+'/requests/'+result.request_id+'?tab=evidence');await p.getByRole('button',{name:'查看引用 1',exact:true}).click();const drawer=p.locator('.inspect-sheet');await drawer.locator('.reader-attempt').first().waitFor();await prove(result===retrySummary?'A19.reader_retry_chain':'A19.reader_failed_chain',async()=>{assert.equal(await drawer.locator('.reader-attempt').count(),2);assert.ok((await drawer.locator('.reader-attempt').first().innerText()).includes('失败'));});await p.keyboard.press('Escape');}
 await p.goto(base+'/requests/'+content.request_id+'?tab=calls&call='+readerCalls.items[0].call_id);const drawer=p.locator('.inspect-sheet');await drawer.locator('.phase-list').waitFor();await prove('A20.readable_browser_phases',async()=>{const text=await drawer.innerText();assert.ok(text.includes('创建浏览器上下文'));assert.ok(text.includes('页面加载'));assert.ok(text.includes('提取内容'));assert.ok(text.includes('回收上下文'));assert.equal(await drawer.locator('[data-parent="execute"]').count()>=2,true);});await p.context().close();
});

test('version conflicts retain drafts and unavailable component references remain readable',async()=>{
 const p=await login();await p.goto(base+'/projects?resource='+made.project.id);await p.getByRole('dialog').getByRole('button',{name:'编辑配置',exact:true}).click();await p.getByRole('dialog').getByLabel('名称',{exact:true}).fill('Draft preserved');const current=await admin('projects/'+made.project.id);await admin('projects/'+made.project.id,{...editable(current),name:'Other writer'},'PUT');await p.getByRole('dialog').getByRole('button',{name:'保存',exact:true}).click();await p.getByRole('alert').waitFor();await prove('A18.conflict_draft',async()=>{assert.equal(await p.getByRole('dialog').getByLabel('名称',{exact:true}).inputValue(),'Draft preserved');assert.ok(await p.getByRole('dialog').getByRole('button',{name:'载入最新版本',exact:true}).isVisible());});
 const changed=await admin('projects/'+made.project.id);await admin('projects/'+made.project.id,{...editable(changed),name:made.project.name},'PUT');
 const history=await admin('requests/'+summary.request_id);check('A18.historical_version',()=>{assert.equal(history.config_version,1);assert.equal(history.snapshot.project.name,'Acceptance UI');});
 const bound=await project({name:'Unavailable refs',search_pools:[['00000000-0000-4000-8000-000000000003']],reader_pools:[['00000000-0000-4000-8000-000000000004']]});await p.goto(base+'/projects?resource='+bound.project.id);await p.getByRole('dialog').waitFor();await prove('A16.disabled_reference',async()=>assert.ok((await p.getByRole('dialog').innerText()).includes('未安装')));await p.getByRole('dialog').getByRole('link',{name:'searxng',exact:true}).click();await p.getByRole('heading',{name:'searxng',exact:true}).waitFor();await prove('A20.reference_links',async()=>assert.ok(p.url().includes('resource=00000000-0000-4000-8000-000000000003')));
 await p.goto(base+'/projects');await p.getByRole('button',{name:'新建',exact:true}).click();const searches=p.locator('fieldset').filter({has:p.locator('legend').filter({hasText:'搜索接入点池'})});await searches.getByRole('button',{name:'新增池',exact:true}).click();await searches.getByRole('button',{name:'添加成员',exact:false}).click();await prove('A16.available_options',async()=>{assert.equal(await p.getByRole('option',{name:'searxng',exact:true}).count(),0);assert.ok(await p.getByRole('option',{name:'内置浏览器搜索',exact:true}).count());});await p.keyboard.press('Escape');await p.getByRole('dialog').getByLabel('名称',{exact:true}).fill('Unsaved component draft');await p.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).last().click();await p.getByRole('alertdialog').getByRole('button',{name:'放弃修改',exact:true}).click();
 await p.goto(base+'/playground?op=list');await choose(p,'调试项目','Acceptance UI');await p.getByLabel('搜索问题',{exact:true}).fill('rain');await p.getByRole('button',{name:'参数',exact:true}).click();await prove('A20.defaults_explicit',async()=>assert.ok((await p.locator('.field-help').first().innerText()).includes('项目默认')));await p.getByLabel('结果数量',{exact:true}).fill('100');await p.getByTestId('run').click();await p.getByRole('alert').waitFor();await prove('A20.field_errors',async()=>assert.ok((await p.getByRole('alert').innerText()).includes('count')));await p.context().close();
});

test('Atlas split sign-in and shared controls retain their visual hierarchy in both locales and themes',async()=>{
 for(const width of [1440,390])for(const theme of ['light','dark'])for(const language of ['zh','en']){
  const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme,reducedMotion:'reduce'});const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base);await p.getByLabel('用户名',{exact:true}).waitFor();if(language==='en')await p.getByRole('button',{name:'EN',exact:true}).click();
  await prove('A14.login_split',async()=>{const left=await p.locator('.login-introduction').boundingBox(),right=await p.locator('.login-content').boundingBox(),submit=await p.locator('.login-submit').boundingBox();assert.equal((await p.locator('.login-introduction h2').innerText()).trim(),'OpenAgentSearch');assert.equal(await p.locator('.login-introduction').getAttribute('aria-label'),'OpenAgentSearch');assert.ok(submit.height>=48);assert.ok(submit.width>=Math.min(300,width-60));if(width>900)assert.ok(left.x+left.width<=right.x+1);else assert.ok(left.y+left.height<=right.y+1);assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));});
  mkdirSync('artifacts',{recursive:true});await p.screenshot({path:`artifacts/atlas-login-${language}-${theme}-${width}.png`,fullPage:true});if(width===1440){await p.getByLabel(language==='zh'?'口令':'Password',{exact:true}).fill(process.env.OAS_TEST_PASSWORD||'admin123');await p.locator('.login-submit').click();}else{await context.addCookies([{name:cookie.split('=')[0],value:cookie.slice(cookie.indexOf('=')+1),url:base}]);await p.goto(base);}await p.locator('.dashboard-metric').first().waitFor();
  await prove('A14.atlas_controls',async()=>{assert.equal(await p.locator('.side .nav-group').count(),3);assert.equal(Math.round((await p.locator('.head-actions .oas-button.primary').boundingBox()).height),35);const padding=await p.locator('.dashboard-metric .oas-panel__body').first().evaluate(e=>parseInt(getComputedStyle(e).paddingLeft));assert.ok(padding>=16);assert.equal(await p.locator('html').getAttribute('data-theme'),theme);assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));});
  await prove('A14.blue_theme',async()=>{
    const colors=await p.evaluate(()=>{const rgb=(el,key)=>getComputedStyle(el)[key].match(/[\d.]+/g).map(Number);return {body:rgb(document.body,'backgroundColor'),primary:rgb(document.querySelector('.head-actions .primary'),'backgroundColor'),paper:rgb(document.querySelector('.dashboard-metric'),'backgroundColor')};});
    assert.deepEqual(colors.primary,[80,112,242]);assert.ok(colors.body[2]>=colors.body[0]);
    if(theme==='light')assert.deepEqual(colors.paper,[255,255,255]);else assert.ok(colors.paper[2]>colors.paper[0] && colors.paper[0]<50);
  });
  await p.screenshot({path:`artifacts/atlas-overview-${language}-${theme}-${width}.png`,fullPage:true});await p.goto(base+'/projects');await p.getByLabel(language==='zh'?'按名称查找':'Find by name',{exact:true}).waitFor();await prove('A14.atlas_controls',async()=>{const field=p.locator('.atlas-search-box').filter({has:p.getByLabel(language==='zh'?'按名称查找':'Find by name',{exact:true})});assert.equal(Math.round((await field.boundingBox()).height),35);});await context.close();
 }
});

test('Atlas traffic, operation mix, names and time drill-down use actual request aggregates',async()=>{
 const p=await login();await p.goto(base);await p.locator('.recent .operation-label').first().waitFor();await p.waitForFunction(()=>/\d/.test(document.querySelector('.operation-donut strong')?.textContent||''));await prove('A20.atlas_dashboard',async()=>{const plot=p.locator('.dashboard-traffic');assert.ok((await plot.innerText()).includes('请求流量'));assert.ok(!(await p.locator('.operation-donut').innerText()).includes('NaN'));const traffic=await plot.boundingBox(),mix=await p.locator('.dashboard-distribution').boundingBox();assert.ok(traffic.x+traffic.width<=mix.x+1);assert.ok(traffic.width>mix.width);assert.equal(await p.locator('.recent .operation-label').count()>0,true);assert.ok((await plot.evaluate(e=>getComputedStyle(e).backgroundImage)).includes('linear-gradient'));});
 const legends=p.locator('.dashboard-traffic .trend-chart__legend button');await legends.first().click();assert.equal(await legends.first().getAttribute('aria-pressed'),'false');await legends.first().click();await p.locator('.dashboard-traffic .trend-chart__plot').focus();await p.keyboard.press('ArrowRight');await p.keyboard.press('Enter');await p.getByRole('heading',{name:'请求记录',exact:true}).waitFor();await prove('A20.atlas_dashboard',async()=>{const url=new URL(p.url());assert.ok(url.searchParams.has('from'));assert.ok(url.searchParams.has('to'));assert.ok(Date.parse(url.searchParams.get('to'))>Date.parse(url.searchParams.get('from')));});await p.context().close();
});

test('centered editors, status dialogs and drawers use their intended width and scroll independently',async()=>{
 for(const width of [390,1440,1920]){
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
  try {
   await context.addCookies([{name:cookie.split('=')[0],value:cookie.slice(cookie.indexOf('=')+1),url:base}]);
   const page=await context.newPage();await page.goto(base+'/projects');await page.locator('.page-head .primary').click();const editor=page.getByRole('dialog',{name:'新建项目',exact:true});await editor.waitFor();const box=await editor.boundingBox();
   await prove('A20.overlay_widths',async()=>{
    assert.ok(box.x>=0 && box.x+box.width<=width+1 && box.y>=0 && box.y+box.height<=901);
    assert.ok(Math.abs(box.width-(width<700?width-16:Math.min(1080,Math.max(720,width*.57))))<2);
    const pools=await editor.locator('.project-pools > fieldset').evaluateAll(nodes=>nodes.map(n=>({x:n.offsetLeft,y:n.offsetTop})));
    assert.equal(pools.length,2);assert.equal(pools[0].x,pools[1].x);assert.ok(pools[1].y>pools[0].y);
    const footer=editor.locator(':scope > footer');const before=await footer.boundingBox();
    await editor.locator('.dialog-body').evaluate(el=>{el.scrollTop=el.scrollHeight;});const after=await footer.boundingBox();
    assert.ok(Math.abs(before.y-after.y)<=1);assert.ok(after.y+after.height<=901 && after.height>=44);
   });
   await editor.getByLabel('名称',{exact:true}).fill('宽度检查');await page.keyboard.press('Escape');const confirm=page.getByRole('alertdialog');await confirm.waitFor();
   await prove('A20.overlay_widths',async()=>{const bounds=await confirm.boundingBox();assert.ok(Math.abs(bounds.width-Math.min(width-16,435))<2);assert.ok(await confirm.getByRole('button',{name:'继续编辑'}).isVisible());});
   await confirm.getByRole('button',{name:'放弃修改'}).click();await page.getByRole('button',{name:'账户',exact:true}).click();const account=page.getByRole('menu');await account.waitFor();
   await prove('A20.overlay_widths',async()=>{
     const bounds=await account.boundingBox(),avatar=await page.locator('.topbar .avatar').boundingBox();
     assert.ok(bounds.width<220 && bounds.y>=avatar.y+avatar.height-1);assert.ok(Math.abs(bounds.x+bounds.width-avatar.x-avatar.width)<12);
     assert.equal(await account.getByRole('menuitem').count(),1);assert.ok(await account.getByRole('menuitem',{name:'退出登录'}).isVisible());
   });
   await page.keyboard.press('Escape');await account.waitFor({state:'detached'});assert.ok(await page.getByRole('button',{name:'账户',exact:true}).evaluate(el=>el===document.activeElement));
   await page.goto(base+'/requests');await page.getByRole('button',{name:'全局保留设置'}).click();const regular=page.getByRole('dialog',{name:'全局保留设置'});
   assert.ok(Math.abs((await regular.boundingBox()).width-(width<700?width-16:Math.min(768,Math.max(600,width*.45))))<2);
   await page.goto(base+'/requests/'+content.request_id+'?tab=calls&call='+readerCalls.items[0].call_id);const sheet=page.locator('.inspect-sheet');await sheet.waitFor();
   await prove('A20.overlay_widths',async()=>{const bounds=await sheet.boundingBox();assert.ok(Math.abs(bounds.width-(width<700?width:Math.min(960,Math.max(480,width*.39))))<2);assert.ok(Math.abs(bounds.x+bounds.width-width)<2);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));});
  } finally {await context.close();}
 }
});

test('Atlas request investigation restores the selected record, submitted command and local page scope',async()=>{
  const p=await login(1440,'light',false);
  assert.equal(await p.locator('.environment-button,.global-project,.global-search').count(),0);
  await p.keyboard.press('Control+k');assert.equal(await p.locator('.atlas-modal-layer').count(),0);
  await p.goto(base+'/requests?project_id='+made.project.id);
  const compact=p.getByRole('button',{name:'紧凑',exact:true});
  await compact.click();assert.equal(await p.getByRole('columnheader',{name:'结果摘要'}).count(),0);
  const expand=p.getByRole('button',{name:/^展开行摘要/}).first();await expand.click();const prior=p.url();
  await p.getByRole('link',{name:'打开完整请求'}).click();await p.locator('.stage-inspect').waitFor();
  assert.equal(await p.getByRole('tablist',{name:'请求详情视图',exact:true}).getByRole('tab').count(),5);
  await p.getByRole('tab',{name:'记录信息',exact:true}).click();await p.getByText('到期时间',{exact:true}).waitFor();
  await p.getByRole('button',{name:'返回',exact:true}).click();assert.equal(p.url(),prior);await p.getByRole('link',{name:'打开完整请求'}).waitFor();

  await p.goto(base+'/playground?op=list');await choose(p,'调试项目',made.project.name);
  await choose(p,'载入样例','降雨量是如何测量的？');
  await p.getByLabel('搜索问题',{exact:true}).fill('rainfall');
  const submitted=p.waitForResponse(r=>r.request().method()==='POST' && r.url().endsWith('/debug/list'));
  await p.getByTestId('run').click();assert.equal((await submitted).status(),200);
  await p.locator('.search-hit').first().waitFor();await p.getByLabel('搜索问题',{exact:true}).fill('next draft');
  await p.getByRole('tab',{name:'请求参数',exact:true}).click();assert.ok((await p.locator('.playground-response').innerText()).includes('rainfall'));
  assert.equal((await p.locator('.playground-response').innerText()).includes('next draft'),false);
  await p.getByRole('tab',{name:'结果',exact:true}).click();await p.getByRole('link',{name:'请求记录',exact:true}).last().click();
  await p.locator('.execution-board').waitFor();await p.getByRole('button',{name:'返回',exact:true}).click();
  await p.locator('.search-hit').first().waitFor();assert.equal(await p.getByLabel('搜索问题',{exact:true}).inputValue(),'next draft');
  if(process.env.OAS_UI_CAPTURE_DIR){
    const dir=process.env.OAS_UI_CAPTURE_DIR;mkdirSync(dir,{recursive:true});
    await p.screenshot({path:dir+'/sample-playground-result.png'});
    await p.goto(base+'/requests/'+summary.request_id);await p.locator('.stage-inspect .facts-grid').first().waitFor();
    await p.screenshot({path:dir+'/sample-summary-stages.png'});
    await p.getByRole('tab',{name:'请求与结果',exact:true}).click();await p.locator('.summary-result').waitFor();
    await p.screenshot({path:dir+'/sample-summary-result.png'});
    for(const route of ['proxies','proxy-pools','language-routes']){await p.goto(base+'/'+route);await p.locator('.main .page-head h1').waitFor();
      await p.locator(route==='proxy-pools'?'.pool-card':'.main .data-table tbody tr').first().waitFor();await p.screenshot({path:dir+'/sample-'+route+'.png'});}
  }
  await p.getByRole('button',{name:'账户',exact:true}).click();
  await p.getByRole('menuitem',{name:'退出登录'}).click();await p.getByRole('button',{name:'登录',exact:true}).waitFor();
  assert.equal((await p.request.get(base+'/admin/v1/session')).status(),401);
  await p.context().close();
});

test('Atlas aligns search controls and exposes regional languages and responsive project columns',async()=>{
 const p=await login();
 try {
  await p.goto(base+'/requests');const field=p.locator('.filter-search-row .atlas-search-box'),search=field.locator('input');await search.focus();
  const searchHeight=(await field.boundingBox()).height,selectHeight=(await p.locator('.filter-panel .select__trigger').first().boundingBox()).height;
  const actions=await p.locator('.filter-search-row button').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height));
  check('A14.form_control_rows',()=>{assert.equal(searchHeight,35);assert.equal(selectHeight,35);assert.ok(actions.length>=2&&actions.every(h=>h===35));});
  assert.equal(await search.evaluate(e=>getComputedStyle(e).outlineStyle),'none');
  assert.notEqual(await field.evaluate(e=>getComputedStyle(e).boxShadow),'none');
  await p.goto(base+'/playground');const picker=p.locator('.playground-composer .debug-project-picker');
  assert.equal(await p.locator('.page-head .oas-select').count(),0);await picker.getByRole('button').waitFor();
  const notOverlapping=el=>{const v=el.querySelector('.select__value').getBoundingClientRect(),i=el.querySelector('.select__indicator').getBoundingClientRect();return v.right+3<=i.left && Math.min(v.height,i.height)>0;};
  for(const width of [1440,390]){
   await p.setViewportSize({width,height:900});
   assert.ok(await picker.getByRole('button').evaluate(notOverlapping));
   if(width>=1440){const tools=await p.locator('.compose-actions .oas-button,.compose-actions .select__trigger').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().top));assert.ok(tools.every(y=>Math.abs(y-tools[0])<1));}
   assert.ok(await p.locator('.compose-actions .oas-select .select__trigger').evaluate(notOverlapping));
   assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  await p.setViewportSize({width:2200,height:1020});await p.goto(base+'/projects');await p.locator('.project-card').first().waitFor();
  const cards=await p.locator('.project-card').evaluateAll(es=>es.slice(0,5).map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}));
  check('A20.project_layout',()=>{assert.ok(cards.length>=5);assert.ok(cards.slice(0,4).every(c=>c[1]===cards[0][1]&&c[2]>348&&c[3]===384));assert.ok(cards[4][1]>cards[0][1]);});
  await p.locator('.project-card').first().getByRole('button',{name:'编辑',exact:true}).click();const editor=p.getByRole('dialog');
  assert.equal(await editor.getByText('允许的业务语言',{exact:true}).count(),0);assert.equal(await editor.getByText('默认业务语言',{exact:true}).count(),0);
  const pools=await editor.locator('.project-pools > fieldset').evaluateAll(es=>es.map(x=>x.getBoundingClientRect().toJSON()));
  assert.equal(pools.length,2);assert.equal(pools[0].x,pools[1].x);assert.ok(pools[1].y>=pools[0].bottom);await p.keyboard.press('Escape');
  await p.goto(base+'/endpoints');await p.getByRole('button',{name:'新建',exact:true}).click();
  assert.equal(await p.getByRole('dialog').getByText(/支持语言|支持时间窗口/).count(),0);await p.keyboard.press('Escape');
  await p.goto(base+'/language-routes');const combo=p.getByRole('combobox',{name:'业务语言'});await combo.fill('Japanese');
  await p.getByRole('option',{name:/日语.*ja/}).click();await choose(p,'优先搜索接入点',made.search.name);await p.getByRole('button',{name:'添加规则'}).click();
  const saved=p.waitForResponse(r=>r.url().endsWith('/language-routes')&&r.request().method()==='PUT');
  await p.getByRole('button',{name:'保存路由'}).click();const result=(await(await saved).json()).data;
  check('A18.language_catalog',()=>assert.ok(result.entries.some(e=>e.language==='ja'&&e.endpoint_ids.includes(made.search.id))));
  await combo.fill('zh-tw');await p.getByRole('option',{name:/zh-TW/}).waitFor();
 } finally {await p.context().close();}
});

test('calendar offsets, scoped test feedback, full API descriptions and overflow text remain usable',async()=>{
 const p=await login();
 try {
  const sample={query:'rainfall',current_time:'2026-05-01T00:30:00+05:45'};
  await p.goto(base+'/playground?'+new URLSearchParams({op:'summary',sample:JSON.stringify(sample)}));
  if(!await p.locator('.local-date-time').isVisible())await p.getByRole('button',{name:'参数',exact:true}).click();
  const calendar=p.getByRole('button',{name:/选择日期与时间/});
  await calendar.click();
  await p.getByRole('grid').waitFor();
  await p.keyboard.press('Escape');
  assert.equal(await p.locator('.local-date-time .date-input-group').first().evaluate(e=>Math.round(e.getBoundingClientRect().height)),35);
  const outgoing=p.waitForRequest(r=>r.url().includes('/debug/summary')&&r.method()==='POST');
  await p.getByRole('button',{name:'运行请求',exact:true}).click();
  assert.equal((await outgoing).postDataJSON().current_time,sample.current_time);
  await p.getByRole('button',{name:'清除当地时间',exact:true}).click();
  assert.equal(await p.getByRole('button',{name:'清除当地时间',exact:true}).count(),0);
  await p.goto(base+'/language-routes');
  const language=p.getByRole('combobox',{name:'业务语言'});
  await language.fill('French');await p.getByRole('option',{name:/法语.*fr/}).first().waitFor();
  await language.fill('zh-tw');await p.getByRole('option',{name:/zh-TW/}).waitFor();
  await p.goto(base+'/endpoints');
  await p.getByLabel('按名称查找',{exact:true}).fill(made.search.name);
  const endpointRow=p.getByRole('row').filter({hasText:made.search.name});
  await endpointRow.getByRole('button',{name:'测试',exact:true}).click();
  await p.locator('.test-receipt').waitFor();
  await p.getByRole('button',{name:'模型',exact:true}).click();
  assert.equal(await p.locator('.test-receipt').count(),0);
  await p.goto(base+'/api');
  await p.getByRole('heading',{name:'请求参数',exact:true}).waitFor();
  assert.ok((await p.locator('.business-reference').innerText()).includes('项目 search_limit'));
  assert.ok((await p.locator('.business-reference').innerText()).includes('data.items[].url'));
  await p.getByRole('button',{name:'只看必填参数'}).click();
  assert.ok((await p.locator('.business-reference .code-box').first().innerText()).includes('Authorization: Bearer'));
  assert.ok(!(await p.locator('.business-reference .code-box').first().innerText()).includes('time_range'));
  const long=await endpoint('search','',{name:'Long search pool member '+ 'Rainfall measurement '.repeat(4)});
  const created=await project({name:'Overflow verification',search_pools:[[made.search.id,long.id]]});
  await p.goto(base+'/projects');
  await p.getByLabel('按名称查找',{exact:true}).fill(created.project.name);
  const card=p.locator('.project-card').filter({hasText:created.project.name});
  const field=card.locator('.facts-grid dd .overflow-text').first();await field.waitFor();
  assert.ok(await field.evaluate(e=>e.scrollWidth>e.clientWidth));
  assert.equal(await field.evaluate(e=>getComputedStyle(e).whiteSpace),'nowrap');
  await field.hover();await p.getByRole('tooltip').filter({hasText:long.name}).waitFor();
 } finally {await p.context().close();}
});

test('project query checkbox persists and Google reachability indicators support cached states, keyboard focus, both languages and themes',async()=>{
 const p=await login(1440,'light',true);
 await p.goto(base+'/projects');await p.getByLabel('按名称查找',{exact:true}).fill('Acceptance UI');
 const card=p.locator('.project-card').filter({hasText:'Acceptance UI'});
 await card.getByRole('button',{name:'编辑',exact:true}).click();let dialog=p.getByRole('dialog');
 const checkbox=dialog.getByRole('checkbox',{name:'原问题参与搜索',exact:true});
 assert.equal(await checkbox.isChecked(),true);await dialog.getByText('原问题参与搜索',{exact:true}).click();
 assert.equal(await checkbox.isChecked(),false);await checkbox.focus();await p.keyboard.press('Space');
 assert.equal(await checkbox.isChecked(),true);await p.keyboard.press('Space');assert.equal(await checkbox.isChecked(),false);
 await dialog.getByRole('button',{name:'保存',exact:true}).click();
 await dialog.getByRole('alert').waitFor();assert.ok((await dialog.getByRole('alert').innerText()).includes('关闭原问题搜索时，额外查询数至少为 1。'));
 await dialog.getByLabel('额外查询数（0–3）',{exact:true}).fill('1');
 await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'detached'});
 await card.getByRole('button',{name:'编辑',exact:true}).click();dialog=p.getByRole('dialog');
 assert.equal(await dialog.getByRole('checkbox',{name:'原问题参与搜索',exact:true}).isChecked(),false);
 assert.equal((await admin('projects/'+made.project.id)).search_original_query,false);
 await p.keyboard.press('Escape');await p.context().close();
 for(const language of ['zh','en'])for(const theme of ['light','dark']){
  const page=await login(1440,theme,true);if(language==='en')await page.getByRole('button',{name:'EN',exact:true}).click();
  for(const reachable of [true,false,null]){
   const sample=reachable===null?{reachable:null,checked_at:null}:{reachable,checked_at:'2026-11-22T12:34:56Z',probe_pod_uid:'ui-probe'};
   sql(`UPDATE probes SET body='${JSON.stringify(sample)}',generation=nextval('oas_probe_generation') WHERE egress_id='default_network';`);
   await page.goto(base+'/endpoints');
   const text=reachable===null?(language==='zh'?'Google 待首次检测':'Google awaiting first probe'):reachable?(language==='zh'?'Google 网络可达':'Google network reachable'):(language==='zh'?'Google 网络不可达':'Google network unreachable');
   const indicator=page.getByRole('button',{name:text,exact:true});await indicator.focus();
   const tooltip=page.getByRole('tooltip');await tooltip.waitFor();assert.ok((await tooltip.innerText()).includes(text));
   assert.ok((await tooltip.innerText()).includes(language==='zh'?'绑定代理池':'proxy pool'));
   if(reachable!==null)assert.ok((await tooltip.innerText()).includes(language==='zh'?'最近检测':'Last checked'));
   const row=page.getByRole('row').filter({has:indicator});assert.ok((await row.innerText()).includes(language==='zh'?'可用':'Available'));
   assert.equal(await indicator.evaluate(el=>getComputedStyle(el).color),await page.evaluate(state=>getComputedStyle(document.documentElement).getPropertyValue(state===true?'--good':state===false?'--warn':'--muted').trim(),reachable).then(value=>value.startsWith('#')?`rgb(${value.slice(1).match(/../g).map(v=>parseInt(v,16)).join(', ')})`:value));
   await page.keyboard.press('Escape');await tooltip.waitFor({state:'detached'});
  }
  await page.context().close();
 }
 // Restore a completed sample for the following reader/archive acceptance.
 sql(`UPDATE probes SET body='${JSON.stringify({reachable:false,checked_at:new Date().toISOString(),probe_pod_uid:'ui-probe'})}',generation=nextval('oas_probe_generation') WHERE egress_id='default_network';`);
});

test('ordinary browser cards remain distinct from AI answers in every locale and theme and become scored inline summary sources',async()=>{
 const search='00000000-0000-4000-8000-000000000001';
 sql('DELETE FROM browser_engine_health;');
 const made=await project({search_pools:[[search]],source_limit:1});
 const list=await business(made,'list',{query:'live-value-weather-card'});await recorded(list.request_id);
 assert.ok(list.data.cards.length);assert.equal(list.data.engine_answer,undefined);
 assert.ok(list.data.cards[0].content.includes('降雨量: 12'));
 const cardTrace=await admin('requests/'+list.request_id+'/export');
 const searchPayload=cardTrace.payloads.find(payload=>payload.span.stage==='search'&&payload.output?.cards?.length&&payload.output?.search_readiness);
 assert.ok(searchPayload,JSON.stringify(cardTrace.calls.map(call=>({stage:call.stage,status:call.status,code:call.error_code}))));
 assert.ok(searchPayload.output.search_readiness);
 await (await import('node:fs/promises')).writeFile('artifacts/material-readiness/ui-card-trace.json',JSON.stringify(cardTrace,null,2));
 const result=await business(made,'summary',{query:'live-value-weather-card'});await recorded(result.request_id);
 assert.ok(result.data.sources[0].url.includes('/search?')||result.data.sources[0].url.includes('/s?'));
 const calls=(await admin('endpoint-calls?request_id='+result.request_id)).items;assert.equal(calls.filter(call=>call.kind==='reader').length,0);
 for(const language of ['zh','en'])for(const theme of ['light','dark']){
  const p=await login(language==='en'?390:1440,theme,true);if(language==='en')await p.getByRole('button',{name:'EN',exact:true}).click();
  await p.goto(base+'/requests/'+list.request_id+'?tab=evidence');const card=p.locator('[data-search-card]').first();await card.waitFor();
  assert.ok((await card.innerText()).includes(language==='zh'?'搜索页卡片':'Search-page card'));assert.ok((await card.innerText()).includes('降雨量: 12'));
  assert.ok(await card.locator('pre code').count());assert.ok(await card.getByRole('link',{name:language==='zh'?'查看搜索页':'View search page',exact:true}).isVisible());
  await p.goto(base+'/requests/'+list.request_id+'?tab=execution&stage='+searchPayload.span.span_id);
  try{await p.getByText(language==='zh'?'卡片等待结果':'Card readiness',{exact:true}).waitFor();}catch(error){
   await (await import('node:fs/promises')).writeFile('artifacts/material-readiness/ui-card-failure.json',JSON.stringify({url:p.url(),text:await p.locator('.stage-inspect').innerText()},null,2));throw error;
  }
  assert.ok((await p.locator('.stage-inspect').innerText()).includes(language==='zh'?'普通卡片':'Ordinary cards'));
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.screenshot({path:`artifacts/search-cards-${language}-${theme}.png`});await p.context().close();
 }
});

test('rewrite details distinguish successful model transport from duplicate unusable queries in both languages and themes',async()=>{
 const made=await project({rewrite_count:1},{model:await endpoint('model','duplicate-rewrite')});
 const result=await business(made,'summary',{query:'rainfall',region:'Shanghai',current_time:'2026-05-01T00:30:00+08:00'});await recorded(result.request_id);
 const trace=await admin('requests/'+result.request_id+'/export'),rewrite=trace.payloads.find(payload=>payload.span.stage==='rewrite');
 assert.equal(result.status,'partial');assert.equal(rewrite.diagnostics.rewrite.used,0);assert.equal(rewrite.span.status,'partial');
 assert.equal(rewrite.replay[0].model_input.messages[1].content,'rainfall');assert.ok(rewrite.replay[0].model_input.messages[0].content.includes('当前地区：Shanghai'));
 for(const language of ['zh','en'])for(const theme of ['light','dark']){
  const p=await login(language==='en'?390:1440,theme,true);if(language==='en')await p.getByRole('button',{name:'EN',exact:true}).click();
  await p.goto(base+'/requests/'+result.request_id+'?stage='+rewrite.span.span_id);
  await p.getByText(language==='zh'?'有效改写数':'Usable rewrites',{exact:true}).waitFor();
  await p.getByText(language==='zh'?'与原问题重复，未搜索':'Duplicate original; not searched',{exact:true}).waitFor();
  assert.equal(await p.locator('.variant-cards small').filter({hasText:'Q1'}).count(),0);
  assert.ok((await p.locator('.stage-inspect').innerText()).includes(language==='zh'?'已回退原问题':'Original-query fallback'));
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await p.locator('.stage-inspect').screenshot({path:`artifacts/rewrite-fallback-${language}-${theme}.png`});await p.context().close();
 }
});

test('A26 HTML layout, captured images/fonts and rendered Markdown remain usable offline and another request cannot read the material',async()=>{
 const exported=await admin('requests/'+content.request_id+'/export');const material=exported.payloads.flatMap(s=>s.replay).find(m=>m.kind==='webpage'&&m.layout_state);const layout=await admin('requests/'+content.request_id+'/replay/'+material.material_id+'/layout');assert.ok(layout.srcdoc.includes('grid-template-columns'));assert.ok(layout.srcdoc.includes('data:image/'));assert.ok(layout.srcdoc.includes('@font-face'));check('A26.archived_layout_assets',()=>{assert.ok(layout.srcdoc.includes('grid-template-columns'));assert.ok(layout.srcdoc.includes('data:image/'));assert.ok(layout.srcdoc.includes('data:font/'));});const modelExchange=await admin('requests/'+summary.request_id+'/export');check('A26.model_exchange',()=>assert.ok(modelExchange.payloads.flatMap(s=>s.replay).some(m=>m.kind==='model'&&m.model_input.messages&&m.model_output.choices)));
 await prove('A26.wrong_request',async()=>{await admin('requests/'+summary.request_id+'/replay/'+material.material_id+'/layout',undefined,'GET',404);});
 await prove('A26.partial_assets',async()=>{const made=await project({reader_pools:[['00000000-0000-4000-8000-000000000002']]});const result=await business(made,'content',{url:upstream+'/missing-assets'});await recorded(result.request_id);const trace=await admin('requests/'+result.request_id+'/export');const page=trace.payloads.flatMap(s=>s.replay).find(m=>m.kind==='webpage');assert.equal(page.layout_state,'partial');assert.ok(page.text.includes('rainfall'));const partial=await admin('requests/'+result.request_id+'/replay/'+page.material_id+'/layout');assert.equal(partial.state,'partial');assert.ok(partial.missing_resource_count>=1);assert.ok(partial.reason);});
 const p=await login(1440,'light',true);
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 const upstreamRequests=[];p.on('request',r=>{if(r.url().startsWith(upstream))upstreamRequests.push(r.url());});await p.goto(base+'/requests/'+content.request_id);await p.locator('.water-row[data-stage=materials]').first().click();await p.locator('.stage-inspect .material-preview').waitFor();const frame=p.frameLocator('iframe');await frame.locator('main').waitFor();assert.equal(await frame.locator('main').evaluate(el=>getComputedStyle(el).display),'grid');assert.equal(await frame.locator('img').evaluate(el=>el.complete&&el.naturalWidth>0),true);await prove('A26.sandbox',async()=>assert.equal(await p.locator('iframe').getAttribute('sandbox'),''));await prove('A26.no_scripts',async()=>assert.equal(await frame.locator('script').count(),0));
 await p.getByRole('tab',{name:'Markdown 预览',exact:true}).click();await p.locator('.stage-inspect .material-preview').locator('.markdown table').waitFor();await prove('A26.markdown_render',async()=>{assert.ok(await p.locator('.stage-inspect .material-preview').locator('.markdown pre code').count());assert.ok(await p.locator('.stage-inspect .material-preview').locator('.markdown table').count());});await p.locator('.stage-inspect .material-preview').getByRole('tab',{name:'Markdown 源文',exact:true}).click();await prove('A26.source_view',async()=>assert.ok((await p.locator('.stage-inspect .material-preview').locator('.code-box').innerText()).includes('```')));check('A26.offline',()=>assert.deepEqual(upstreamRequests,[]));check('A14.no_refetch',()=>assert.deepEqual(upstreamRequests,[]));await p.context().close();
});
