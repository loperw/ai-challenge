const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Agent } = require('../agent');

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-mcp-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const preload = path.join(dir, 'fetch.mjs');
  await fs.writeFile(preload, `globalThis.fetch = async input => {
    const url = new URL(input);
    let data;
    if (url.hostname === 'geocoding-api.open-meteo.com') data = { results: [{ name: url.searchParams.get('name'), latitude: 55, longitude: 37, country: 'Россия' }] };
    else if (url.hostname === 'router.project-osrm.org') data = { code: 'Ok', routes: [{ distance: 185000, duration: 9600, legs: [{ summary: 'М-2' }] }] };
    else if (url.hostname === 'api.open-meteo.com') data = { timezone: 'Europe/Moscow', current_units: { temperature_2m: '°C', wind_speed_10m: 'km/h' },
      current: { time: '2026-09-28T12:00', temperature_2m: 12, apparent_temperature: 11, relative_humidity_2m: 70, wind_speed_10m: 5, weather_code: 3 },
      daily: { time: ['2026-09-28'], temperature_2m_min: [5], temperature_2m_max: [15], precipitation_probability_max: [20], weather_code: [3] } };
    else throw new Error('Unexpected network request: ' + url);
    return { ok: true, json: async () => data };
  };`);
  const { openMultiMcpSession } = await import('../mcp/registry.mjs');
  const { openMcpSession } = await import('../mcp/client.mjs');
  const openSession = () => openMultiMcpSession({ stderr: 'pipe', env: { PIPELINE_OUTPUT_DIR: dir, SCHEDULE_DB_PATH: path.join(dir, 'schedules.sqlite') },
    connect: options => openMcpSession({ ...options, args: ['--import', pathToFileURL(preload).href, ...options.args] }) });
  return { dir, openSession };
}

test('Agent routes an eight-call flow through four real stdio servers and preserves dependencies', async t => {
  const { dir, openSession } = await setup(t);
  const previous = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'test';
  t.after(() => { if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; });
  let round = 0, trace, closed = false;
  const data = [];
  const names = ['maps__geocode', 'maps__geocode', 'maps__route', 'weather__get_weather', 'documents__combine_sources', 'documents__summarize', 'documents__saveToFile', 'schedules__list_schedules'];
  const agent = new Agent({ provider: 'deepseek', model: 'deepseek-flash' }, {
    openToolSession: async () => { const session = await openSession(); return { ...session, close: async () => { await session.close(); closed = true; } }; },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.tool_choice, 'auto');
      assert.ok(names.every(name => body.tools.some(tool => tool.function.name === name)));
      assert.ok(!body.tools.some(tool => tool.function.name.includes('_import_source')));
      if (round) {
        assert.equal(body.messages.at(-1).tool_call_id, `id-${round - 1}`);
        const result = JSON.parse(body.messages.at(-1).content);
        assert.ok(!result.isError, JSON.stringify(result)); data.push(result.structuredContent);
      }
      const args = [
        () => ({ query: 'Москва' }), () => ({ query: 'Тула' }),
        () => ({ originId: data[0].results[0].placeId, destinationId: data[1].results[0].placeId }),
        () => ({ location: 'Тула', days: 1 }),
        () => ({ sourceIds: [data[2].sourceId, data[3].sourceId] }),
        () => ({ sourceId: data[4].sourceId }),
        () => ({ sourceId: data[5].sourceId, filename: 'trip.md' }), () => ({})
      ];
      const payload = round < names.length
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: `id-${round}`, type: 'function', function: { name: names[round], arguments: JSON.stringify(args[round]()) } }] }, finish_reason: 'tool_calls' }] }
        : { choices: [{ delta: { content: 'Готово.' }, finish_reason: 'stop' }] };
      round++;
      return { ok: true, body: { async *[Symbol.asyncIterator]() { yield Buffer.from('data: ' + JSON.stringify(payload) + '\n\ndata: [DONE]\n\n'); } } };
    }
  });
  await agent.respond('Маршрут, погода, итог, файл и список расписаний', { onTrace: value => { trace = value; } });
  assert.deepEqual(trace.calls.map(call => call.name), names);
  assert.deepEqual(trace.calls.map(call => call.serverId), ['maps', 'maps', 'maps', 'weather', 'documents', 'documents', 'documents', 'schedules']);
  assert.equal(trace.servers.filter(s => s.status === 'connected').length, 4);
  assert.deepEqual(trace.transfers.map(item => item.from), ['maps', 'weather']);
  assert.equal(data[4].text, data[2].text + '\n\n' + data[3].text);
  assert.equal(await fs.readFile(path.join(dir, 'trip.md'), 'utf8'), data[5].text);
  assert.match(data[5].text, /185 км/);
  assert.match(data[5].text, /160 мин/);
  assert.match(data[5].text, /суточные минимумы/);
  assert.equal(agent.messages.at(-1).files[0].name, 'trip.md');
  assert.equal(closed, true);
});

test('broker rejects unknown tools and future/foreign IDs; maps validate dependencies and mode', async t => {
  const { openSession } = await setup(t);
  const session = await openSession(); t.after(() => session.close());
  await assert.rejects(session.callTool('route', {}), /Unknown MCP tool/);
  await assert.rejects(session.callTool('documents___import_source', {}), /Unknown MCP tool/);
  await assert.rejects(session.callTool('documents__saveToFile', { sourceId: 'future', filename: 'bad.md' }), /sourceId/);
  assert.equal((await session.callTool('maps__route', { originId: 'made-up', destinationId: 'made-up' })).isError, true);
  assert.equal((await session.callTool('maps__route', { originId: 'x', destinationId: 'y', mode: 'walking' })).isError, true);
  const found = await session.callTool('maps__geocode', { query: 'Тула' });
  const other = await openSession();
  try { await assert.rejects(other.callTool('documents__summarize', { sourceId: found.structuredContent.sourceId }), /sourceId/); }
  finally { await other.close(); }
  const weather = await session.callTool('weather__get_weather', { location: 'Тула' });
  const summary = await session.callTool('documents__summarize', { sourceId: weather.structuredContent.sourceId });
  assert.equal(summary.structuredContent.method, 'weather-aggregate');
});

test('registry distinguishes duplicate tool names, isolates unavailable servers and closes survivors', async () => {
  const { openMultiMcpSession } = await import('../mcp/registry.mjs');
  let closed = 0;
  const session = await openMultiMcpSession({ registry: [
    { id: 'one', role: 'weather' }, { id: 'two', role: 'maps' }, { id: 'offline', role: 'documents' }
  ], connect: async options => {
    const role = options.args.at(-1);
    if (role === 'documents') throw new Error('offline');
    return { tools: [{ name: 'same', inputSchema: { type: 'object' } }], server: { name: role },
      callTool: async () => ({ structuredContent: { role } }), close: async () => { closed++; } };
  } });
  try {
    assert.deepEqual(session.tools.map(tool => tool.name), ['one__same', 'two__same']);
    assert.equal((await session.callTool('two__same', {})).structuredContent.role, 'maps');
    assert.equal(session.servers[2].status, 'unavailable');
  } finally { await session.close(); }
  assert.equal(closed, 2);
  await assert.rejects(openMultiMcpSession({ registry: [{ id: 'x', role: 'maps' }, { id: 'x', role: 'weather' }] }), /duplicate/);
});
