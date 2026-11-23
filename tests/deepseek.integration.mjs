import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fixture } from './fixture.mjs';
import { settled } from './support.mjs';

const base = process.env.OAS_TEST_API || 'http://127.0.0.1:18080';
const upstream = process.env.OAS_TEST_FIXTURE_BASE || 'http://host.docker.internal:18780';
const fixtureKey = 'synthetic-deepseek-credential';
let server, cookie, csrf;

async function admin(path, body, method = body ? 'POST' : 'GET', expected = 200) {
  const response = await fetch(base + '/admin/v1/' + path, {
    method,
    headers: { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value.data;
}

async function endpoint(kind, address, adapter) {
  return admin('endpoints', {
    name: 'DeepSeek native ' + kind,
    provider: 'deepseek',
    kind,
    adapter: adapter || (kind === 'search' ? 'http_search' : 'http_reader'),
    base_url: address,
    secret: { api_key: fixtureKey },
    timeout_ms: 8000,
    max_concurrency: 4,
    rpm: 1000,
    options: kind === 'reader' ? { format: 'markdown' } : {},
  }, 'POST', 201);
}

async function project(search, reader) {
  return admin('projects', {
    name: 'DeepSeek native regression',
    search_pools: search ? [[search.id]] : [],
    reader_pools: reader ? [[reader.id]] : [],
    rewrite_count: 0,
  }, 'POST', 201);
}

async function business(made, operation, input, expected = 200) {
  const response = await fetch(base + '/v1/search/' + operation, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + made.api_key, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  await settled(base, value.request_id, { Cookie: cookie });
  return value;
}

before(async () => {
  server = await fixture();
  const response = await fetch(base + '/admin/v1/session', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: process.env.OAS_TEST_PASSWORD || 'admin123' }),
  });
  assert.equal(response.status, 200);
  cookie = response.headers.get('set-cookie').split(';')[0];
  csrf = (await response.json()).data.csrf_token;
});

after(() => {
  server?.closeAllConnections();
  server?.close();
});

test('DeepSeek native search and fetch accept an origin or a versioned base without duplicating v1', async () => {
  for (const suffix of ['', '/', '/v1', '/v1/']) {
    const search = await endpoint('search', upstream + suffix);
    const reader = await endpoint('reader', upstream + suffix);
    const made = await project(search, reader);
    const start = server.requests.length;
    const list = await business(made, 'list', { query: '雨量测量🙂', count: 1 });
    const request = server.requests[start];
    assert.equal(request.path, '/v1/tools/search');
    assert.equal(request.method, 'POST');
    assert.equal(request.authorization, 'Bearer ' + fixtureKey);
    assert.deepEqual(request.input, { query: '雨量测量🙂', count: 1, need_content: false });
    assert.equal(list.data.items.length, 1);

    const url = list.data.items[0].url + '#measurements';
    const bodyStart = server.requests.length;
    const content = await business(made, 'content', { url });
    const extraction = server.requests[bodyStart];
    assert.equal(extraction.path, '/v1/tools/fetch');
    assert.equal(extraction.method, 'POST');
    assert.equal(extraction.authorization, 'Bearer ' + fixtureKey);
    assert.deepEqual(extraction.input, { url });
    assert.equal(content.data.url, url);
    assert.equal(content.data.final_url, undefined);
    assert.match(content.data.markdown, /Rainfall/);
    assert.match(content.data.text, /rainfall/);
    assert.equal(content.data.lengths.text.retained, [...content.data.text].length);
    const exported = await admin('requests/' + content.request_id + '/export');
    assert.equal(exported.calls.filter(c => c.sent).length, 1);
    assert.equal(exported.calls[0].kind, 'reader');
    assert.ok(!JSON.stringify(exported).includes(fixtureKey));
  }
});

test('DeepSeek capability tests and inline content use the same native paths and credential', async () => {
  for (const [kind, path] of [['search', '/v1/tools/search'], ['reader', '/v1/tools/fetch']]) {
    const resource = await endpoint(kind, upstream + '/v1');
    const start = server.requests.length;
    const receipt = await admin('endpoints/' + resource.id + '/test', {});
    assert.equal(receipt.status, 'success');
    assert.equal(server.requests[start].path, path);
    assert.equal(server.requests[start].authorization, 'Bearer ' + fixtureKey);
  }
  const integrated = await endpoint('search', upstream + '/v1', 'integrated_search');
  const made = await project(integrated);
  const start = server.requests.length;
  await business(made, 'list', { query: 'weather', count: 1 });
  assert.equal(server.requests[start].input.need_content, true);
});

test('DeepSeek keeps provider capability limits and empty versus unavailable responses', async () => {
  const search = await endpoint('search', upstream + '/v1');
  const made = await project(search);
  const before = server.requests.length;
  const long = await business(made, 'list', { query: '雨'.repeat(129) }, 400);
  assert.equal(long.error.code, 'QUERY_UNSUPPORTED');
  const ranged = await business(made, 'list', { query: 'rain', time_range: 'day' }, 400);
  assert.equal(ranged.error.code, 'TIME_RANGE_UNSUPPORTED');
  assert.equal(server.requests.length, before);
  await business(made, 'list', { query: '雨'.repeat(128), count: 1 });

  const empty = await endpoint('search', upstream + '/case/empty/v1');
  assert.equal((await business(await project(empty), 'list', { query: 'rain' })).status, 'empty');
  const reader = await endpoint('reader', upstream + '/case/emptycontent/v1');
  const noBody = await business(await project(undefined, reader), 'content', { url: upstream + '/article' }, 502);
  assert.equal(noBody.error.code, 'CONTENT_UNAVAILABLE');
  for (const kind of ['search', 'reader']) {
    const denied = await endpoint(kind, upstream + '/requires-key/v1');
    const configured = await project(kind === 'search' ? denied : undefined, kind === 'reader' ? denied : undefined);
    const failed = await business(configured, kind === 'search' ? 'list' : 'content',
      kind === 'search' ? { query: 'rain' } : { url: upstream + '/article' }, 502);
    assert.equal(failed.error.code, 'UPSTREAM_CREDENTIALS_INVALID');
    assert.ok(!JSON.stringify(failed).includes(fixtureKey));
  }
});

test('Atlas offers DeepSeek for both native capabilities and submits the native configuration', async () => {
  const require = createRequire(new URL('../web/package.json', import.meta.url));
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(existsSync),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.setDefaultTimeout(10000);
    await page.goto(base);
    await page.getByLabel('用户名', { exact: true }).fill('admin');
    await page.getByLabel('口令', { exact: true }).fill(process.env.OAS_TEST_PASSWORD || 'admin123');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('heading', { name: '运行总览', exact: true }).waitFor();
    await page.getByTestId('nav-endpoints').click();
    for (const [kind, label] of [['search', '搜索'], ['reader', '正文']]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.getByRole('button', { name: '新建', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '新建接入点', exact: true });
      await dialog.getByRole('button', { name: '服务商', exact: false }).click();
      await page.getByRole('option', { name: /deepseek/i, exact: true }).click();
      assert.equal(await dialog.getByLabel('原生服务基址', { exact: true }).inputValue(), 'https://api.deepseek.com');
      assert.ok((await dialog.innerText()).includes(kind === 'search' ? '128' : 'Markdown'));
      await dialog.getByLabel('名称', { exact: true }).fill('DeepSeek UI ' + kind);
      await dialog.getByLabel('原生服务基址', { exact: true }).fill(upstream + '/v1');
      await dialog.getByLabel('API Key', { exact: true }).fill(fixtureKey);
      const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/admin/v1/endpoints');
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
      const saved = await response;
      assert.equal(saved.status(), 201);
      const resource = (await saved.json()).data;
      assert.equal(resource.provider, 'deepseek');
      assert.equal(resource.kind, kind);
      assert.equal(resource.has_secret, true);
      const receipt = await admin('endpoints/' + resource.id + '/test', {});
      assert.equal(receipt.status, 'success');
      await dialog.waitFor({ state: 'detached' });
    }
    assert.deepEqual(errors, []);
    assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(fixtureKey));
  } finally {
    await browser.close();
  }
});
