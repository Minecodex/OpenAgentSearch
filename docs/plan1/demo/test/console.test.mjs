import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const modules = process.env.OAS_DEMO_MODULES || join(root, 'node_modules');
const requireTools = createRequire(join(dirname(modules), 'package.json'));
const { chromium } = requireTools('playwright-core');
const esbuild = requireTools('esbuild');
let browser, engine, fixture;
const errors = [],
  external = [];
before(async () => {
  const out = await esbuild.build({
    absWorkingDir: root,
    stdin: {
      contents:
        "export * from './src/engine';export * from './src/demo-dispatch';export * from './src/fixtures';export * from './src/diagnostic-data';export * from './src/investigation';export * from './src/configuration';export * from './src/routing';export * from './src/rewrite';export * from './src/execution-overview';export * from './src/endpoint-providers';export * from './src/trace-export';export * from './src/trace-markdown';",
      resolveDir: root,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  engine = await import(
    'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].contents).toString('base64')
  );
  fixture = engine.initialConfig();
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome',
    ].find(existsSync);
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-lcd-text',
    ],
  });
});
after(async () => {
  await browser?.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});
async function pageFor(file = 'demo.html', width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('close', () => {
    if (!context.pages().length) void context.close().catch(() => {});
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/^https?:\/\//, (route) => {
    external.push(route.request().url());
    return route.abort();
  });
  await page.goto(pathToFileURL(resolve(root, '..', file)).href);
  page.setDefaultTimeout(6500);
  await page.locator('h1').waitFor();
  return page;
}
async function nav(page, id) {
  await page.getByTestId('nav-' + id).click();
}
const result = (op, cmd, project = fixture.projects[0], cfg = fixture) =>
  engine.runDemo(op, cmd, project, cfg, 'req-test', 'zh');

test('offline engine returns matching evidence, limits and two renders of one source', () => {
  const list = result('list', { query: 'coastal wetland', count: 2 });
  assert.equal(list.data.items.length, 2);
  assert.equal(result('list', { query: 'coastal wetland', time_range: 'day' }).data.items.length, 1);
  assert.equal(result('list', { query: 'not_a_fixture' }).status, 'empty');
  assert.equal(result('list', { query: 'x', count: 11 }).error.code, 'LIMIT_EXCEEDED');
  const url = engine.articles[0].url;
  const doc = result('content', { url }),
    short = result('content', { url, max_chars: 12 });
  assert.equal(doc.data.text, doc.data.markdown.slice(2));
  assert.equal(short.data.truncated, true);
  assert.equal(short.data.lengths.markdown.retained, [...short.data.markdown].length);
  assert.equal(short.data.text, result('content', { url, max_chars: 12 }, fixture.projects[2]).data.text);
  assert.equal(result('content', { url: 'file:///demo' }).error.code, 'URL_NOT_ALLOWED');
  const combined = result('summary', { query: '海岸湿地', language: 'en', source_count: 2, max_chars: 60 });
  assert.equal(combined.data.sources.length, 2);
  assert.ok([...combined.data.summary].length <= 60);
  for (const c of combined.data.citations)
    assert.ok(
      combined.data.sources.find((s) => s.id === c.source_id)?.segments.some((s) => s.id === c.segment_id),
    );
  const cfg = structuredClone(fixture);
  cfg.proxies.forEach((p) => (p.enabled = false));
  assert.equal(result('list', { query: 'wetland' }, cfg.projects[0], cfg).status, 'success');
  const browserOnly = { ...cfg.projects[0], searchPools: [['browser-s']] };
  assert.equal(result('list', { query: 'wetland' }, browserOnly, cfg).error.code, 'PROXY_UNAVAILABLE');
  assert.equal(engine.available(fixture, 'searxng'), false);
  assert.equal(engine.available(fixture, 'crawl4ai'), false);
});

test('execution overview counts dispatched calls, distinct queries, candidates, scoring batches and endpoint identities', () => {
  const record = engine.history()[0],
    response = engine.responseFor(record, 'zh');
  const groups = engine.retrievalGroups(record),
    calls = engine.attempts(record);
  const search = calls.find((c) => c.phase === 'search'),
    score = calls.find((c) => c.phase === 'score');
  const ids = engine.uniqueHits(groups).map((h) => h.article.id);
  const extra = [
    { ...search, id: 'retry', status: 'error', endpoint: 'retired' },
    { ...score, id: 'correction', scoreBatch: { id: score.scoreBatch.id, candidateIds: ids.slice(0, 1) } },
    { ...score, id: 'next-batch', scoreBatch: { id: 'B2', candidateIds: ids.slice(0, 2) } },
    { ...search, id: 'queued', endpoint: 'never-sent', sent: false },
  ];
  const frozen = { ...record, generated: true, snapshot: { names: { retired: 'Historical search' } } };
  const facts = engine.executionOverview(frozen, response, [...calls, ...extra], groups, true, 'en');
  assert.equal(facts.upstream_calls, calls.length + 3);
  assert.equal(facts.model_calls, calls.filter((c) => c.kind === 'model').length + 2);
  const raw = groups.reduce((n, g) => n + g.hits.length, 0);
  assert.ok(raw > ids.length);
  assert.deepEqual(facts.summary.retrieval, {
    variant_count: groups.length,
    raw_candidates: raw,
    unique_candidates: ids.length,
  });
  assert.deepEqual(facts.summary.score_batches, [
    { batch_id: 'B1', candidate_count: ids.length },
    { batch_id: 'B2', candidate_count: 2 },
  ]);
  assert.deepEqual(
    facts.summary.endpoints.search.map((e) => e.endpoint_id),
    [search.endpoint, 'retired'].map(engine.wireId),
  );
  assert.equal(facts.summary.endpoints.search[1].endpoint_name, 'Historical search');
  assert.equal(facts.summary.endpoints.search[0].endpoint_name, null);
  const lost = engine.executionOverview(record, response, calls, groups, false, 'en');
  assert.equal(lost.summary.retrieval.variant_count, groups.length);
  assert.equal(lost.summary.retrieval.unique_candidates, null);
  assert.equal(lost.summary.score_batches[0].candidate_count, null);
  assert.equal(lost.summary.answer_source, null);
  assert.ok(lost.summary.endpoints.search.length);
});

test('answer provenance follows cited passages and separates empty, unexecuted, unavailable and inapplicable facts', () => {
  const q = '海岸湿地 档案缺页',
    project = { ...fixture.projects[0], allowSnippets: true };
  const response = result('summary', { query: q }, project);
  const record = {
    id: 'test-overview',
    op: 'summary',
    origin: 'debug',
    status: response.status,
    generated: true,
    query: q,
    project: project.id,
    time: 0,
    duration: 100,
    response,
  };
  const overview = (r, res) =>
    engine.executionOverview(r, res, engine.attempts(r), engine.retrievalGroups(r), true, 'zh').summary;
  const only = (kind) => {
    const id = response.data.sources.find((s) => s.kind === kind).id;
    return {
      ...response,
      data: { ...response.data, citations: response.data.citations.filter((c) => c.source_id === id) },
    };
  };
  assert.equal(overview(record, response).answer_source, 'mixed');
  assert.equal(overview(record, only('snippet')).answer_source, 'snippet');
  assert.equal(overview(record, only('body')).answer_source, 'body');
  assert.equal(
    overview(record, {
      ...response,
      data: { ...response.data, citations: [{ source_id: 's1', segment_id: 'lost' }] },
    }).answer_source,
    null,
  );
  const bad = result('summary', { query: q, current_time: 'invalid' });
  const denied = { ...record, status: 'error', response: bad };
  const blocked = overview(denied, bad);
  assert.equal(blocked.answer_source, 'none');
  assert.deepEqual(blocked.retrieval, { variant_count: 0, raw_candidates: 0, unique_candidates: 0 });
  assert.deepEqual(blocked.endpoints, { search: [], reader: [], model: [] });
  assert.deepEqual(blocked.score_batches, []);
  const empty = result('list', { query: 'no_sample_match' });
  const list = overview(
    { ...record, op: 'list', status: 'empty', query: 'no_sample_match', response: empty },
    empty,
  );
  assert.deepEqual(list.retrieval, { variant_count: 1, raw_candidates: 0, unique_candidates: 0 });
  assert.equal(list.score_batches, null);
  const failed = { ...bad, error: { code: 'SEARCH_FAILED', message: 'Example', details: null } };
  const failedSearch = overview({ ...record, op: 'list', status: 'error', response: failed }, failed);
  assert.deepEqual(failedSearch.retrieval, {
    variant_count: 1,
    raw_candidates: null,
    unique_candidates: null,
  });
  const read = result('content', { url: engine.articles[0].url });
  const article = overview(
    { ...record, op: 'content', status: 'success', query: engine.articles[0].url, response: read },
    read,
  );
  assert.equal(article.answer_source, 'body');
  assert.equal(article.retrieval, null);
  assert.deepEqual(article.endpoints.search, []);
  assert.deepEqual(article.endpoints.model, []);
  const testLog = engine.resourceTestLog(
    { id: 'only-model', kind: 'model', name: 'Saved name', version: 2 },
    'en',
  );
  const test = overview(testLog, testLog.response);
  assert.equal(test.retrieval, null);
  assert.equal(test.answer_source, null);
  assert.deepEqual(test.endpoints.model, [
    { endpoint_id: engine.wireId('only-model'), endpoint_name: 'Saved name' },
  ]);
});

test('single Atlas entry, global search, theme and all navigation destinations', async () => {
  assert.deepEqual(
    readdirSync(resolve(root, '..')).filter((f) => /^demo.*\.html$/.test(f)),
    ['demo.html'],
  );
  {
    const page = await pageFor();
    assert.equal(await page.locator('h1').innerText(), '运行总览');
    assert.equal(await page.locator('html').getAttribute('data-skin'), 'atlas');
    const old = await page.locator('html').getAttribute('data-theme');
    await page.getByTestId('theme').click();
    assert.notEqual(await page.locator('html').getAttribute('data-theme'), old);
    await page.getByTestId('language').click();
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').getByRole('textbox').fill('api');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('h1').innerText(), 'API reference');
    await page.getByRole('button', { name: 'Management API', exact: true }).click();
    assert.ok((await page.locator('.reference-layout').innerText()).includes('/admin/v1/'));
    await page.getByRole('button', { name: 'Health probes', exact: true }).click();
    assert.ok((await page.locator('.reference-layout').innerText()).includes('/health/live'));
    await page.close();
  }
  const p = await pageFor();
  for (const id of [
    'projects',
    'endpoints',
    'proxies',
    'languages',
    'requests',
    'observability',
    'api',
    'playground',
    'overview',
  ]) {
    await nav(p, id);
    assert.ok(await p.locator('main h1').isVisible());
  }
  await p.getByTestId('range').selectOption('1');
  assert.notEqual(await p.locator('.metric-count strong').innerText(), '12,846');
  await nav(p, 'requests');
  await p.getByTestId('open-record').first().click();
  await p.locator('.waterfall').waitFor();
  await p.close();
});

test('three search operations, citations, cancellation and trace evidence', async () => {
  const p = await pageFor();
  await nav(p, 'playground');
  await p.getByTestId('run').click();
  await p.getByTestId('cite-0').click();
  assert.ok(await p.locator('.passages').isVisible());
  await p.getByRole('button', { name: '网页正文', exact: true }).click();
  await p.getByTestId('run').click();
  await p.locator('.read-result').waitFor();
  await p.getByRole('button', { name: 'Markdown', exact: true }).click();
  assert.ok((await p.locator('.read-result pre').innerText()).startsWith('# '));
  await p.getByRole('button', { name: '纯文本', exact: true }).click();
  assert.ok(!(await p.locator('.read-result pre').innerText()).startsWith('# '));
  await p.getByRole('button', { name: '搜索列表', exact: true }).click();
  await p.getByTestId('command').fill('not_a_fixture');
  await p.getByTestId('run').click();
  await p.getByText('示例资料中没有相关证据。').waitFor();
  await p.getByRole('button', { name: '综合总结', exact: true }).click();
  await p.getByTestId('run').click();
  await p.getByTestId('cancel').click();
  await p.locator('.response-bar').getByText('已取消').waitFor();
  await p.getByTestId('run').click();
  await p.getByTestId('cite-0').waitFor();
  await p.locator('.response-bar').getByRole('button', { name: '请求记录' }).click();
  await p.locator('.water-row').nth(2).click();
  await p.locator('.stage-inspect').waitFor();
  await p.getByRole('button', { name: '请求与结果', exact: true }).click();
  assert.ok(await p.getByTestId('cite-0').isVisible());
  assert.equal(await p.getByRole('button', { name: 'JSON', exact: true }).count(), 0);
  await p.getByRole('button', { name: '执行过程', exact: true }).click();
  await p.getByTestId('stage-admit').click();
  assert.match(await p.getByTestId('request-facts').innerText(), /业务语言/);
  await p.close();
});

test('project mutations, built-in selection, optional services and resource protection', async () => {
  const p = await pageFor();
  await nav(p, 'projects');
  await p.getByTestId('new-project').click();
  await p.getByTestId('project-name').fill('预览研究');
  await p.getByTestId('save-editor').click();
  assert.match(await p.getByRole('dialog').innerText(), /demo_/);
  await p.getByRole('button', { name: '完成', exact: true }).click();
  const card = p.locator('.project-card').filter({ hasText: '预览研究' });
  assert.ok(await card.isVisible());
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await p.getByTestId('add-search-pool').click();
  await p.getByLabel('搜索池添加成员 1', { exact: true }).selectOption('browser-s');
  await p.getByTestId('save-editor').click();
  await p.getByRole('alert').filter({ hasText: '代理池' }).waitFor();
  await p.getByLabel('浏览器代理池', { exact: true }).selectOption('ocean');
  await p.getByTestId('add-search-pool').click();
  await p.getByLabel('搜索池添加成员 2', { exact: true }).selectOption('index');
  await p.getByRole('button', { name: '搜索池上移 2', exact: true }).click();
  const pools = p.locator('.pool-builder').first().locator('.endpoint-group');
  assert.match(await pools.nth(0).innerText(), /文档索引/);
  assert.match(await pools.nth(1).innerText(), /内置浏览器搜索/);
  assert.equal(await p.getByRole('dialog').locator('pre').count(), 0);
  await p.getByTestId('project-name').fill('预览研究更新');
  await p.getByTestId('save-editor').click();
  await p.reload();
  await p.getByRole('heading', { name: '预览研究更新' }).waitFor();
  await nav(p, 'endpoints');
  assert.ok((await p.getByRole('row').filter({ hasText: 'SearXNG' }).innerText()).includes('未安装'));
  await p.getByRole('button', { name: '组件选项' }).click();
  await p.getByRole('switch', { name: /SearXNG/ }).check();
  assert.equal(await p.getByRole('switch', { name: /Crawl4AI/ }).isChecked(), false);
  await p.keyboard.press('Escape');
  await p.getByRole('row').filter({ hasText: 'SearXNG' }).getByRole('button', { name: '测试' }).click();
  await nav(p, 'proxies');
  await p.getByRole('button', { name: '观测出口 A', exact: true }).click();
  await p.getByRole('dialog').getByRole('button', { name: '观测代理池', exact: true }).click();
  await p.getByRole('dialog').getByRole('heading', { name: '代理池详情' }).waitFor();
  await p.keyboard.press('Escape');
  await p.getByRole('button', { name: '添加代理', exact: true }).click();
  await p.getByLabel('显示名').fill('新出口');
  await p.getByLabel('主机').fill('new.example.org');
  await p.getByTestId('save-editor').click();
  await p.getByText('新出口', { exact: true }).waitFor();
  await p.getByRole('button', { name: /代理池 ·/ }).click();
  await p.getByRole('button', { name: '新建代理池' }).click();
  await p.getByLabel('代理池名称').fill('新池');
  await p.getByLabel('新出口', { exact: true }).check();
  await p.getByTestId('save-editor').click();
  await p.getByRole('heading', { name: '新池', exact: true }).waitFor();
  await nav(p, 'languages');
  await p.getByRole('row').filter({ hasText: '英语' }).getByRole('button', { name: '移除语言' }).click();
  await p.getByRole('button', { name: '保存路由' }).click();
  await p.close();
});

test('sample upstream attempts open their linked trace, session and responsive controls work', async () => {
  const p = await pageFor();
  await nav(p, 'observability');
  await p.getByRole('button', { name: '调用明细', exact: true }).click();
  await p.locator('.row-link').first().click();
  await p.getByRole('button', { name: '打开关联请求' }).click();
  await p.locator('.trace-detail').waitFor();
  await p.getByTestId('account').click();
  await p.getByTestId('logout').click();
  await p.getByTestId('signin').click();
  await p.locator('.trace-detail').waitFor();
  await p.close();
  {
    const p = await pageFor('demo.html', 390);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await p.getByRole('button', { name: '打开导航' }).click();
    await p.getByRole('dialog').getByTestId('nav-projects').click();
    await p.locator('h1').getByText('项目').waitFor();
    await p.getByTestId('new-project').click();
    assert.ok(await p.getByTestId('save-editor').isVisible());
    await p.keyboard.press('Escape');
    await p.getByTestId('language').click();
    await p.setViewportSize({ width: 360, height: 800 });
    await p.getByRole('button', { name: 'Open navigation' }).click();
    await p.getByRole('dialog').getByTestId('nav-languages').click();
    await p.getByRole('heading', { name: 'Language routes' }).waitFor();
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await p.close();
  }
});

test('one set of attempt facts drives time buckets, quality samples and trace timing', () => {
  const record = engine.history()[0];
  const calls = engine.attempts(record);
  const groups = engine.retrievalGroups(record);
  assert.equal(groups.length, 2);
  assert.equal(calls.filter((c) => c.phase === 'search').length, 2);
  assert.ok(
    groups.flatMap((g) => g.hits).length >
      new Set(groups.flatMap((g) => g.hits).map((h) => h.article.url)).size,
  );
  assert.equal(new Set(calls.map((c) => c.id)).size, calls.length);
  assert.ok(
    calls.every(
      (c) =>
        c.started >= record.time &&
        c.time <= record.time + record.duration &&
        c.time - c.started === c.duration + c.queue,
    ),
  );
  const search = calls.find((c) => c.kind === 'search');
  const window = { start: 100, end: 300 };
  const frames = [
    { start: 100, end: 200 },
    { start: 200, end: 300 },
  ];
  const facts = engine.rollup(
    [
      { ...search, time: 101, candidates: 1, evaluated: 1, relevant: 1 },
      { ...search, time: 200, candidates: 9, evaluated: 9, relevant: 0 },
      { ...search, time: 220, evaluation: 'unscored', candidates: 4, evaluated: 0, relevant: 0 },
      { ...search, time: 300 },
    ],
    frames,
  );
  assert.equal(facts.all.n, 3);
  assert.equal(facts.all.samples, 2);
  assert.equal(engine.quality(facts.all), 10);
  assert.equal(facts.series[0].total.n, 1);
  assert.equal(facts.series[1].total.n, 2);
  assert.equal(engine.quality(engine.aggregate()), null);
  assert.equal(engine.quality({ ...engine.aggregate(), numerator: 0, denominator: 4 }), 0);
  const dst = { start: Date.parse('2025-03-08T05:00:00Z'), end: Date.parse('2025-03-11T04:00:00Z') };
  assert.deepEqual(
    engine.frameBounds(dst, 'day', 'America/New_York').map((w) => (w.end - w.start) / 3600000),
    [24, 23, 24],
  );
  const days = { start: 1000000, end: 1000000 + 30 * 86400000 };
  assert.equal(engine.effectiveGrain(days, 'hour'), 'day');
  const params = new URLSearchParams({ from: String(window.start), to: String(window.end) });
  assert.deepEqual(engine.getWindow(params, 999), window);
});

test('request list keeps its filtered window and page after evidence and snapshot drilldown', async () => {
  const p = await pageFor();
  await nav(p, 'requests');
  const title = p.getByTestId('open-record');
  const total = await p.locator('.diag-number strong').first().innerText();
  assert.ok(parseInt(total.replaceAll(',', '')) > 10);
  await title.first().click();
  await p.getByTestId('stage-rewrite').click();
  assert.ok(await p.getByText('扩展查询', { exact: true }).isVisible());
  await p.getByTestId('stage-score').click();
  await p.locator('.candidate-rows button').first().click();
  await p.getByRole('dialog').getByText('被采用的分段').waitFor();
  await p.keyboard.press('Escape');
  assert.match(await p.locator('.stage-inspect').innerText(), /个相关/);
  await p.getByRole('button', { name: '配置快照', exact: true }).click();
  assert.match(await p.locator('.trace-tab-panel').innerText(), /配置版本/);
  assert.match(await p.locator('.trace-tab-panel').innerText(), /内置浏览器搜索 → 文档索引/);
  assert.equal(await p.locator('.trace-tab-panel pre').count(), 0);
  await p.getByTestId('trace-back').click();
  await p.getByTestId('record-status').selectOption('partial');
  await p.getByRole('button', { name: '下一页' }).click();
  const first = await p.getByTestId('open-record').first().innerText();
  await p.getByTestId('open-record').first().click();
  await p.getByTestId('trace-back').click();
  assert.equal(await p.getByTestId('record-status').inputValue(), 'partial');
  assert.equal(await p.getByTestId('open-record').first().innerText(), first);
  assert.match(p.url(), /pg=1/);
  await p.getByRole('button', { name: '清除筛选' }).click();
  await p.getByRole('textbox', { name: '搜索问题、URL 或请求 ID' }).fill('no_fixture_with_this_name');
  await p.getByRole('button', { name: '查询', exact: true }).click();
  await p.getByText('该窗口没有匹配请求').waitFor();
  await p.close();
});

test('trace overview is visible above the tabs, drills into its recorded facts and wraps on narrow screens', async () => {
  const p = await pageFor(),
    record = engine.history()[0];
  await nav(p, 'requests');
  await p.getByTestId('open-record').first().click();
  const bar = p.getByRole('region', { name: '请求执行概览' });
  await bar.waitFor();
  assert.equal(await bar.locator('dt').count(), 10);
  assert.doesNotMatch(await bar.innerText(), /缓存/);
  const countRows = () =>
    p
      .locator('.trace-overview dl > div')
      .evaluateAll((cells) => new Set(cells.map((el) => Math.round(el.getBoundingClientRect().top))).size);
  assert.equal(await countRows(), 1);
  const boxes = await p.evaluate(() =>
    ['.trace-summary-grid', '.trace-overview', '.dossier-toolbar'].map(
      (s) => document.querySelector(s).getBoundingClientRect().top,
    ),
  );
  assert.ok(boxes[0] < boxes[1] && boxes[1] < boxes[2]);
  const byKey = (k) => p.getByTestId('trace-fact-' + k);
  const facts = engine.executionOverview(
    record,
    engine.responseFor(record, 'zh'),
    engine.attempts(record),
    engine.retrievalGroups(record),
    true,
    'zh',
  );
  const { variant_count, raw_candidates, unique_candidates } = facts.summary.retrieval;
  assert.ok(
    (await byKey('retrieval').innerText()).includes(
      variant_count + ' · ' + raw_candidates + ' → ' + unique_candidates,
    ),
  );
  assert.match(await byKey('calls').innerText(), new RegExp('其中模型 ' + facts.model_calls));
  await byKey('retrieval').getByRole('button').click();
  assert.equal(await p.getByTestId('stage-dedup').getAttribute('aria-pressed'), 'true');
  await byKey('batches').getByRole('button').focus();
  await p.keyboard.press('Enter');
  assert.equal(await p.getByTestId('stage-score').getAttribute('aria-pressed'), 'true');
  await byKey('source').getByRole('button').click();
  await p.getByTestId('cite-0').waitFor();
  await byKey('recording').getByRole('button').click();
  assert.match(p.url(), /section=recording/);
  await byKey('model').getByRole('button').click();
  const rows = p.locator('.trace-tab-panel tbody tr');
  assert.equal(await rows.count(), facts.model_calls);
  assert.ok((await rows.locator('td:first-child').allTextContents()).every((n) => n === '通用生成模型'));
  assert.equal(
    await p
      .getByRole('group', { name: '调用能力' })
      .getByRole('button', { name: '模型', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  await byKey('calls').getByRole('button').click();
  assert.equal(await rows.count(), facts.upstream_calls);
  await p.getByTestId('language').click();
  await p.getByTestId('theme').click();
  await p.setViewportSize({ width: 390, height: 844 });
  assert.equal(await countRows(), 5);
  assert.ok(await p.getByRole('region', { name: 'Request execution overview' }).isVisible());
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await p.getByTestId('trace-back').click();
  assert.doesNotMatch(p.url(), /epKind|section=/);
  await p.getByTestId('open-record').nth(1).click();
  assert.equal(await byKey('search').locator('dd').innerText(), 'Not called');
  assert.equal(await byKey('model').locator('dd').innerText(), 'Not called');
  assert.equal(await byKey('batches').locator('dd').innerText(), 'Not applicable');
  assert.equal(await byKey('source').locator('button').innerText(), 'Article body');
  await p.close();
});

test('trend, endpoint and call drilldowns preserve the exact scope across a return trip', async () => {
  const p = await pageFor();
  await nav(p, 'observability');
  await p.getByRole('button', { name: '正文', exact: true }).click();
  assert.ok(await p.getByText('正文获取率', { exact: true }).isVisible());
  await p.getByRole('button', { name: '质量', exact: true }).click();
  await p.getByTestId('peer-drill').first().click();
  const endpoint = await p.getByTestId('obs-endpoint').inputValue();
  assert.ok(endpoint);
  await p.locator('.calls-table .row-link').first().click();
  await p.getByRole('dialog').getByText('时间分解').waitFor();
  const callUrl = p.url();
  await p.getByTestId('call-to-trace').click();
  await p.getByTestId('trace-back').click();
  await p.getByRole('dialog').waitFor();
  assert.equal(p.url(), callUrl);
  await p.keyboard.press('Escape');
  assert.equal(await p.getByTestId('obs-endpoint').inputValue(), endpoint);
  await p.getByRole('button', { name: '统计概览', exact: true }).click();
  const tile = await p.locator('.diag-number strong').first().innerText();
  const chart = p.getByTestId('insight-trend');
  await chart.focus();
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('Enter');
  assert.match(p.url(), /from=\d+/);
  assert.match(p.url(), /to=\d+/);
  assert.equal(await p.getByTestId('obs-endpoint').inputValue(), endpoint);
  const count = await p.locator('.calls-panel .count-label').innerText();
  assert.ok(Number(count.replaceAll(',', '')) < Number(tile.replaceAll(',', '')));
  await p.reload();
  await p.locator('.calls-panel').waitFor();
  assert.ok(await p.locator('.calls-panel').isVisible());
  assert.equal(await p.getByTestId('obs-endpoint').inputValue(), endpoint);
  await p.getByRole('textbox', { name: '搜索问题、URL 或调用 ID' }).fill('not_a_real_call_id');
  await p.getByText('当前筛选没有调用').waitFor();
  await p.getByRole('button', { name: '统计概览', exact: true }).click();
  assert.ok((await p.locator('.quality-meter').count()) > 0);
  await p.close();
});

test('endpoint version tests create searchable attempts and trace receipts', async () => {
  const p = await pageFor();
  await nav(p, 'endpoints');
  await p
    .getByRole('row')
    .filter({ hasText: '内置浏览器搜索' })
    .getByRole('button', { name: '测试', exact: true })
    .click();
  await p.getByRole('button', { name: '查看测试链路' }).click();
  await p.getByRole('button', { name: '请求与结果', exact: true }).click();
  await p.getByText('资源版本', { exact: true }).waitFor();
  await p.getByTestId('trace-back').click();
  await p.locator('main.page-endpoints').waitFor();
  await nav(p, 'observability');
  await p.getByLabel('流量来源', { exact: true }).selectOption('endpoint_test');
  await p.getByRole('button', { name: '调用明细', exact: true }).click();
  await p.locator('.calls-table .row-link').first().click();
  assert.ok(await p.getByRole('dialog').getByText('接入点测试', { exact: true }).isVisible());
  await p.close();
});

test('Atlas shortcuts resolve the requested scope and the overview is reachable from a trace', async () => {
  const p = await pageFor();
  await p.locator('.atlas-review').getByRole('button', { name: /^失败/ }).click();
  assert.equal(await p.getByTestId('record-status').inputValue(), 'error');
  assert.ok((await p.getByTestId('open-record').count()) > 0);
  await nav(p, 'overview');
  await p
    .locator('.mix-list')
    .getByRole('button', { name: /网页正文/ })
    .click();
  assert.equal(await p.getByLabel('业务操作', { exact: true }).inputValue(), 'content');
  await nav(p, 'overview');
  await p.getByTestId('atlas-traffic').focus();
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('Enter');
  assert.match(p.url(), /from=\d+/);
  await nav(p, 'overview');
  await p.locator('.recent .row-link').first().click();
  await p.getByTestId('trace-back').click();
  await p.locator('main.page-overview').waitFor();
  await p.close();
});

test('only supplied rewrite context enters the prompt and the local date survives midnight', () => {
  const query = engine.contextualQuery.zh,
    region = '浦东新区',
    current_time = '2026-05-01T00:30:00+08:00';
  for (const input of [{}, { region }, { current_time }, { region, current_time }]) {
    const checked = engine.checkRewriteContext(input);
    assert.equal(checked.ok, true);
    const job = engine.rewriteJob(query, 'zh', 1, checked.value);
    for (const field of ['region', 'current_time']) {
      assert.equal(Object.hasOwn(job.user, field), Object.hasOwn(input, field));
      assert.equal(job.system.includes(field), Object.hasOwn(input, field));
    }
    assert.equal(result('summary', { query, ...input }).status, 'success');
    assert.equal(engine.rewriteJob(query, 'zh', 0, checked.value), undefined);
  }
  const enriched = result('summary', { query, region: '上海', current_time, source_count: 1 });
  assert.equal(enriched.data.sources[0].url, 'https://station.example.org/observations/2026-05-01');
  assert.ok(!result('summary', { query }).data.sources.some((s) => s.url === enriched.data.sources[0].url));
  const variants = (time) =>
    engine.sampleVariants(engine.rewriteJob(query, 'zh', 1, { region, current_time: time }));
  assert.match(variants(current_time)[0], /浦东新区2026-05-01/);
  assert.match(variants('2026-04-30T16:30:00Z')[0], /2026-04-30/);
  const data = '  🌏 "region" {示例}  ';
  const checked = engine.checkRewriteContext({ region: data });
  const job = engine.rewriteJob(query, 'zh', 1, checked.value);
  assert.equal(JSON.parse(JSON.stringify(job.user)).region, data.trim());
  assert.ok(!job.system.includes('🌏'));
  for (const value of [
    '2000-02-29T23:59:59.123456789-03:30',
    '2024-02-29T12:34:56+05:45',
    '0001-01-01T00:00:00Z',
  ])
    assert.equal(engine.validCallerTime(value), true);
  for (const value of [
    null,
    '',
    '2026-02-29T01:00:00Z',
    '2026-06-31T01:00:00Z',
    '0000-01-01T00:00:00Z',
    '2026-01-01T00:00:00-00:00',
    '2026-01-01T00:00:00',
    '2026-04-00T00:00:00Z',
    '2026-04-01T00:00:60Z',
    '2026-04-01T00:00:00.1234567890Z',
  ]) {
    const res = result(
      'summary',
      { query, current_time: value },
      { ...fixture.projects[0], rewriteCount: 0 },
    );
    assert.equal(res.error.code, 'INVALID_ARGUMENT');
    assert.equal(res.error.details.field, 'current_time');
  }
  for (const value of [null, 12, ' \t ', 'x\nx', 'x'.repeat(129)])
    assert.equal(result('summary', { query, region: value }).error.details.field, 'region');
  for (const op of ['list', 'content'])
    for (const field of ['current_time', 'region']) {
      const res = result(op, {
        ...(op === 'list' ? { query } : { url: engine.articles[0].url }),
        [field]: field === 'region' ? region : current_time,
      });
      assert.equal(engine.httpOf(res), 400);
      assert.equal(res.error.details.field, field);
    }
  assert.equal(result('summary', { query: 8 }).error.details.field, 'query');
});

test('language enters its first matching pool, balances peers, then falls forward without wrapping', () => {
  const cfg = structuredClone(fixture);
  const index = cfg.endpoints.find((e) => e.id === 'index');
  const before = { ...index, id: 'before' }, peer = { ...index, id: 'peer' };
  cfg.endpoints.push(before, peer);
  const project = { ...cfg.projects[0], searchPools: [['before'], ['index', 'peer'], ['browser-s']] };
  cfg.routes.en = ['browser-s', 'index'];
  let now = 1_000_000;
  const runtime = new engine.EndpointDispatch(() => now);
  const search = (p = project) => engine.executeDemo('list', { query: 'wetland', language: 'en' }, p, cfg, 'r', 'en', runtime);
  assert.deepEqual([search(), search(), search()].map((r) => r.route.search.id), ['index', 'peer', 'index']);
  assert.equal(engine.routeChoice(cfg, project, 'search', 'en', undefined, runtime).id, 'peer');
  const firstRisk = runtime.markRisk(index);
  assert.equal(firstRisk, now + 30 * 60_000);
  assert.equal(search().route.search.id, 'peer');
  assert.equal(search({ ...project, id: 'another-project' }).route.search.id, 'peer');
  runtime.markRisk(peer);
  const fallback = search();
  assert.equal(fallback.route.search.startPool, 1);
  assert.equal(fallback.route.search.pool, 2);
  assert.equal(fallback.route.search.reason, 'fallback');
  assert.equal(fallback.route.search.id, 'browser-s');
  assert.equal(search({ ...project, searchPools: project.searchPools.slice(0, 2) }).response.error.code, 'SERVICE_UNAVAILABLE');
  const filtered = engine.executeDemo('list', { query: 'wetland', language: 'en', time_range: 'day' },
    { ...project, searchPools: project.searchPools.slice(0, 2) }, cfg, 'r', 'en', runtime);
  assert.equal(filtered.response.error.code, 'SERVICE_UNAVAILABLE');
  now = firstRisk - 1;
  assert.equal(search().route.search.id, 'browser-s');
  now = firstRisk;
  assert.equal(search().route.search.pool, 1);
  cfg.routes.en = ['outside-this-project'];
  assert.equal(search().route.search.id, 'before');
  let busy = true;
  const capacity = new engine.EndpointDispatch(Date.now, (id) => id !== 'before' || !busy);
  const attempts = [];
  engine.dispatchPool(cfg, project, 'search', 'en', undefined, capacity, 'sample', attempts, (e) => {
    busy = false;
    return e.id === 'browser-s' ? 'ok' : 'unavailable';
  });
  assert.deepEqual(attempts.map((d) => d.endpoint), ['index', 'peer', 'browser-s']);
  assert.equal(engine.routeChoice(cfg, project, 'search', 'en', undefined, capacity).id, 'before');
});

test('adapter risk is endpoint-scoped; both browser capabilities can receive and trigger fallback immediately', () => {
  for (const kind of ['search', 'reader']) {
    const cfg = structuredClone(fixture), browser = kind === 'search' ? 'browser-s' : 'browser-r';
    const ordinary = cfg.endpoints.find((e) => e.id === (kind === 'search' ? 'index' : 'reader'));
    const later = { ...ordinary, id: 'later' };
    cfg.endpoints.push(later);
    cfg.routes = {};
    const project = { ...cfg.projects[0], [kind === 'search' ? 'searchPools' : 'readerPools']: [[ordinary.id], [browser], ['later']] };
    let now = 10_000;
    const persisted = new Map(), storage = { read: (id) => persisted.get(id) || 0, write: (id, n) => persisted.set(id, n) };
    const runtime = new engine.EndpointDispatch(() => now, undefined, storage);
    const attempts = [];
    const choice = engine.dispatchPool(cfg, project, kind, 'zh', undefined, runtime, 'sample', attempts,
      (e) => e.id === 'later' ? 'ok' : 'risk');
    assert.equal(choice.id, 'later');
    assert.deepEqual(attempts.map((d) => [d.endpoint, d.reason]), [[ordinary.id, 'primary'], [browser, 'fallback'], ['later', 'fallback']]);
    assert.equal(runtime.blockedUntil(browser), undefined);
    assert.equal(persisted.has(browser), false);
    assert.equal(engine.routeChoice(cfg, project, kind, 'zh', undefined, runtime).id, browser);
    const firstUntil = runtime.blockedUntil(ordinary.id);
    now += 10_000;
    assert.ok(runtime.markRisk(ordinary) > firstUntil);
    assert.equal(runtime.markRisk(ordinary, now - 20_000), now + 30 * 60_000);
    const recovered = new engine.EndpointDispatch(() => now, undefined, storage);
    assert.equal(recovered.blockedUntil(ordinary.id), runtime.blockedUntil(ordinary.id));
    now += 30 * 60_000;
    const errors = [];
    engine.dispatchPool(cfg, project, kind, 'zh', undefined, recovered, 'sample', errors, () => 'unavailable');
    assert.deepEqual(errors.map((d) => d.endpoint), [ordinary.id, browser, 'later']);
    assert.equal(recovered.blockedUntil(ordinary.id), undefined);
    assert.equal(engine.routeChoice(cfg, project, kind, 'zh', undefined, recovered).id, ordinary.id);
  }
});

test('only actual dispatches advance pool rotation, including separate summary queries and page reads', () => {
  const cfg = structuredClone(fixture);
  cfg.routes = {};
  const project = { ...cfg.projects[0], searchPools: [['browser-s', 'index']], readerPools: [['browser-r', 'reader']] };
  const busy = new Set();
  const runtime = new engine.EndpointDispatch(Date.now, (id) => !busy.has(id));
  const run = (op, input) => engine.executeDemo(op, input, project, cfg, 'r', 'zh', runtime);
  assert.deepEqual(run('list', { query: '' }).attempts, []);
  busy.add('browser-s');
  assert.equal(engine.executionRoute(project, cfg, { query: '海岸湿地' }, runtime).search.id, 'index');
  busy.clear();
  assert.equal(engine.executionRoute(project, cfg, { query: '海岸湿地' }, runtime).search.id, 'browser-s');
  const summary = run('summary', {
    query: engine.contextualQuery.zh, region: '上海', current_time: '2026-05-01T00:30:00+08:00', source_count: 2,
  });
  assert.deepEqual(summary.attempts.filter((d) => d.kind === 'search').map((d) => d.endpoint), ['browser-s', 'index']);
  assert.deepEqual(summary.attempts.filter((d) => d.kind === 'reader').map((d) => d.endpoint), ['browser-r', 'reader']);
  const empty = run('list', { query: 'no-such-fixture' });
  assert.equal(empty.response.status, 'empty');
  assert.deepEqual(empty.attempts.map((d) => d.endpoint), ['browser-s']);
  assert.equal(run('content', { url: engine.articles[0].url }).route.reader.id, 'browser-r');
});

test('playground records actual attempts and retries; visiting observability does not change routing', async () => {
  const p = await pageFor();
  const cfg = structuredClone(fixture);
  const index = cfg.endpoints.find((e) => e.id === 'index');
  index.address = 'https://risk.example.invalid';
  cfg.endpoints.push({ ...index, id: 'healthy-peer', name: '同池搜索', address: 'https://peer.example.org' });
  cfg.projects[0].searchPools = [['index', 'healthy-peer'], ['browser-s']];
  cfg.routes.zh = ['index'];
  await p.evaluate((cfg) => localStorage.setItem('oas-preview-2:config', JSON.stringify(cfg)), cfg);
  await p.reload();
  const run = async (count) => {
    await p.evaluate(() => { location.hash = 'atlas/playground/list'; });
    await p.getByTestId('run').click();
    await p.waitForFunction((n) => JSON.parse(localStorage.getItem('oas-preview-2:runs') || '[]').length === n, count);
    return p.evaluate(() => JSON.parse(localStorage.getItem('oas-preview-2:runs'))[0]);
  };
  const first = await run(1);
  assert.deepEqual(first.dispatches.map((d) => [d.endpoint, d.outcome]), [['index', 'risk'], ['healthy-peer', 'ok']]);
  assert.deepEqual(engine.attempts(first).map((a) => [a.endpoint, a.status]), [['index', 'error'], ['healthy-peer', 'success']]);
  assert.equal(engine.attempts(first)[0].dispatch.outcome, 'risk');
  await nav(p, 'observability');
  assert.equal(await p.getByText('调度参考样本').count(), 0);
  await p.reload();
  const second = await run(2);
  assert.deepEqual(second.dispatches.map((d) => d.endpoint), ['healthy-peer']);
  assert.equal(second.resources.search, 'healthy-peer');
  await p.close();
});

test('ordered pools, shared credentials, inline material and excerpt fallback respect configuration', () => {
  const cfg = structuredClone(fixture),
    project = cfg.projects[0];
  assert.equal(engine.routeChoice(cfg, project, 'search', 'zh').id, 'browser-s');
  assert.equal(engine.routeChoice(cfg, project, 'search', 'en').id, 'index');
  cfg.endpoints.find((e) => e.id === 'browser-s').options.time_ranges = [];
  assert.equal(engine.routeChoice(cfg, project, 'search', 'zh', 'day').id, 'index');
  assert.equal(engine.routeChoice(cfg, { ...project, searchPools: [['index']] }, 'search', 'zh').id, 'index');
  const peer = { ...project, searchPools: [['browser-s', 'index']] },
    runtime = new engine.EndpointDispatch();
  const first = engine.routeChoice(cfg, peer, 'search', 'en', undefined, runtime);
  assert.equal(first.id, 'browser-s');
  assert.equal(engine.routeChoice(cfg, peer, 'search', 'en', undefined, runtime).id, first.id);
  runtime.dispatched(peer.id, 'search', first);
  assert.equal(engine.routeChoice(cfg, peer, 'search', 'en', undefined, runtime).id, 'index');
  const wire = engine.projectCommand(project, 'demo', project.version);
  assert.equal(wire.expected_version, 3);
  assert.equal(
    engine.projectProblem({ ...project, name: 'demo', searchPools: [['index'], ['index']] }, cfg)[0],
    'search_pools',
  );
  assert.equal(
    engine.projectProblem({ ...project, name: 'demo', readerPools: [[]] }, cfg)[0],
    'reader_pools',
  );
  const model = { ...cfg.endpoints.find((e) => e.kind === 'model'), name: 'Sample model' };
  assert.equal(engine.endpointProblem(model, 'replace', '')[0], 'secret.api_key');
  assert.equal(
    engine.endpointProblem({ ...model, options: { ...model.options, max_output_tokens: 0 } }, 'keep', '')[0],
    'options',
  );
  const q = { query: engine.missingBodySample[0] };
  assert.equal(result('summary', q, project, cfg).error.code, 'CONTENT_UNAVAILABLE');
  const fallback = result('summary', q, { ...project, allowSnippets: true }, cfg);
  assert.equal(fallback.status, 'partial');
  assert.equal(fallback.data.sources[0].kind, 'snippet');
  assert.equal(fallback.warnings[0].code, 'snippet_used');
  cfg.endpoints.find((e) => e.id === 'index').adapter = 'integrated_search';
  const integrated = { ...project, searchPools: [['index']], readerPools: [], pool: '' };
  assert.equal(result('summary', { query: '海岸湿地' }, integrated, cfg).data.sources[0].kind, 'body');
  assert.equal(
    result('content', { url: engine.articles[0].url }, integrated, cfg).error.code,
    'SERVICE_UNAVAILABLE',
  );
  const article = engine.articles[0],
    body = engine.articleData(article, 65),
    passages = engine.capturedPassages(article, 65, 'en');
  assert.ok(passages.length);
  for (const p of passages) assert.equal(Array.from(body.text).slice(p.start, p.end).join(''), p.text);
});

test('readable debug context, captured query variants, candidate spans and preserved drafts', async () => {
  const p = await pageFor();
  await nav(p, 'playground');
  await p.getByTestId('command').fill(engine.contextualQuery.zh);
  await p.getByRole('button', { name: '参数', exact: true }).click();
  await p.getByRole('button', { name: '请求参数', exact: true }).click();
  const input = p.getByTestId('request-facts'),
    context = p.getByTestId('rewrite-facts');
  assert.match(await input.innerText(), /项目默认/);
  assert.ok((await input.innerText()).includes(engine.contextualQuery.zh));
  assert.doesNotMatch(await context.innerText(), /地点参照|当地日期参照/);
  await p.getByTestId('context-time').fill('2026-05-01T00:30:00+08:00');
  assert.ok((await context.innerText()).includes('2026-05-01 00:30:00 (UTC+08:00)'));
  assert.doesNotMatch(await context.innerText(), /地点参照/);
  await p.getByTestId('context-region').fill('上海');
  assert.match(await context.innerText(), /上海/);
  await p.getByTestId('context-time').fill('');
  assert.doesNotMatch(await context.innerText(), /当地日期参照/);
  await p.getByTestId('context-time').fill('2026-05-01');
  await p.getByTestId('run').click();
  await p.locator('.fault').getByText('调用方当地时间', { exact: true }).waitFor();
  assert.equal(await p.locator('.fault pre').count(), 0);
  await p.getByTestId('context-time').fill('2026-05-01T00:30:00+08:00');
  await p.getByTestId('run').click();
  await p.getByTestId('cite-0').waitFor();
  const rid = await p.locator('.debug-request-id code').innerText();
  await p.getByTestId('cite-0').click();
  await p.locator('.focused-passage .passage-link').click();
  const target = p.getByRole('dialog').locator('.focused-passage details');
  await target.waitFor();
  assert.ok(await target.evaluate((el) => el.open));
  assert.match(p.url(), /segment=p1/);
  await p.keyboard.press('Escape');
  await p.getByTestId('trace-back').click();
  await p.locator('.response-bar').getByRole('button', { name: '请求记录' }).click();
  await p.getByTestId('stage-rewrite').click();
  assert.match(await p.locator('.stage-groups').innerText(), /上海2026-05-01/);
  const download = p.waitForEvent('download');
  await p.getByRole('button', { name: '导出记录' }).click();
  const file = await (await download).path();
  const md = readFileSync(file, 'utf8');
  assert.ok(md.includes(rid));
  assert.match(md, /## 来源、分段与引用/);
  assert.match(md, /## 执行阶段/);
  assert.doesNotMatch(md, /"request_payload"|^{/m);
  const saved = await p.evaluate(
    (rid) => JSON.parse(localStorage.getItem('oas-preview-2:runs')).find((r) => r.id === rid),
    rid,
  );
  const dump = engine.buildTraceExport(saved, fixture, 'zh');
  assert.equal(dump.request.metadata.request_id, rid);
  const summary = dump.request.execution_summary;
  assert.equal(
    summary.retrieval.variant_count,
    new Set(dump.calls.map((c) => c.variant_id).filter(Boolean)).size,
  );
  assert.equal(summary.retrieval.unique_candidates, dump.evidence.candidates.length);
  assert.equal(
    summary.score_batches.length,
    new Set(dump.calls.map((c) => c.score_batch_id).filter(Boolean)).size,
  );
  const actualIds = (kind) => [
    ...new Set(dump.calls.filter((c) => c.sent && c.kind === kind).map((c) => c.endpoint_id)),
  ];
  for (const kind of ['search', 'reader', 'model'])
    assert.deepEqual(
      summary.endpoints[kind].map((e) => e.endpoint_id),
      actualIds(kind),
    );
  assert.equal(dump.request.snapshot.project.version, 3);
  for (const h of dump.evidence.candidates.flatMap((c) => c.hits))
    assert.ok(dump.calls.some((c) => c.call_id === h.call_id));
  assert.ok(dump.evidence.segments.some((s) => s.cited && s.end_char > s.start_char));
  assert.ok(dump.request.spans.some((s) => s.stage === 'rewrite'));
  const browserCalls = dump.calls.filter((c) => c.browser_job);
  assert.ok(browserCalls.length);
  for (const c of browserCalls) {
    assert.equal(c.browser_job.pool_id, engine.wireId('ocean'));
    assert.equal(c.proxy_id, c.browser_job.proxy_id);
    assert.equal(c.browser_job.phases.at(-1).stage, 'cleanup');
    assert.equal(
      c.browser_job.phases.reduce((n, x) => n + x.duration_ms, 0),
      c.execution_ms,
    );
  }
  await p.getByTestId('stage-score').click();
  await p.locator('.candidate-rows button').first().click();
  const sheet = p.getByRole('dialog');
  await sheet.getByText('整体总结已引用', { exact: false }).first().waitFor();
  await sheet.getByText('文内范围', { exact: false }).first().click();
  assert.ok(await sheet.getByText('展开采集的原文', { exact: true }).isVisible());
  await p.keyboard.press('Escape');
  await p.getByTestId('trace-back').click();
  assert.equal(await p.locator('.debug-request-id code').innerText(), rid);
  await p.getByRole('button', { name: '搜索列表', exact: true }).click();
  assert.equal(await p.getByTestId('context-region').count(), 0);
  await p.getByRole('button', { name: '综合总结', exact: true }).click();
  assert.equal(await p.getByTestId('context-region').inputValue(), '上海');
  await p.close();
});

test('discarding a project draft requires an independent modal and keeping it restores the editor', async () => {
  const p = await pageFor();
  await nav(p, 'projects');
  const edit = p
    .locator('.project-card')
    .filter({ hasText: '海岸观测' })
    .getByRole('button', { name: '编辑', exact: true });
  const editor = p.getByRole('dialog', { name: '编辑项目' });
  const confirm = p.getByRole('alertdialog', { name: '放弃未保存的修改？' });
  const keep = confirm.getByRole('button', { name: '继续编辑' });
  const name = editor.getByTestId('project-name');

  await edit.click();
  await editor.getByRole('button', { name: '取消' }).click();
  await editor.waitFor({ state: 'detached' });
  assert.equal(await confirm.count(), 0);

  await edit.click();
  const original = await name.inputValue();
  await name.fill('未保存的项目草稿');
  await p.keyboard.press('Escape');
  await confirm.waitFor();
  assert.equal(await confirm.evaluate((el) => el.closest('.editor-frame') === null), true);
  assert.equal(await p.locator('.editor-frame').count(), 1);
  assert.equal(await keep.evaluate((el) => el === document.activeElement), true);
  await p.keyboard.press('Shift+Tab');
  assert.equal(await confirm.evaluate((el) => el.contains(document.activeElement)), true);
  await keep.click();
  await confirm.waitFor({ state: 'detached' });
  assert.equal(await name.inputValue(), '未保存的项目草稿');
  await p.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'project-name');

  const scroll = await editor.locator('.dialog-body').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  await editor.getByRole('button', { name: '取消' }).click();
  await confirm.waitFor();
  await p.mouse.click(2, 2);
  assert.ok(await confirm.isVisible());
  await p.keyboard.press('Escape');
  await confirm.waitFor({ state: 'detached' });
  assert.equal(await name.inputValue(), '未保存的项目草稿');
  assert.equal(await editor.locator('.dialog-body').evaluate((el) => el.scrollTop), scroll);

  await editor.getByRole('button', { name: '关闭', exact: true }).click();
  await confirm.getByRole('button', { name: '放弃修改', exact: true }).click();
  await p.locator('.editor-frame').waitFor({ state: 'detached' });
  await confirm.waitFor({ state: 'detached' });
  await edit.click();
  assert.equal(await name.inputValue(), original);
  await p.close();
});

test('the discard confirmation is centered and blocks the narrow dark editor behind it', async () => {
  const p = await pageFor();
  await nav(p, 'projects');
  await p.getByTestId('theme').click();
  await p.getByTestId('language').click();
  await p.setViewportSize({ width: 360, height: 720 });
  const edit = p.locator('.project-card').first().getByRole('button', { name: 'Edit', exact: true });
  await edit.click();
  const editor = p.getByRole('dialog', { name: 'Edit project' });
  await editor.getByTestId('project-name').fill('Unsaved preview');
  await p.mouse.click(2, 360);
  const confirm = p.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await confirm.waitFor();
  assert.ok(await p.locator('.editor-frame').evaluate((el) => !!el.closest('[inert], [aria-hidden="true"]')));
  const box = await confirm.boundingBox();
  assert.ok(box && box.width <= 360 - 24 && Math.abs(box.x + box.width / 2 - 180) < 2);
  assert.ok(Math.abs(box.y + box.height / 2 - 360) < 2);
  await confirm.getByRole('button', { name: 'Keep editing' }).click();
  assert.equal(await editor.getByTestId('project-name').inputValue(), 'Unsaved preview');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await confirm.getByRole('button', { name: 'Discard', exact: true }).click();
  await p.locator('.editor-frame').waitFor({ state: 'detached' });
  await p.waitForFunction((opener) => document.activeElement === opener, await edit.elementHandle());
  await p.close();
});

test('adapter-specific form, masked secret actions, tested version invalidation and dirty discard', async () => {
  const p = await pageFor();
  await nav(p, 'endpoints');
  await p
    .getByRole('group', { name: '接入点类型' })
    .getByRole('button', { name: '模型', exact: true })
    .click();
  await p.getByRole('button', { name: '添加模型接入点', exact: true }).click();
  const d = p.getByRole('dialog');
  assert.equal(await d.getByLabel('服务商').inputValue(), 'openai_compatible');
  await d.getByLabel('名称', { exact: true }).fill('诊断模型');
  await d.getByLabel('服务基址').fill('https://model-demo.invalid');
  await d.getByLabel('模型标识', { exact: true }).fill('example-chat');
  await d.getByLabel('单次超时（秒）').fill('2.5');
  await d.getByLabel('凭据操作').selectOption('replace');
  await d.getByLabel('示例 API Key').fill('fictional-demo-value');
  assert.equal(await d.locator('pre').count(), 0);
  await p.getByTestId('save-editor').click();
  const row = p.getByRole('row').filter({ hasText: '诊断模型' });
  await row.getByRole('button', { name: '诊断模型', exact: true }).click();
  assert.match(await d.innerText(), /example-chat/);
  assert.match(await d.innerText(), /2\.5 秒/);
  assert.doesNotMatch(await d.innerText(), /fictional-demo-value|max_input_tokens/);
  assert.equal(await d.locator('input,select,textarea,pre').count(), 0);
  await p.keyboard.press('Escape');
  await row.getByRole('button', { name: '测试', exact: true }).click();
  await p
    .locator('.test-receipt')
    .getByText(/无法连接到上游服务/)
    .waitFor();
  await row.getByRole('button', { name: '编辑 诊断模型', exact: true }).click();
  assert.equal(await d.getByLabel('能力类型').count(), 0);
  await d.getByLabel('服务基址').fill('https://model.example.org');
  await d.getByLabel('凭据操作').selectOption('clear');
  await p.getByTestId('save-editor').click();
  assert.match(await row.innerText(), /未测试/);
  assert.match(await row.innerText(), /未配置/);
  await row.getByRole('button', { name: '编辑 诊断模型', exact: true }).click();
  await d.getByLabel('模型标识', { exact: true }).fill('discard-me');
  await p.keyboard.press('Escape');
  await p.getByRole('alertdialog').getByRole('button', { name: '放弃修改', exact: true }).click();
  assert.ok(!(await p.evaluate(() => JSON.stringify(localStorage))).includes('fictional-demo-value'));
  await row.getByRole('button', { name: '编辑 诊断模型', exact: true }).click();
  assert.equal(await d.getByLabel('模型标识', { exact: true }).inputValue(), 'example-chat');
  await p.close();
});

test('route drafts, committed language decisions and independent project version conflicts', async () => {
  const p = await pageFor();
  await nav(p, 'languages');
  await p.getByLabel('规则语言', { exact: true }).selectOption('en');
  assert.match(await p.locator('.route-map tbody tr').filter({ hasText: '英语' }).innerText(), /文档索引/);
  await p.getByRole('button', { name: '移除优先成员 en 文档索引' }).click();
  await p.getByLabel('优先搜索接入点', { exact: true }).selectOption('browser-s');
  await p.getByRole('button', { name: '添加规则', exact: true }).click();
  assert.match(
    await p.locator('.route-map tbody tr').filter({ hasText: '英语' }).innerText(),
    /内置浏览器搜索/,
  );
  assert.ok(!(await p.evaluate(() => localStorage.getItem('oas-preview-2:config'))));
  await p.getByRole('button', { name: '保存路由' }).click();
  await nav(p, 'playground');
  await p.getByRole('button', { name: '参数', exact: true }).click();
  await p.getByLabel('输出语言', { exact: true }).selectOption('en');
  await p.getByTestId('run').click();
  await p.getByTestId('cite-0').waitFor();
  const log = await p.evaluate(() => JSON.parse(localStorage.getItem('oas-preview-2:runs'))[0]);
  assert.equal(log.resources.search, 'browser-s');
  assert.equal(log.snapshot.routesVersion, 2);
  await nav(p, 'projects');
  const project = p.locator('.project-card').filter({ hasText: '海岸观测' });
  await project.getByRole('button', { name: '编辑', exact: true }).click();
  await p.getByTestId('project-name').fill('编辑草稿');
  const other = await p.context().newPage();
  await other.goto(p.url());
  await other
    .locator('.project-card')
    .filter({ hasText: '海岸观测' })
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  await other.getByTestId('project-name').fill('已保存的配置');
  await other.getByTestId('save-editor').click();
  await p.getByTestId('save-editor').click();
  assert.equal(await p.getByTestId('project-name').inputValue(), '编辑草稿');
  await p.getByRole('button', { name: '载入最新版本', exact: true }).click();
  assert.equal(await p.getByTestId('project-name').inputValue(), '已保存的配置');
  await other.close();
  await p.close();
});
test('browser article attempt shows its frozen proxy and cleanup alongside the linked request', async () => {
  const p = await pageFor();
  await nav(p, 'playground');
  await p.getByRole('button', { name: '网页正文', exact: true }).click();
  await p.getByTestId('run').click();
  await p.locator('.read-result').waitFor();
  await p.locator('.response-bar').getByRole('button', { name: '请求记录' }).click();
  await p
    .getByRole('group', { name: '请求详情' })
    .getByRole('button', { name: '接入点', exact: true })
    .click();
  await p.getByRole('button', { name: '查看调用', exact: true }).first().click();
  const task = p.locator('.browser-job');
  await task.getByText('观测代理池', { exact: true }).waitFor();
  assert.match(await task.innerText(), /SOCKS5|HTTPS/);
  assert.equal(await task.locator('li').count(), 5);
  assert.match(await task.locator('li').last().innerText(), /回收上下文与租约/);
  await p.getByTestId('call-to-trace').click();
  await p.getByTestId('trace-back').click();
  assert.ok(await task.isVisible());
  await p.close();
});

test('project, adapter, proxy and pool details are readable and read-only across themes', async () => {
  const p = await pageFor();
  const modal = p.getByRole('dialog');
  await nav(p, 'projects');
  const card = p.locator('.project-card').filter({ hasText: '海岸观测' });
  await card.getByRole('button', { name: '详情', exact: true }).click();
  assert.equal(await modal.getByRole('heading', { name: '项目详情' }).count(), 1);
  const read = p.getByTestId('config-details');
  await read.getByText('40,000 字符', { exact: true }).waitFor();
  assert.match(await read.innerText(), /内置浏览器搜索/);
  assert.match(await read.innerText(), /允许的业务语言/);
  assert.equal(await read.locator('input,textarea,select,pre').count(), 0);
  await read.getByRole('button', { name: /观测代理池/ }).click();
  await modal.getByRole('heading', { name: '代理池详情' }).waitFor();
  await read.getByRole('button', { name: /观测出口 A/ }).click();
  await modal.getByRole('heading', { name: '代理详情' }).waitFor();
  assert.match(await read.innerText(), /SOCKS5/);
  assert.match(await read.innerText(), /已配置用户名和密码/);
  await p.keyboard.press('Escape');
  await card.getByRole('button', { name: '请求记录', exact: true }).click();
  assert.equal(await p.getByTestId('record-project').inputValue(), 'coastal');
  await nav(p, 'endpoints');
  for (const [kind, name, expected] of [
    ['搜索', '内置浏览器搜索', '搜索引擎'],
    ['搜索', '文档索引', 'Tavily'],
    ['搜索', 'SearXNG', '组件未安装'],
    ['正文', '内置浏览器正文', '从渲染网页提取'],
    ['正文', '文档读取器', 'AnySearch'],
    ['正文', 'Crawl4AI', '组件未安装'],
    ['模型', '通用生成模型', '8,192 Token'],
  ]) {
    await p
      .getByRole('group', { name: '接入点类型' })
      .getByRole('button', { name: kind, exact: true })
      .click();
    await p.getByRole('button', { name, exact: true }).click();
    assert.ok((await read.innerText()).includes(expected));
    assert.equal(await read.locator('pre,input,select,textarea').count(), 0);
    assert.doesNotMatch(
      await read.innerText(),
      /max_input_tokens|timeout_ms|secret_action|browser_proxy_pool_id/,
    );
    await p.keyboard.press('Escape');
  }
  await p.getByTestId('language').click();
  await p.getByTestId('theme').click();
  await p.getByRole('button', { name: 'General model', exact: true }).click();
  await p.setViewportSize({ width: 390, height: 844 });
  await read.getByText('Maximum input', { exact: true }).waitFor();
  assert.ok(await modal.getByRole('button', { name: 'Edit configuration' }).isVisible());
  assert.equal(await modal.evaluate((e) => e.scrollWidth <= e.clientWidth + 1), true);
  await p.close();
});

test('resource lists omit archive actions and proxy enablement remains reversible', async () => {
  const p = await pageFor();
  const archiveButtons = p.getByRole('button', { name: /归档|删除(?:接入点|代理)|archive|delete (?:endpoint|proxy|pool)/i });
  for (const english of [false, true]) {
    if (english) await p.getByTestId('language').click();
    await nav(p, 'endpoints');
    const kinds = p.getByRole('group', { name: english ? 'Endpoint type' : '接入点类型' });
    for (const kind of english ? ['Search', 'Reader', 'Model'] : ['搜索', '正文', '模型']) {
      await kinds.getByRole('button', { name: kind, exact: true }).click();
      assert.ok(await p.locator('.resource-table tbody tr').count());
      assert.equal(await archiveButtons.count(), 0);
    }
    await nav(p, 'proxies');
    assert.equal(await archiveButtons.count(), 0);
    const row = p.locator('.resource-table tbody tr').first();
    await row.getByRole('button', { name: english ? 'Disable proxy' : '停用代理', exact: true }).click();
    await p.getByRole('dialog').getByRole('button', { name: english ? 'Confirm' : '确认' }).click();
    await row.getByRole('button', { name: english ? 'Enable proxy' : '启用代理', exact: true }).click();
    await p.getByRole('dialog').getByRole('button', { name: english ? 'Confirm' : '确认' }).click();
    await p.getByRole('group', { name: english ? 'Network resources' : '网络资源' })
      .getByRole('button', { name: english ? /^Pools/ : /^代理池/ }).click();
    assert.ok(await p.getByRole('button', { name: english ? 'Edit members' : '编辑成员' }).count());
    assert.equal(await archiveButtons.count(), 0);
  }
  await p.close();
});

test('endpoint creation follows the current category and referenced resources open the owning configuration', async () => {
  const p = await pageFor();
  await nav(p, 'endpoints');
  await p
    .getByRole('group', { name: '接入点类型' })
    .getByRole('button', { name: '模型', exact: true })
    .click();
  await p.getByRole('button', { name: '添加模型接入点', exact: true }).click();
  assert.equal(await p.getByLabel('服务商').inputValue(), 'openai_compatible');
  assert.ok(await p.getByLabel('最大输出 Token').isVisible());
  await p.keyboard.press('Escape');
  await p.getByRole('button', { name: '通用生成模型', exact: true }).click();
  let modal = p.getByRole('dialog');
  await modal.getByRole('button', { name: /海岸观测/ }).click();
  await modal.getByRole('heading', { name: '项目详情' }).waitFor();
  await p.keyboard.press('Escape');
  await p
    .getByRole('group', { name: '接入点类型' })
    .getByRole('button', { name: '搜索', exact: true })
    .click();
  await p.getByRole('button', { name: '文档索引', exact: true }).click();
  await modal.getByRole('button', { name: '英语', exact: true }).click();
  assert.equal(await p.getByLabel('规则语言').inputValue(), 'en');
  await p.getByRole('button', { name: '移除优先成员 en 文档索引' }).click();
  await p.getByLabel('优先搜索接入点', { exact: true }).selectOption('browser-s');
  await p.getByRole('button', { name: '添加规则', exact: true }).click();
  await p.getByRole('button', { name: '重载', exact: true }).click();
  await modal.getByRole('button', { name: '继续编辑' }).click();
  await nav(p, 'projects');
  await nav(p, 'languages');
  assert.match(await p.locator('.route-map').innerText(), /未保存/);
  await p.getByRole('button', { name: '重载', exact: true }).click();
  await modal.getByRole('button', { name: '放弃修改并重载' }).click();
  assert.ok(await p.getByRole('button', { name: '移除优先成员 en 文档索引' }).isVisible());
  assert.ok(await p.getByRole('button', { name: '保存路由' }).isDisabled());
  await p.close();
});

test('an API example opens the exact operation and parameters, and a proxy test links back from its trace', async () => {
  const p = await pageFor();
  await nav(p, 'api');
  await p.locator('.ref-nav button').filter({ hasText: '综合总结' }).click();
  assert.equal(await p.locator('.reference-layout pre').count(), 0);
  await p.getByRole('button', { name: '在调试台运行' }).click();
  assert.equal(await p.getByTestId('context-region').inputValue(), '上海');
  assert.equal(await p.getByTestId('context-time').inputValue(), '2026-05-01T00:30:00+08:00');
  assert.equal(await p.getByLabel('来源上限', { exact: true }).inputValue(), '2');
  await p.getByTestId('debug-project').selectOption('library');
  await p.getByRole('button', { name: /项目配置/ }).click();
  assert.match(await p.getByTestId('config-details').innerText(), /知识检索/);
  await p.keyboard.press('Escape');
  await nav(p, 'proxies');
  await p.getByRole('button', { name: '添加代理', exact: true }).click();
  await p.getByLabel('显示名').fill('演示出口');
  await p.getByLabel('主机').fill('offline.invalid');
  await p.getByTestId('save-editor').click();
  const row = p.getByRole('row').filter({ hasText: '演示出口' });
  await row.getByRole('button', { name: '测试', exact: true }).click();
  await row.getByRole('button', { name: /测试失败/ }).click();
  await p.getByTestId('stage-test').waitFor();
  assert.equal(await p.getByTestId('stage-test').locator('.stage-point.error').count(), 1);
  await p.getByRole('button', { name: '请求与结果', exact: true }).click();
  assert.match(await p.locator('.trace-tab-panel').innerText(), /无法连接到上游服务/);
  assert.equal(await p.locator('.trace-detail pre').count(), 0);
  await p.getByTestId('trace-back').click();
  await p.locator('main.page-proxies').waitFor();
  await row.getByRole('button', { name: '编辑 演示出口' }).click();
  await p.getByLabel('主机').fill('reachable.example.org');
  await p.keyboard.press('Escape');
  await p.getByRole('button', { name: '继续编辑' }).click();
  await p.getByTestId('save-editor').click();
  assert.equal(await row.getByRole('button', { name: /测试失败/ }).count(), 0);
  await p.close();
});

test('restored snapshots and Markdown use the frozen record; incomplete evidence stays unavailable', () => {
  const rec = engine.history()[0],
    cfg = structuredClone(fixture),
    original = engine.projectOf(rec);
  assert.equal(engine.recordedScope(rec).version, original.version);
  const existing = {
    ...rec,
    generated: true,
    snapshot: { version: 28, sourceLimit: 2, search: 'x', reader: 'x', model: 'x', pool: '' },
  };
  assert.equal(engine.recordedScope(existing), existing.snapshot);
  assert.equal(engine.recordedScope({ ...existing, snapshot: undefined }), undefined);
  const missing = { ...rec, id: 'req_61' };
  assert.equal(engine.recordingComplete(missing), false);
  const view = engine.buildTraceExport(missing, cfg, 'en'),
    md = engine.traceMarkdown(view, 'en');
  assert.equal(view.request.request_payload, null);
  assert.deepEqual(view.evidence.segments, []);
  assert.match(md, /Incomplete/);
  assert.match(md, /Not recorded/);
  assert.doesNotMatch(md, /request_payload|^\s*\{\s*"/m);
});
test('paged project and endpoint lists reset to the matching resources and keep create scoped to the filter', async () => {
  const p = await pageFor();
  const cfg = structuredClone(fixture);
  for (let n = 1; n <= 21; n++) {
    cfg.projects.push({ ...cfg.projects[0], id: 'scoped-project-' + n, name: '分页项目 ' + n });
    cfg.endpoints.push({
      ...cfg.endpoints.find((e) => e.id === 'model'),
      id: 'scoped-model-' + n,
      name: '分页模型 ' + n,
    });
  }
  await p.evaluate((value) => localStorage.setItem('oas-preview-2:config', JSON.stringify(value)), cfg);
  await p.reload();
  await nav(p, 'projects');
  assert.equal(await p.locator('.project-card').count(), 20);
  await p.getByRole('button', { name: '下一页' }).click();
  assert.equal(await p.locator('.project-card').count(), 4);
  await p.getByRole('textbox', { name: '搜索项目' }).fill('分页项目 21');
  assert.equal(await p.locator('.project-card').count(), 1);
  await nav(p, 'endpoints');
  await p
    .getByRole('group', { name: '接入点类型' })
    .getByRole('button', { name: '模型', exact: true })
    .click();
  await p.getByRole('button', { name: '下一页' }).click();
  assert.equal(await p.locator('.resource-table tbody tr').count(), 2);
  await p.getByRole('textbox', { name: '搜索接入点' }).fill('分页模型 21');
  assert.equal(await p.locator('.resource-table tbody tr').count(), 1);
  await p.getByRole('button', { name: '添加模型接入点' }).click();
  assert.equal(await p.getByLabel('单次超时（秒）').inputValue(), '15');
  await p.close();
});

test('the regular workspace and saved trace links never render transport objects', async () => {
  const p = await pageFor();
  for (const id of [
    'overview',
    'projects',
    'endpoints',
    'proxies',
    'languages',
    'playground',
    'requests',
    'observability',
    'api',
  ]) {
    await nav(p, id);
    assert.doesNotMatch(await p.locator('main').innerText(), /预览提交内容|发送前查看请求|原始诊断/);
    assert.equal(await p.locator('main pre').count(), 0);
  }
  await nav(p, 'requests');
  await p.getByTestId('open-record').first().click();
  const hash = new URL(p.url());
  hash.hash = hash.hash.split('?')[0] + '?format=json';
  await p.goto(hash.href);
  for (const tab of ['执行过程', '请求与结果', '配置快照', '记录信息', '接入点']) {
    await p.getByRole('group', { name: '请求详情' }).getByRole('button', { name: tab, exact: true }).click();
    assert.equal(await p.locator('.trace-detail pre').count(), 0);
  }
  await p.close();
});
test('provider menus create exactly the supported search, reader and model endpoints and retain the selected provider', async () => {
  const p = await pageFor();
  await nav(p, 'endpoints');
  const tabs = p.getByRole('group', { name: '接入点类型' });
  assert.deepEqual(await tabs.getByRole('button').allTextContents(), ['搜索', '正文', '模型']);
  assert.equal(
    await tabs.getByRole('button', { name: '搜索', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  const categories = [
    ['搜索', 'search', ['browser', 'tavily', 'searxng', 'anysearch', 'deepseek']],
    ['正文', 'reader', ['browser', 'tavily', 'anysearch', 'crawl4ai', 'deepseek']],
    ['模型', 'model', ['openai_compatible']],
  ];
  for (const [label, kind, providers] of categories) {
    await tabs.getByRole('button', { name: label, exact: true }).click();
    for (const provider of providers) {
      await p.getByRole('button', { name: '添加' + label + '接入点', exact: true }).click();
      const dialog = p.getByRole('dialog'),
        field = dialog.getByLabel('服务商', { exact: true });
      assert.deepEqual(
        await field.locator('option').evaluateAll((nodes) => nodes.map((x) => x.value)),
        providers,
      );
      assert.equal(await dialog.getByLabel('能力类型', { exact: true }).count(), 0);
      await field.selectOption(provider);
      const name = '样例 ' + kind + ' ' + provider;
      await dialog.getByLabel('名称', { exact: true }).fill(name);
      if (provider === 'browser') assert.equal(await dialog.getByLabel('服务基址').count(), 0);
      else await dialog.getByLabel('服务基址').fill('https://service.example.org');
      if (provider === 'searxng') await dialog.getByLabel('引擎列表（逗号分隔）').fill('alpha,beta');
      if (provider === 'crawl4ai') await dialog.getByLabel('上游正文格式').selectOption('html');
      await dialog.getByTestId('save-editor').click();
      await dialog.waitFor({ state: 'detached' });
      const cfg = await p.evaluate(() => JSON.parse(localStorage.getItem('oas-preview-2:config')));
      const endpoint = cfg.endpoints.find((e) => e.name === name);
      assert.equal(endpoint.provider, provider);
      assert.equal(endpoint.kind, kind);
      assert.equal(engine.available(cfg, endpoint.id), true);
      assert.equal(
        endpoint.adapter,
        provider === 'browser'
          ? kind === 'search'
            ? 'browser_search'
            : 'browser_reader'
          : kind === 'model'
            ? 'chat_model'
            : kind === 'search'
              ? 'http_search'
              : 'http_reader',
      );
      if (provider === 'searxng') assert.deepEqual(endpoint.options.engines, ['alpha', 'beta']);
      if (provider === 'crawl4ai') assert.equal(endpoint.options.format, 'html');
      assert.equal(cfg.addons.searxng, false);
      assert.equal(cfg.addons.crawl4ai, false);
    }
  }
  await p.reload();
  await tabs.getByRole('button', { name: '正文', exact: true }).click();
  await p.getByRole('button', { name: '样例 reader deepseek', exact: true }).click();
  assert.match(await p.getByTestId('config-details').innerText(), /DeepSeek/);
  await p.getByRole('button', { name: '编辑配置' }).click();
  assert.equal(await p.getByLabel('服务商', { exact: true }).count(), 0);
  await p.keyboard.press('Escape');
  await nav(p, 'projects');
  const project = p.locator('.project-entry').filter({ hasText: '知识检索' });
  await project.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = p.getByRole('dialog');
  await editor.getByRole('button', { name: '移除成员 文档索引', exact: true }).click();
  await editor
    .getByLabel('搜索池添加成员 1', { exact: true })
    .selectOption({ label: '样例 search deepseek' });
  await editor.getByRole('button', { name: '移除成员 文档读取器', exact: true }).click();
  await editor
    .getByLabel('正文池添加成员 1', { exact: true })
    .selectOption({ label: '样例 reader anysearch' });
  await editor.getByTestId('save-editor').click();
  await project.getByRole('button', { name: '调试', exact: true }).click();
  await p.getByTestId('run').click();
  await p.getByTestId('cite-0').waitFor();
  const run = await p.evaluate(() => JSON.parse(localStorage.getItem('oas-preview-2:runs'))[0]);
  assert.equal(run.snapshot.endpoints[run.resources.search].provider, 'deepseek');
  assert.equal(run.snapshot.endpoints[run.resources.reader].provider, 'anysearch');
  assert.ok(run.snapshot.wire.endpoints.some((e) => e.provider === 'deepseek' && e.kind === 'search'));

  await p.close();
});

test('rewrite and retrieval cards show observed query, dispatch, timing and hit evidence; trace drawers occupy 40% on desktop', async () => {
  const p = await pageFor();
  await nav(p, 'requests');
  await p.getByTestId('open-record').first().click();
  await p.getByTestId('stage-rewrite').click();
  const rewrite = p.getByTestId('query-stage-rewrite');
  assert.equal(await rewrite.locator('.variant-fact').count(), 2);
  assert.match(await rewrite.locator('.query-stage-numbers').innerText(), /执行模型[\s\S]*通用生成模型/);
  const next = rewrite.locator('.variant-fact').nth(1);
  assert.match(await next.innerText(), /已参与检索/);
  await next.getByRole('button', { name: '查看本条检索' }).click();
  assert.match(p.url(), /variant=Q1/);
  const search = p.getByTestId('query-stage-search'),
    branch = search.locator('.variant-focused');
  const record = engine.history()[0],
    groups = engine.retrievalGroups(record),
    raw = groups.reduce((n, g) => n + g.hits.length, 0);
  assert.deepEqual(
    await search.locator('.query-stage-numbers dd').allTextContents(),
    [2, raw, engine.uniqueHits(groups).length, raw - engine.uniqueHits(groups).length].map(String),
  );
  assert.match(await branch.innerText(), /内置浏览器搜索/);
  await branch.locator('.query-attempts summary').click();
  const actual = engine.attempts(record).find((c) => c.variantId === 'Q1');
  assert.match(await branch.locator('.query-attempt').innerText(), new RegExp(actual.duration + ' ms'));
  assert.ok((await branch.locator('.query-attempt').innerText()).includes(actual.id));
  assert.equal(await branch.locator('.query-hits button').count(), groups[1].hits.length);
  await branch.locator('.query-hits button').first().click();
  const sheet = p.getByRole('dialog', { name: '候选材料' });
  await sheet.waitFor();
  for (const [width, target] of [
    [1440, 576],
    [1920, 768],
    [3840, 1536],
    [900, 520],
    [390, 390],
  ]) {
    await p.setViewportSize({ width, height: 900 });
    const rect = await sheet.boundingBox(),
      close = await sheet.getByRole('button', { name: '关闭', exact: true }).boundingBox();
    assert.ok(Math.abs(rect.width - target) <= 2, 'drawer width at ' + width + ': ' + rect.width);
    assert.ok(Math.abs(rect.x + rect.width - width) <= 2);
    assert.ok(close.x + close.width > width - 40 && close.x + close.width <= width && close.y < 65);
    assert.equal(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
  }
  const header = sheet.locator('.inspect-head');
  const before = await header.boundingBox();
  assert.ok(
    await sheet.locator('.inspect-body').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop > 0;
    }),
  );
  assert.ok(Math.abs((await header.boundingBox()).y - before.y) < 1);
  await sheet.getByRole('button', { name: '关闭', exact: true }).click();
  await sheet.waitFor({ state: 'detached' });
  assert.match(p.url(), /variant=Q1/);
  await p.close();
});

test('project footer actions align at desk and phone widths, with key rotation reachable in details', async () => {
  const p = await pageFor();
  await nav(p, 'projects');
  const cards = p.locator('.project-entry');
  for (const width of [1920, 1440, 768, 390]) {
    await p.setViewportSize({ width, height: 900 });
    for (const card of await cards.all()) {
      const buttons = card.locator('footer button');
      assert.deepEqual(await buttons.allTextContents(), ['详情', '请求记录', '调试']);
      const boxes = await buttons.evaluateAll((items) =>
        items.map((el) => {
          const b = el.getBoundingClientRect();
          return [b.top, b.width, b.height, el.scrollWidth <= el.clientWidth + 1];
        }),
      );
      assert.ok(
        boxes.every(
          (b) =>
            Math.abs(b[0] - boxes[0][0]) < 1 &&
            Math.abs(b[1] - boxes[0][1]) < 2 &&
            b[2] === boxes[0][2] &&
            b[3],
        ),
      );
    }
  }
  const card = cards.first();
  await card.getByRole('button', { name: '详情', exact: true }).click();
  await p.getByRole('dialog').getByRole('button', { name: '轮换项目密钥' }).click();
  await p.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
  assert.match(await p.getByRole('dialog').innerText(), /demo_/);
  await p.close();
});

test('language rules add a unique pair to a draft, remove the last member, and restore project pool order', async () => {
  const p = await pageFor();
  await nav(p, 'languages');
  assert.equal(await p.getByText('项目匹配结果', { exact: true }).count(), 0);
  assert.equal(await p.getByLabel('预览项目').count(), 0);
  const add = p.getByRole('button', { name: '添加规则', exact: true }),
    member = p.getByLabel('优先搜索接入点', { exact: true });
  await p.getByLabel('规则语言', { exact: true }).selectOption('en');
  assert.ok(await add.isDisabled());
  const en = p.locator('.route-map tbody tr').filter({ hasText: '英语' });
  await en.getByRole('button', { name: '移除语言' }).click();
  assert.equal(await en.count(), 0);
  await member.selectOption('browser-s');
  await add.click();
  assert.match(await en.innerText(), /内置浏览器搜索/);
  assert.equal(await member.locator('option[value="browser-s"]').count(), 0);
  assert.ok(await add.isDisabled());
  await p.getByRole('button', { name: '保存路由' }).click();
  await p.reload();
  assert.ok((await en.innerText()).includes('内置浏览器搜索'));
  await en.getByRole('button', { name: '移除优先成员 en 内置浏览器搜索' }).click();
  await p.getByRole('button', { name: '保存路由' }).click();
  const cfg = await p.evaluate(() => JSON.parse(localStorage.getItem('oas-preview-2:config')));
  assert.equal(cfg.routes.en, undefined);
  await nav(p, 'playground');
  await p.getByRole('button', { name: '参数', exact: true }).click();
  await p.getByLabel('输出语言', { exact: true }).selectOption('en');
  await p.getByTestId('run').click();
  await p.getByTestId('cite-0').waitFor();
  const run = await p.evaluate(() => JSON.parse(localStorage.getItem('oas-preview-2:runs'))[0]);
  assert.equal(run.resources.search, 'browser-s');
  assert.equal(run.snapshot.routesVersion, cfg.routesVersion);
  await p.close();
});
test('unassigned HTTP configurations retain references, and a rewrite records generated queries separately from dispatched variants', () => {
  const cfg = engine.hydrateConfig({
    ...fixture,
    endpoints: [
      ...fixture.endpoints,
      { ...fixture.endpoints.find((e) => e.id === 'index'), id: 'unclassified', provider: undefined },
    ],
  });
  const endpoint = cfg.endpoints.find((e) => e.id === 'unclassified');
  assert.equal(endpoint.provider, null);
  assert.equal(engine.available(cfg, endpoint.id), false);
  assert.equal(engine.endpointProblem({ ...endpoint, name: 'Example' }, 'keep', '')[0], 'provider');
  const r = { ...engine.history()[0], rewrites: ['extra search'] };
  const searched = [{ id: 'Q0', query: engine.queryText(r), hits: [] }];
  assert.deepEqual(
    engine.rewriteGroups(r, searched).map((g) => [g.id, g.query]),
    [
      ['Q0', engine.queryText(r)],
      ['Q1', 'extra search'],
    ],
  );
  assert.equal(searched.length, 1);
});
test('changing the provider before creation clears vendor-specific fields and never carries a key to the next service', async () => {
  const p = await pageFor();
  await nav(p, 'endpoints');
  await p.getByRole('button', { name: '添加搜索接入点', exact: true }).click();
  const d = p.getByRole('dialog'),
    select = d.getByLabel('服务商', { exact: true });
  await select.selectOption('searxng');
  await d.getByLabel('名称', { exact: true }).fill('规则验证搜索');
  await d.getByLabel('服务基址').fill('https://one.example.org');
  await d.getByLabel('引擎列表（逗号分隔）').fill('sample');
  await d.getByLabel('凭据操作').selectOption('replace');
  await d.getByLabel('示例 API Key').fill('local-only-sample');
  await select.selectOption('browser');
  assert.equal(await d.getByLabel('服务基址').count(), 0);
  assert.equal(await d.getByLabel('凭据操作').count(), 0);
  await select.selectOption('anysearch');
  assert.equal(await d.getByLabel('服务基址').inputValue(), '');
  assert.equal(await d.getByLabel('引擎列表（逗号分隔）').count(), 0);
  await d.getByLabel('服务基址').fill('https://two.example.org');
  await d.getByTestId('save-editor').click();
  await d.waitFor({ state: 'detached' });
  const saved = await p.evaluate(() =>
    JSON.parse(localStorage.getItem('oas-preview-2:config')).endpoints.find((e) => e.name === '规则验证搜索'),
  );
  assert.equal(saved.provider, 'anysearch');
  assert.equal(saved.hasSecret, false);
  assert.equal(saved.options.engines, undefined);
  assert.equal(engine.endpointProblem({ ...saved, provider: 'crawl4ai' }, 'keep', '')[0], 'provider');
  assert.ok(!(await p.evaluate(() => JSON.stringify(localStorage))).includes('local-only-sample'));
  await p.close();
});
test('management endpoint fields and the selectable provider catalog agree on capabilities and protocols', () => {
  const parse = requireTools('yaml').parse;
  const contractDir = resolve(root, '..', 'contracts');
  const spec = parse(readFileSync(join(contractDir, 'management.openapi.yaml'), 'utf8')).components.schemas;
  const binding = parse(readFileSync(join(contractDir, 'endpoint-provider.schema.yaml'), 'utf8'));
  for (const name of ['EndpointCreate', 'EndpointUpdate', 'EndpointView']) {
    assert.ok(spec[name].required.includes('provider'));
    assert.ok(spec[name].allOf.some((rule) => rule.$ref === '#/components/schemas/EndpointAdapterRules'));
  }
  assert.ok(spec.EndpointAdapterRules.allOf.some((rule) => rule.$ref === './endpoint-provider.schema.yaml'));
  const matches = (rule, value) => rule.const === value || !!rule.enum?.includes(value);
  const protocols = [
    'browser_search',
    'http_search',
    'integrated_search',
    'browser_reader',
    'http_reader',
    'chat_model',
  ];
  for (const kind of Object.keys(engine.providerCatalog)) {
    const choices = engine.providerCatalog[kind].map((entry) => entry.provider);
    for (const provider of [...spec.EndpointProvider.enum, 'unsupported']) {
      const rows = binding.oneOf
        .map((x) => x.properties)
        .filter((fields) => matches(fields.kind, kind) && matches(fields.provider, provider));
      assert.equal(choices.includes(provider), rows.length > 0);
      for (const adapter of protocols)
        assert.equal(
          engine.acceptsProvider(kind, provider, adapter),
          rows.some((fields) => matches(fields.adapter, adapter)),
        );
    }
  }
});
