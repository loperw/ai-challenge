// Opt-in: real LLM and public map/weather services. Consumes configured provider tokens.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '../agent.js';
import { openMultiMcpSession } from '../mcp/registry.mjs';

try {
  for (const line of (await readFile('.env', 'utf8')).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const provider = process.env.EVAL_PROVIDER || 'deepseek';
const model = process.env.EVAL_MODEL || (provider === 'gemini' ? 'gemini-3.5-flash' : provider === 'openrouter' ? 'openrouter/free' : 'deepseek-flash');
await mkdir('data/evals', { recursive: true });
const dir = await mkdtemp(path.resolve('data/evals/multi-mcp-'));
const cases = [
  { prompt: 'Построй автомобильный маршрут из Москвы (Россия) в Тулу (Россия).', names: ['maps__geocode', 'maps__geocode', 'maps__route'] },
  { prompt: 'Построй автомобильный маршрут из Москвы (Россия) в Тулу (Россия), получи погоду в Туле на 3 дня, объедини маршрут и прогноз, кратко подведи итог и сохрани итог в trip.md. Также покажи мои текущие расписания.',
    names: ['maps__geocode', 'maps__geocode', 'maps__route', 'weather__get_weather', 'documents__combine_sources', 'documents__summarize', 'documents__saveToFile', 'schedules__list_schedules'] },
  { prompt: 'Сколько будет 2 + 2? Ответь одним числом.', names: [] }
];
const reports = [];
for (const item of cases) {
  let trace;
  const report = { prompt: item.prompt, expected: item.names };
  const agent = new Agent({ provider, model, temperature: 0, keepMessages: 8 }, {
    fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(60000) }),
    openToolSession: () => openMultiMcpSession({ stderr: 'pipe', env: { PIPELINE_OUTPUT_DIR: dir, SCHEDULE_DB_PATH: path.join(dir, 'schedules.sqlite') } })
  });
  try {
    report.answer = await agent.respond(item.prompt, { onTrace: value => { trace = value; } });
    report.actual = trace.calls.map(call => call.name);
    assert.deepEqual([...report.actual].sort(), [...item.names].sort());
    const sources = new Map(), places = new Set();
    for (const call of trace.calls) {
      assert.ok(!call.result.isError, JSON.stringify(call.result));
      assert.equal(call.name, `${call.serverId}__${call.toolName}`);
      const data = call.result.structuredContent;
      if (call.toolName === 'route') {
        assert.ok(places.has(call.arguments.originId) && places.has(call.arguments.destinationId));
        assert.ok(data.distanceKm > 0 && data.durationMinutes > 0);
      }
      for (const id of call.arguments.sourceIds || (call.arguments.sourceId ? [call.arguments.sourceId] : [])) assert.ok(sources.has(id), 'dependency must succeed first');
      if (call.toolName === 'combine_sources') {
        assert.deepEqual(call.arguments.sourceIds.map(id => sources.get(id).toolName).sort(), ['get_weather', 'route']);
      }
      if (call.toolName === 'summarize') {
        assert.equal(sources.get(call.arguments.sourceId).toolName, 'combine_sources');
        assert.match(data.text, /км/);
        assert.match(data.text, /мин/);
        assert.match(data.text, /суточные минимумы/);
      }
      if (call.toolName === 'saveToFile') {
        const source = sources.get(call.arguments.sourceId);
        assert.equal(source.toolName, 'summarize');
        assert.equal(await readFile(path.join(dir, data.filename), 'utf8'), source.text);
      }
      if (data?.sourceId && data.text) sources.set(data.sourceId, { ...data, toolName: call.toolName });
      if (call.toolName === 'geocode') for (const place of data.results) places.add(place.placeId);
    }
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
  report.trace = trace; reports.push(report);
  await writeFile(path.join(dir, 'report.json'), JSON.stringify({ provider, model, reports }, null, 2));
  console.log(JSON.stringify({ passed: report.passed, actual: report.actual, error: report.error }));
}
console.log(`Report: ${path.join(dir, 'report.json')}`);
