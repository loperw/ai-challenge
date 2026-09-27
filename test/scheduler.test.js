const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ScheduleStore, startScheduler } = require('../scheduler');

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-schedule-'));
  const file = path.join(dir, 'test.sqlite');
  const stores = [];
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const open = () => { const store = new ScheduleStore(file); stores.push(store); return store; };
  return { store: open(), open, file };
}

test('delayed reminder survives reconnect and runs only when due', t => {
  const { store, open } = database(t);
  const job = store.create({ kind: 'reminder', message: 'Перерыв', delaySeconds: 60 }, 1000);
  const restarted = open();
  assert.equal(restarted.claim(60_999), null);
  const claimed = restarted.claim(61_000);
  assert.equal(claimed.id, job.id);
  restarted.finish(claimed, { message: 'Перерыв' }, null, 61_001);
  assert.equal(store.get(job.id).status, 'completed');
  assert.equal(store.results(job.id).runs[0].result.message, 'Перерыв');
  assert.equal(store.claim(120_000), null);
});

test('multiple workers cannot claim a live lease; expired lease recovers and rejects stale results', t => {
  const { store, open } = database(t);
  const second = open();
  const job = store.create({ kind: 'weather', location: 'Москва', intervalSeconds: 60 }, 0);
  const firstClaim = store.claim(0);
  assert.equal(second.claim(1), null);
  const retry = second.claim(60_001);
  store.finish(firstClaim, { current: { temperature: 999 } }, null, 60_002);
  assert.equal(store.results(job.id).runs.length, 0);
  second.finish(retry, { current: { temperature: 10 } }, null, 60_002);
  assert.equal(store.results(job.id).runs.length, 1);
  assert.equal(store.get(job.id).nextRunAt, new Date(120_000).toISOString());
});

test('periodic weather aggregates history, records failures and skips missed intervals', t => {
  const { store } = database(t);
  const job = store.create({ kind: 'weather', location: 'Москва', intervalSeconds: 60 }, 0);
  store.finish(store.claim(0), { current: { temperature: 10 } }, null, 1);
  store.finish(store.claim(60_000), null, 'API недоступен', 60_001);
  store.finish(store.claim(600_000), { current: { temperature: 20 } }, null, 600_001);
  const result = store.results(job.id);
  assert.deepEqual(result.summary.temperature, { samples: 2, unit: '°C', min: 10, max: 20, average: 15 });
  assert.equal(result.summary.failures, 1);
  assert.equal(result.summary.successes, 2);
  assert.equal(result.runs[1].error, 'API недоступен');
  assert.equal(result.job.nextRunAt, new Date(660_000).toISOString());
});

test('30-second interval runs at the due time and rejects shorter periods', t => {
  const { store } = database(t);
  const job = store.create({ kind: 'weather', location: 'Москва', intervalSeconds: 30 }, 0);
  store.finish(store.claim(0), { current: { temperature: 10 } }, null, 1);
  assert.equal(store.get(job.id).nextRunAt, new Date(30_000).toISOString());
  assert.equal(store.claim(29_999), null);
  assert.equal(store.claim(30_000).id, job.id);
  assert.throws(() => store.create({ kind: 'weather', location: 'Москва', intervalSeconds: 29 }), /от 30/);
});

test('pause/cancel discard in-flight results; resume restores execution', t => {
  const { store } = database(t);
  const job = store.create({ kind: 'reminder', message: 'Проверка', intervalSeconds: 60 }, 0);
  const first = store.claim(0);
  store.setStatus(job.id, 'paused', 1);
  store.finish(first, { message: 'Не показывать' }, null, 2);
  assert.equal(store.results(job.id).runs.length, 0);
  assert.equal(store.claim(60_000), null);
  store.setStatus(job.id, 'active', 61_000);
  const next = store.claim(61_000);
  assert.ok(next);
  store.setStatus(job.id, 'cancelled', 61_001);
  store.finish(next, { message: 'Не показывать' }, null, 61_002);
  assert.equal(store.results(job.id).runs.length, 0);
  assert.throws(() => store.setStatus(job.id, 'active'), /завершено/);
});

test('clear deletes schedules and history permanently and discards an in-flight result', t => {
  const { store, open } = database(t);
  const workerStore = open();
  store.create({ kind: 'weather', location: 'Москва', intervalSeconds: 60 }, 0);
  workerStore.finish(workerStore.claim(0), { current: { temperature: 10 } }, null, 1);
  const pending = workerStore.claim(60_000);
  assert.ok(pending);
  store.clear();
  workerStore.finish(pending, { current: { temperature: 20 } }, null, 60_001);
  const restarted = open();
  assert.deepEqual(restarted.list(), []);
  assert.equal(restarted.db.prepare('SELECT COUNT(*) AS count FROM schedule_runs').get().count, 0);
  assert.equal(restarted.claim(120_000), null);
  store.create({ kind: 'reminder', message: 'New', delaySeconds: 0 }, 120_000);
  assert.ok(workerStore.claim(120_000));
});

test('delete removes only the selected schedule and history, including an in-flight result', t => {
  const { store, open } = database(t);
  const worker = open();
  const selected = store.create({ kind: 'weather', location: 'Москва', intervalSeconds: 30 }, 0);
  worker.finish(worker.claim(0), { current: { temperature: 10 } }, null, 1);
  const pending = worker.claim(30_000);
  const other = store.create({ kind: 'reminder', message: 'Keep me', delaySeconds: 0 }, 31_000);
  worker.finish(worker.claim(31_000), { message: 'Keep me' }, null, 31_001);
  assert.deepEqual(store.remove(selected.id), { ok: true, id: selected.id });
  worker.finish(pending, { current: { temperature: 20 } }, null, 32_000);
  store.remove(selected.id); // Retrying deletion is harmless.
  const restarted = open();
  assert.deepEqual(restarted.list().map(job => job.id), [other.id]);
  assert.equal(restarted.results(other.id).runs.length, 1);
  assert.equal(restarted.db.prepare('SELECT COUNT(*) AS count FROM schedule_runs WHERE job_id = ?').get(selected.id).count, 0);
  restarted.remove(other.id); // Completed schedules are deletable too.
  assert.deepEqual(restarted.list(), []);
});

test('worker ticks run in background without overlapping and retry after API failure', async t => {
  const { store } = database(t);
  const job = store.create({ kind: 'weather', location: 'Москва', intervalSeconds: 60 }, 0);
  let clock = 0;
  let calls = 0;
  const worker = startScheduler(store, { now: () => clock, weather: async () => {
    calls++;
    if (calls === 1) throw new Error('Сеть недоступна');
    return { current: { temperature: 5 } };
  } });
  try {
    await Promise.all([worker.tick(), worker.tick()]);
    assert.equal(calls, 1);
    assert.equal(store.results(job.id).summary.failures, 1);
    clock = 60_000;
    await worker.tick();
    assert.equal(store.results(job.id).summary.successes, 1);
  } finally { await worker.stop(); }
});

test('history is bounded but lifetime counters remain correct', t => {
  const { store } = database(t);
  const job = store.create({ kind: 'reminder', message: 'Ping', intervalSeconds: 60 }, 0);
  for (let i = 0; i < 1005; i++) store.finish(store.claim(i * 60_000), { message: 'Ping' }, null, i * 60_000 + 1);
  const result = store.results(job.id, 100);
  assert.equal(result.summary.retainedRuns, 1000);
  assert.equal(result.summary.totalRuns, 1005);
  assert.equal(result.runs.length, 100);
});

test('schedule parser handles the requested Russian weather example and reminders', async () => {
  const { scheduleArguments } = await import('../mcp/client.mjs');
  assert.deepEqual(scheduleArguments('мониторинг погоды в москве каждую минуту'), { kind: 'weather', location: 'Москва', intervalSeconds: 60 });
  assert.deepEqual(scheduleArguments('мониторинг погоды в Москве каждые 30 секунд'), { kind: 'weather', location: 'Москва', intervalSeconds: 30 });
  assert.deepEqual(scheduleArguments('weather in Moscow every 30 seconds'), { kind: 'weather', location: 'Moscow', intervalSeconds: 30 });
  assert.deepEqual(scheduleArguments('напомни проверить данные каждые 30 секунд'), { kind: 'reminder', message: 'проверить данные', intervalSeconds: 30, delaySeconds: 30 });
  assert.throws(() => scheduleArguments('погода в Москве каждые 29 секунд'), /30 секунд/);
  assert.deepEqual(scheduleArguments('Погода в Москве каждые 5 минут'), { kind: 'weather', location: 'Москва', intervalSeconds: 300 });
  assert.deepEqual(scheduleArguments('напомни через 10 минут сделать перерыв'), { kind: 'reminder', message: 'сделать перерыв', delaySeconds: 600 });
  assert.deepEqual(scheduleArguments('напомни пить воду каждый час'), { kind: 'reminder', message: 'пить воду', intervalSeconds: 3600, delaySeconds: 3600 });
  assert.equal(scheduleArguments('Какая погода в Москве?'), null);
  assert.throws(() => scheduleArguments('мониторинг погоды в Москве'), /Укажите расписание/);
  assert.throws(() => scheduleArguments('погода в Москве каждые 0 минут'), /Недопустимый/);
});

test('MCP tools persist a job across connections and return aggregated results', async t => {
  const { store, file } = database(t);
  const { callToolForAgent, listMcpTools } = await import('../mcp/client.mjs');
  const connection = { env: { SCHEDULE_DB_PATH: file }, stderr: 'pipe' };
  const { tools } = await listMcpTools(connection);
  for (const name of ['schedule_task', 'list_schedules', 'get_schedule_results', 'set_schedule_status', 'delete_schedule']) {
    assert.ok(tools.find(tool => tool.name === name), name);
  }
  const created = await callToolForAgent('schedule_task', { kind: 'reminder', message: 'MCP test', delaySeconds: 0, intervalSeconds: 30 }, { connection });
  assert.equal(created.trace.result.job.intervalSeconds, 30);
  const id = created.trace.result.job.id;
  const claim = store.claim();
  store.finish(claim, { message: 'MCP test' }, null);
  const result = await callToolForAgent('get_schedule_results', { id }, { connection });
  assert.equal(result.trace.result.summary.successes, 1);
  assert.equal(result.trace.result.runs[0].result.message, 'MCP test');
  const deleted = await callToolForAgent('delete_schedule', { id }, { connection });
  assert.equal(deleted.trace.result.ok, true);
  assert.deepEqual(store.list(), []);
  const invalid = () => callToolForAgent('schedule_task', { kind: 'weather', intervalSeconds: 1 }, { connection });
  await assert.rejects(invalid);
});

test('HTTP chat creates a reminder without LLM; server restart executes it and preserves history', { timeout: 20000 }, async t => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const { setTimeout: delay } = require('node:timers/promises');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-schedule-http-'));
  let child;
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  t.after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function start() {
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: '0', SCHEDULE_DB_PATH: path.join(dir, 'schedule.sqlite'),
        AGENT_DB_PATH: path.join(dir, 'agent.sqlite'), DEEPSEEK_API_KEY: 'unused-test-key' },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    return new Promise((resolve, reject) => {
      let output = '';
      child.on('error', reject);
      child.once('exit', code => reject(new Error(`Server exited ${code}`)));
      child.stdout.on('data', chunk => {
        output += chunk;
        const url = output.match(/Open (http:\/\/localhost:\d+)/);
        if (url) resolve(url[1]);
      });
    });
  }
  let url = await start();
  const response = await fetch(`${url}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: 'schedule-test', provider: 'deepseek', model: 'deepseek-flash',
      message: 'напомни через 3 секунды сделать перерыв' })
  });
  const answer = await response.text();
  assert.match(answer, /scheduleCreated/);
  assert.match(answer, /Расписание создано/);
  const jobs = (await (await fetch(`${url}/api/schedules`)).json()).jobs;
  assert.equal(jobs.length, 1);
  await stop();
  url = await start();
  let result;
  for (let i = 0; i < 60; i++) {
    result = await (await fetch(`${url}/api/schedules/${jobs[0].id}`)).json();
    if (result.runs.length) break;
    await delay(100);
  }
  assert.equal(result.job.status, 'completed');
  assert.equal(result.summary.successes, 1);
  assert.equal(result.runs[0].result.message, 'сделать перерыв');
  const chats = await (await fetch(`${url}/api/chats`)).json();
  assert.ok(chats.chats.some(chat => chat.id === 'schedule-test'));
  const scheduleStore = new ScheduleStore(path.join(dir, 'schedule.sqlite'));
  const other = scheduleStore.create({ kind: 'reminder', message: 'Other reminder', delaySeconds: 3600 });
  scheduleStore.close();
  const deleted = await fetch(`${url}/api/schedules/${jobs[0].id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual((await (await fetch(`${url}/api/schedules`)).json()).jobs.map(job => job.id), [other.id]);
  const cleared = await fetch(`${url}/api/chats/clear`, { method: 'POST' });
  assert.equal(cleared.status, 200);
  assert.deepEqual((await (await fetch(`${url}/api/schedules`)).json()).jobs, []);
  assert.deepEqual((await (await fetch(`${url}/api/chats`)).json()).chats, []);
  await stop();
  url = await start();
  assert.deepEqual((await (await fetch(`${url}/api/schedules`)).json()).jobs, []);
});
