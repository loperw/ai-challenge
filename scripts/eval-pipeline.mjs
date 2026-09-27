// Opt-in live LLM evaluation: uses API tokens; never loaded by node --test.
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '../agent.js';
import { openMcpSession } from '../mcp/client.mjs';

try {
  for (const line of (await readFile('.env', 'utf8')).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }

const provider = process.env.EVAL_PROVIDER || 'deepseek';
const model = process.env.EVAL_MODEL || (provider === 'gemini' ? 'gemini-3.5-flash' : provider === 'openrouter' ? 'openrouter/free' : 'deepseek-flash');
await mkdir('data/evals', { recursive: true });
const dir = await mkdtemp(path.resolve('data/evals/pipeline-'));
const cases = [
  { prompt: 'Найди в базе знаний сведения о MCP, сделай краткую выжимку и сохрани результат в summary.md.', expected: ['search', 'summarize', 'saveToFile'] },
  { prompt: 'Найди в базе знаний сведения о MCP и покажи результаты. Не сокращай и не сохраняй.', expected: ['search'] },
  { prompt: 'Сократи до одного предложения следующий текст: MCP связывает приложение с инструментами. Сервер публикует каталог. Клиент вызывает инструменты.', expected: ['summarize'] },
  { prompt: 'Сохрани точный текст «Привет, мир!» в hello.txt.', expected: ['saveToFile'], exact: 'Привет, мир!' },
  { prompt: 'Найди сведения о MCP в базе знаний и сохрани найденный текст в raw.md без сокращения.', expected: ['search', 'saveToFile'] },
  { prompt: 'Сколько будет 2 + 2? Ответь одним числом.', expected: [] },
  { prompt: 'составь прогноз на неделю в минске, кратко подведи итог и сохрани в файле', expected: ['get_weather', 'summarize', 'saveToFile'] },
  { prompt: 'Какая погода в Минске на 7 дней? Покажи прогноз по дням.', expected: ['get_weather'] },
  { prompt: 'Получи прогноз погоды в Минске на 7 дней и сохрани исходные данные в weather-raw.md без сокращения.', expected: ['get_weather', 'saveToFile'] }
];
const reports = [];
for (const item of cases) {
  let trace;
  const agent = new Agent({ provider, model, temperature: 0, keepMessages: 8 }, {
    fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(45000) }),
    openToolSession: () => openMcpSession({ stderr: 'pipe', env: { PIPELINE_OUTPUT_DIR: dir, SCHEDULE_DB_PATH: path.join(dir, 'schedules.sqlite') } })
  });
  const report = { prompt: item.prompt, expected: item.expected };
  try {
    report.answer = await agent.respond(item.prompt, { onTrace: value => { trace = value; } });
    report.actual = trace.calls.map(call => call.name);
    assert.deepEqual(report.actual, item.expected);
    for (const [index, call] of trace.calls.entries()) {
      assert.ok(!call.result.isError, JSON.stringify(call.result));
      if (index && call.arguments.sourceId) assert.equal(call.arguments.sourceId, trace.calls[index - 1].result.structuredContent.sourceId);
      if (call.name === 'saveToFile') {
        const saved = await readFile(path.join(dir, call.result.structuredContent.filename), 'utf8');
        const previous = trace.calls[index - 1]?.result.structuredContent;
        assert.equal(saved, item.exact ?? previous?.text ?? call.arguments.text);
      }
    }
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
  report.trace = trace;
  reports.push(report);
  console.log(JSON.stringify({ passed: report.passed, expected: report.expected, actual: report.actual, error: report.error }));
}
const reportPath = path.join(dir, 'report.json');
await writeFile(reportPath, JSON.stringify({ provider, model, createdAt: new Date().toISOString(), reports }, null, 2));
console.log(`Report: ${reportPath}`);
