const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Agent } = require('../agent');

function stream(payloads) {
  // Deliberately split SSE in the middle of JSON and multi-byte UTF-8 text.
  const bytes = Buffer.from(payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join('') + 'data: [DONE]\n\n');
  return { ok: true, body: { async *[Symbol.asyncIterator]() {
    for (let i = 0; i < bytes.length; i += 7) yield bytes.subarray(i, i + 7);
  } } };
}
function reply(text) { return stream([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }]); }
function call(name, args, id = 'call-1') {
  const raw = typeof args === 'string' ? args : JSON.stringify(args);
  return stream([
    { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: raw.slice(0, 4) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: raw.slice(4) } }] }, finish_reason: 'tool_calls' }] },
    { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, choices: [] }
  ]);
}
async function setup(t, decide, provider = 'deepseek') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-pipeline-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const key = provider === 'gemini' ? 'GEMINI_API_KEY' : provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'DEEPSEEK_API_KEY';
  const previous = process.env[key]; process.env[key] = 'test-key';
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const { openMcpSession } = await import('../mcp/client.mjs');
  const requests = [], traces = [];
  let closed = false;
  const agent = new Agent({ provider, model: provider === 'gemini' ? 'gemini-3.5-flash' : provider === 'openrouter' ? 'openrouter/free' : 'deepseek-flash' }, {
    openToolSession: async () => {
      const session = await openMcpSession({ stderr: 'pipe', env: { PIPELINE_OUTPUT_DIR: dir, SCHEDULE_DB_PATH: path.join(dir, 'schedules.sqlite') } });
      return { ...session, close: async () => { closed = true; await session.close(); } };
    },
    fetchImpl: async (_url, init) => { const body = JSON.parse(init.body); requests.push(body); return decide(body, requests.length); }
  });
  return { dir, requests, traces, agent, closed: () => closed,
    run: prompt => agent.respond(prompt, { onTrace: trace => traces.push(trace) }) };
}
const lastResult = body => JSON.parse(body.messages.at(-1).content).structuredContent;

test('LLM tool calls drive a real stdio search → summarize → save pipeline with exact artifact transfer', async t => {
  let found, summary;
  const env = await setup(t, (body, round) => {
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.parallel_tool_calls, false);
    assert.ok(['search', 'summarize', 'saveToFile'].every(name => body.tools.some(tool => tool.function.name === name)));
    if (round === 1) return call('search', { query: 'MCP' }, 'search-id');
    assert.equal(body.messages.at(-1).role, 'tool');
    if (round === 2) {
      found = lastResult(body);
      assert.equal(body.messages.at(-1).tool_call_id, 'search-id');
      return call('summarize', { sourceId: found.sourceId, maxSentences: 2 }, 'summary-id');
    }
    if (round === 3) {
      summary = lastResult(body);
      assert.equal(summary.inputSourceId, found.sourceId);
      assert.equal(summary.inputCharacters, found.text.length);
      return call('saveToFile', { sourceId: summary.sourceId, filename: 'result.md' }, 'save-id');
    }
    assert.equal(lastResult(body).sourceId, summary.sourceId);
    return reply('Готово.');
  });
  assert.equal(await env.run('Найди сведения о MCP, сократи и сохрани'), 'Готово.');
  assert.equal(await fs.readFile(path.join(env.dir, 'result.md'), 'utf8'), summary.text);
  assert.deepEqual(env.traces.at(-1).calls.map(item => item.name), ['search', 'summarize', 'saveToFile']);
  assert.equal(env.requests.length, 4);
  assert.equal(env.agent.messages.at(-1).files[0].name, 'result.md');
  assert.equal(env.agent.messages.at(-1).files[0].downloadUrl, '/api/files/result.md?download=1');
  assert.equal(Object.hasOwn(lastResult(env.requests.at(-1)), 'path'), false);
  assert.equal(env.agent.tokenStats.totalTokens, 45);
  assert.equal(env.closed(), true);
});

for (const [name, args, prompt] of [
  ['search', { query: 'MCP' }, 'Найди сведения о MCP'],
  ['summarize', { text: 'Сервер хранит данные. Клиент вызывает инструменты.', maxSentences: 1 }, 'Сократи данный текст'],
  ['saveToFile', { text: 'Точный текст: Привет 👋', filename: 'direct.txt' }, 'Сохрани готовый текст']
]) test(`single ${name} request does not trigger other tools`, async t => {
  const env = await setup(t, (_body, round) => round === 1 ? call(name, args) : reply('Готово.'));
  await env.run(prompt);
  assert.deepEqual(env.traces.at(-1).calls.map(item => item.name), [name]);
  if (name === 'saveToFile') assert.equal(await fs.readFile(path.join(env.dir, 'direct.txt'), 'utf8'), args.text);
});

test('model can answer with zero tools, including OpenRouter', async t => {
  const env = await setup(t, body => { assert.ok(body.tools.length); return reply('Привет!'); }, 'openrouter');
  assert.equal(await env.run('Привет'), 'Привет!');
  assert.deepEqual(env.traces.at(-1).calls, []);
  assert.equal(env.requests.length, 1);
});

test('search results can be saved directly without summarization', async t => {
  let found;
  const env = await setup(t, (body, round) => {
    if (round === 1) return call('search', { query: 'MCP' });
    if (round === 2) { found = lastResult(body); return call('saveToFile', { sourceId: found.sourceId, filename: 'raw.txt' }); }
    return reply('Сохранено');
  });
  await env.run('Найди и сохрани сведения о MCP без сокращения');
  assert.equal(await fs.readFile(path.join(env.dir, 'raw.txt'), 'utf8'), found.text);
  assert.deepEqual(env.traces.at(-1).calls.map(item => item.name), ['search', 'saveToFile']);
});

test('errors reach the model and allow correction; future artifact IDs cannot be used', async t => {
  const env = await setup(t, (body, round) => {
    if (round === 1) return call('saveToFile', { sourceId: 'invented', filename: 'bad.txt' });
    const result = JSON.parse(body.messages.at(-1).content);
    if (round === 2) { assert.equal(result.isError, true); return call('unknown', {}); }
    if (round === 3) { assert.equal(result.isError, true); return call('summarize', '{invalid'); }
    if (round === 4) { assert.equal(result.isError, true); return call('saveToFile', { text: 'Исправлено', filename: 'good.txt' }); }
    return reply('Сохранено');
  });
  await env.run('Сохрани текст');
  await assert.rejects(fs.stat(path.join(env.dir, 'bad.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(env.dir, 'good.txt'), 'utf8'), 'Исправлено');
});

test('MCP rejects invalid arguments, path traversal, overwrite, and empty search dependencies', async t => {
  const env = await setup(t, () => reply('ok'));
  const session = await env.agent.openToolSession();
  try {
    const empty = await session.callTool('search', { query: 'zzzzzzzzzz' });
    assert.deepEqual(empty.structuredContent.results, []);
    for (const [name, args] of [
      ['search', { query: 'MCP', limit: 100 }],
      ['summarize', { sourceId: empty.structuredContent.sourceId }],
      ['summarize', { text: 'abc', sourceId: 'abc' }],
      ['saveToFile', { text: 'abc', filename: '../escape.txt' }],
      ['saveToFile', { text: 'abc', filename: 'CON.txt' }]
    ]) assert.equal((await session.callTool(name, args)).isError, true);
    assert.equal((await session.callTool('saveToFile', { text: 'original', filename: 'same.txt' })).structuredContent.saved, true);
    assert.equal((await session.callTool('saveToFile', { text: 'overwrite', filename: 'same.txt' })).isError, true);
    assert.equal(await fs.readFile(path.join(env.dir, 'same.txt'), 'utf8'), 'original');
  } finally { await session.close(); }
});

test('loop limit and provider failure close the session without silent fallback', async t => {
  const env = await setup(t, () => call('search', { query: 'MCP' }));
  await assert.rejects(env.run('Повторяй поиск'), /лимит 12/);
  assert.equal(env.traces.at(-1).calls.length, 12);
  assert.equal(env.closed(), true);
  assert.equal(env.agent.busy, false);
  const failed = await setup(t, () => { throw new Error('provider unavailable'); });
  await assert.rejects(failed.run('Привет'), /provider unavailable/);
  assert.equal(failed.closed(), true);
});

test('Gemini receives native declarations and exact thought signatures with function responses', async t => {
  const signature = 'original-thought-signature';
  const env = await setup(t, (body, round) => {
    assert.equal(body.toolConfig.functionCallingConfig.mode, 'AUTO');
    assert.ok(body.tools[0].functionDeclarations.find(tool => tool.name === 'summarize').parametersJsonSchema);
    if (round === 1) return stream([{ candidates: [{ content: { parts: [
      { thoughtSignature: signature, functionCall: { id: 'gemini-call', name: 'summarize', args: { text: 'Первое предложение. Второе предложение.', maxSentences: 1 } } }
    ] }, finishReason: 'STOP' }] }]);
    assert.equal(body.contents.at(-2).parts[0].thoughtSignature, signature);
    assert.equal(body.contents.at(-1).parts[0].functionResponse.id, 'gemini-call');
    assert.ok(body.contents.at(-1).parts[0].functionResponse.response.structuredContent.text);
    return stream([{ candidates: [{ content: { parts: [{ text: 'Готово' }] }, finishReason: 'STOP' }] }]);
  }, 'gemini');
  assert.equal(await env.run('Сократи'), 'Готово');
});

test('tool actions are checked against invariants before writing', async t => {
  const env = await setup(t, (body, round) => {
    if (round === 1) return call('saveToFile', { text: 'abc', filename: 'blocked.txt' });
    assert.equal(JSON.parse(body.messages.at(-1).content).isError, true);
    return reply('Запись запрещена инвариантом.');
  });
  env.agent.getInvariants = () => ['Не записывать файлы'];
  env.agent.evaluateInvariantRequest = async ({ userRequest }) => ({
    conflict: userRequest.includes('"operation":"tool_call"'),
    violations: userRequest.includes('"operation":"tool_call"') ? [{ index: 0, reason: 'Запись запрещена' }] : []
  });
  await env.run('Обработай текст');
  await assert.rejects(fs.stat(path.join(env.dir, 'blocked.txt')), { code: 'ENOENT' });
});

test('incomplete streams never execute tool calls and tool schemas count against the context budget', async t => {
  const env = await setup(t, () => stream([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'unfinished',
    function: { name: 'saveToFile', arguments: JSON.stringify({ text: 'abc', filename: 'partial.txt' }) }
  }] } }] }]));
  await assert.rejects(env.run('Сохрани текст'), /не завершила вызов/);
  await assert.rejects(fs.stat(path.join(env.dir, 'partial.txt')), { code: 'ENOENT' });
  env.agent.configure({ ...env.agent.settings, maxTokens: 500 });
  const before = env.requests.length;
  await assert.rejects(env.run('Привет'), /Лимит токенов/);
  assert.equal(env.requests.length, before);
});

test('multiple independent model calls preserve every ID and result', async t => {
  const env = await setup(t, (body, round) => {
    if (round === 1) return stream([{ choices: [{ delta: { tool_calls: ['a', 'b'].map((id, index) => ({
      index, id, type: 'function', function: { name: 'summarize', arguments: JSON.stringify({ text: `Текст ${id}.`, maxSentences: 1 }) }
    })) }, finish_reason: 'tool_calls' }] }]);
    const results = body.messages.filter(message => message.role === 'tool');
    assert.deepEqual(results.map(message => message.tool_call_id), ['a', 'b']);
    assert.deepEqual(results.map(message => JSON.parse(message.content).structuredContent.text), ['Текст a.', 'Текст b.']);
    return reply('Две выжимки');
  });
  assert.equal(await env.run('Сократи два текста'), 'Две выжимки');
});

test('weather data flows over stdio into summarize and save, aggregating the entire forecast', async t => {
  let weather, summary;
  const env = await setup(t, (body, round) => {
    if (round === 1) return call('get_weather', { location: 'Minsk', days: 3 });
    if (round === 2) {
      weather = lastResult(body);
      assert.ok(weather.sourceId);
      assert.match(weather.text, /2030-01-03/);
      return call('summarize', { sourceId: weather.sourceId });
    }
    if (round === 3) {
      summary = lastResult(body);
      assert.equal(summary.inputSourceId, weather.sourceId);
      assert.equal(summary.method, 'weather-aggregate');
      assert.deepEqual(summary.aggregate.dailyLow, { min: -3, max: 10 });
      assert.deepEqual(summary.aggregate.dailyHigh, { min: 4, max: 20 });
      assert.deepEqual(summary.aggregate.precipitationProbability, { min: 0, max: 85 });
      assert.deepEqual(summary.aggregate.conditions, { 'пасмурно': 2, 'ясно': 1 });
      return call('saveToFile', { sourceId: summary.sourceId, filename: 'weather.md' });
    }
    return reply('Готово.');
  });
  const preload = path.join(env.dir, 'weather-fixture.mjs');
  await fs.writeFile(preload, `
    globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes('geocoding')
      ? { results: [{ name: 'Минск', latitude: 53.9, longitude: 27.56 }] }
      : { timezone: 'Europe/Minsk', current_units: { temperature_2m: '°C', wind_speed_10m: 'км/ч' },
          current: { time: '2030-01-01T12:00', temperature_2m: 12, apparent_temperature: 11,
            relative_humidity_2m: 70, wind_speed_10m: 5, weather_code: 3 },
          daily: { time: ['2030-01-01', '2030-01-02', '2030-01-03'], temperature_2m_min: [10, -3, 6],
            temperature_2m_max: [15, 4, 20], precipitation_probability_max: [0, 85, 7], weather_code: [3, 3, 0] }
        }));
  `);
  const { openMcpSession } = await import('../mcp/client.mjs');
  const { pathToFileURL } = require('node:url');
  env.agent.openToolSession = () => openMcpSession({ stderr: 'pipe',
    args: ['--import', pathToFileURL(preload).href, path.resolve(__dirname, '../mcp/server.mjs')],
    env: { PIPELINE_OUTPUT_DIR: env.dir } });
  await env.run('Составь прогноз, кратко подведи итог и сохрани в файле');
  assert.deepEqual(env.traces.at(-1).calls.map(item => item.name), ['get_weather', 'summarize', 'saveToFile']);
  assert.equal(await fs.readFile(path.join(env.dir, 'weather.md'), 'utf8'), summary.text);
});
