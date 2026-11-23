import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {fixture} from './fixture.mjs';

const execute = promisify(execFile);
async function docker(...args) {
  return (await execute('docker', args, {timeout: 30000})).stdout.trim();
}

async function processTable(container) {
  // Read the PID namespace itself. The runtime's cgroup process list can omit zombies.
  const table = await docker('exec', container, 'sh', '-c', 'cat /proc/[0-9]*/stat 2>/dev/null || :');
  return table.split('\n').flatMap(line => {
    const match = /^(\d+) \((.*)\) (\S) (\d+) (\d+) /.exec(line);
    if (!match) return [];
    const [, pid, name, state, parent, group] = match;
    return [{pid, parent, group, state, name}];
  });
}

async function eventually(check, message, timeout = 10000) {
  const end = Date.now() + timeout;
  do {
    if (await check()) return;
    await delay(100);
  } while (Date.now() < end);
  assert.fail(typeof message === 'function' ? message() : message);
}

async function assertReaped(container, group) {
  let remaining;
  await eventually(async () => {
    remaining = (await processTable(container)).filter(p => p.group === group || p.state === 'Z');
    return remaining.length === 0;
  }, () => `retired group or zombies still present (${remaining.length}): ${JSON.stringify(remaining.slice(0, 4))}`);
}

test('retired Firefox process trees are fully reaped between jobs in the same worker', {timeout: 120000}, async t => {
  const image = process.env.OAS_TEST_BROWSER_IMAGE;
  assert.ok(image, 'Set OAS_TEST_BROWSER_IMAGE to the browser image under test');
  const container = 'oas-reaping-' + randomUUID();
  const key = randomUUID();
  const site = await fixture(0);
  const articleOrigin = 'http://host.docker.internal:' + site.address().port;
  t.after(() => {
    for (const release of site.held || []) release();
    site.closeAllConnections();
    return new Promise(resolve => site.close(resolve));
  });

  await docker('create', '--init=false', '--name', container, '--label', 'oas.test=browser-reaping',
    '--publish', '127.0.0.1::8090', '--shm-size=256m', '--add-host', 'host.docker.internal:host-gateway',
    '-e', 'OAS_WORKER_KEY=' + key, '-e', 'POD_UID=' + container, '-e', 'OAS_WORKER_SLOTS=1',
    '-e', 'OAS_TEST_GOOGLE_ORIGIN=' + articleOrigin, '-e', 'OAS_TEST_BAIDU_ORIGIN=' + articleOrigin + '/refused',
    '-e', 'OAS_EGRESS_ALLOW_HOSTS=host.docker.internal', image);
  t.after(() => docker('rm', '-fv', container));
  await docker('start', container);
  const base = 'http://' + await docker('port', container, '8090/tcp');
  const ready = async () => (await fetch(base + '/health/ready', {signal: AbortSignal.timeout(3000)})).json();
  let initial;
  await eventually(async () => {
    try { initial = await ready(); return initial.status === 'ready'; } catch { return false; }
  }, 'worker did not become ready');

  const newJob = () => ({
    job_id: randomUUID(), request_id: randomUUID(), owner: 'reaping-test', pod_uid: container, deadline_ms: 30000
  });
  const command = async (job, action, fields = {}) => {
    const response = await fetch(base + '/internal/jobs', {
      method: 'POST', headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'},
      body: JSON.stringify({...job, action, ...fields}), signal: AbortSignal.timeout(30000)
    });
    return response.json();
  };

  for (let cycle = 0; cycle < 3; cycle++) {
    const job = newJob();
    assert.equal((await command(job, 'open')).opened, true);
    const path = '/hold-article?job=' + job.job_id;
    const navigating = command(job, 'extract', {url: articleOrigin + path});
    try {
      await eventually(() => site.requests.some(r => r.request_url === path), 'Firefox did not reach the held article');
      const before = await processTable(container);
      const driver = before.find(p => p.name === 'firefox-esr' && p.pid === p.group && p.state !== 'Z');
      assert.ok(driver, 'expected the directly launched Firefox process');
      const group = before.filter(p => p.group === driver.group);
      assert.ok(group.some(p => p.name === 'firefox-esr' && p.state !== 'Z'), 'expected live Firefox in this job');
      assert.ok(group.some(p => p.parent !== driver.pid && p.pid !== driver.pid && p.state !== 'Z'),
        'expected Firefox descendants before cancellation');
      assert.equal((await command(job, 'cancel')).closed, true);
      assert.equal((await navigating).code, 'CANCELLED');

      // Keep the worker running. A container restart would hide the original zombie leak.
      await assertReaped(container, driver.group);
      const state = await ready();
      assert.equal(state.boot_id, initial.boot_id);
      assert.equal(state.free_slots, initial.free_slots);
    } finally {
      for (const release of site.held?.splice(0) || []) release();
      await navigating.catch(() => {});
    }
  }

  const job = newJob();
  assert.equal((await command(job, 'open')).opened, true);
  assert.match((await command(job, 'extract', {url: articleOrigin + '/article'})).body, /Rainfall measurements/);
  assert.equal((await command(job, 'close')).closed, true);

  // With no business job active, a failed background homepage refresh must also
  // retire its Firefox tree. A healthy route then repopulates the same slot.
  const idleDriver = (await processTable(container)).find(p => p.name === 'firefox-esr' && p.pid === p.group);
  assert.ok(idleDriver);
  const configure = async engine => {
    const response = await fetch(base + '/internal/search-pages', {
      method: 'POST', headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'},
      body: JSON.stringify([{proxy: null, engine}]), signal: AbortSignal.timeout(3000)
    });
    assert.ok(response.ok);
  };
  await configure('baidu');
  await eventually(() => site.requests.some(r => r.path === '/refused'), 'background refresh did not run');
  await assertReaped(container, idleDriver.group);
  await configure('google');
  await eventually(async () => (await ready()).warm_slots === 1, 'replacement slot did not warm up');
  assert.equal((await ready()).boot_id, initial.boot_id);
  assert.equal((await ready()).free_slots, 1);
  await docker('stop', '--time', '15', container);
  assert.equal(await docker('inspect', '--format', '{{.State.ExitCode}}', container), '0');
});
