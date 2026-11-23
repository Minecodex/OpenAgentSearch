import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {fixture} from './fixture.mjs';
const tools=createRequire(new URL('../web/package.json',import.meta.url));
const {chromium}=tools('playwright-core');
const base=process.env.OAS_TEST_API||'http://127.0.0.1:18080';
let browser,server;
const errors=[];
before(async()=>{server=await fixture();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium'].find(existsSync)});});
after(async()=>{await browser?.close();server?.closeAllConnections();server?.close();assert.deepEqual(errors,[]);});
async function login(width=1440){
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
  const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));p.setDefaultTimeout(10000);
  await p.goto(base);await p.getByLabel('用户名',{exact:true}).fill('admin');await p.getByLabel('口令',{exact:true}).fill(process.env.OAS_TEST_PASSWORD||'admin123');await p.getByRole('button',{name:'登录',exact:true}).click();
  await p.getByRole('heading',{name:'运行总览',exact:true}).waitFor();return p;
}
test('Atlas signs in, executes real synthesis, drills into persisted evidence and preserves modal drafts',async()=>{
  const p=await login();
  await p.getByTestId('nav-projects').click();
  const card=p.locator('.project-card').filter({hasText:'Integration research'}).first();
  await card.getByRole('button',{name:'编辑',exact:true}).click();
  await p.getByRole('dialog').getByLabel('名称',{exact:true}).fill('Unsaved research');
  await p.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).last().click();
  const confirm=p.getByRole('alertdialog');await confirm.waitFor();assert.ok(await confirm.getByRole('button',{name:'继续编辑'}).isVisible());
  await confirm.getByRole('button',{name:'继续编辑'}).click();assert.equal(await p.getByRole('dialog').getByLabel('名称',{exact:true}).inputValue(),'Unsaved research');
  await p.keyboard.press('Escape');await p.getByRole('alertdialog').getByRole('button',{name:'放弃修改',exact:true}).click();
  await card.getByRole('button',{name:'调试',exact:true}).click();await p.getByLabel('搜索问题',{exact:true}).fill('rainfall');
  await p.getByTestId('run').click();await p.locator('.summary-result').waitFor();
  assert.ok((await p.locator('.summary-result').innerText()).includes('rainfall'));
  await p.locator('.response-bar').getByRole('link',{name:'请求记录'}).click();await p.locator('.water-row').first().waitFor();
  const downloaded=p.waitForEvent('download');await p.getByRole('button',{name:'导出 Markdown',exact:true}).click();const report=await downloaded;const markdown=readFileSync(await report.path(),'utf8');assert.ok(markdown.includes('## 请求参数'));assert.ok(markdown.includes('## 配置快照'));assert.ok(markdown.includes('候选证据'));
  await p.locator('.water-row[data-stage=score]').first().click();const stage=p.locator('.stage-inspect');
  await stage.getByRole('tab',{name:'模型输入',exact:true}).waitFor();
  assert.ok((await stage.locator('.model-replay').innerText()).includes('messages'));
  assert.equal(await p.getByRole('dialog').count(),0);
  await stage.getByRole('tab',{name:'模型输出',exact:true}).click();
  assert.ok((await stage.locator('.model-replay').innerText()).includes('choices'));

  assert.equal(await p.getByRole('dialog').count(),0);
  await p.getByRole('button',{name:'返回',exact:true}).click();await p.locator('.summary-result').waitFor();
  assert.equal(await p.getByLabel('搜索问题',{exact:true}).inputValue(),'rainfall');
  await p.getByTestId('nav-observability').click();await p.getByRole('tab',{name:'调用明细',exact:true}).click();
  await p.locator('.data-table .row-link').first().click();await p.getByRole('heading',{name:'调用详情',exact:true}).waitFor();
  await p.keyboard.press('Escape');await p.getByRole('button',{name:'切换配色'}).click();await p.getByRole('button',{name:'EN',exact:true}).click();
  await p.getByRole('heading',{name:'Observability',exact:true}).waitFor();
  mkdirSync('artifacts',{recursive:true});await p.screenshot({path:'artifacts/atlas-live-dark.png'});await p.context().close();
});
test('empty configuration and narrow layouts stay usable through real session state',async()=>{
  const p=await login(390);
  await p.getByRole('button',{name:'打开导航'}).click();await p.getByRole('dialog').getByTestId('nav-requests').click();
  await p.getByRole('heading',{name:'请求记录',exact:true}).waitFor();await p.getByRole('button',{name:'全局保留设置'}).click();
  await p.getByRole('dialog').getByLabel('保留天数').waitFor();await p.keyboard.press('Escape');
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await p.context().close();
});
