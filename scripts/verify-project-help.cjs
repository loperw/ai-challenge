// End-to-end evaluation. Uses a REAL configured provider and consumes API tokens.
// No mocked responses. Separate application server and temporary databases.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');

if (process.env.PROJECT_HELP_EVAL_CHILD === '1') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options?.body || '{}');
    const system = body.messages?.map(m => m.content).join('\n') || '';
    const response = await originalFetch(url, options);
    process.send?.({ upstream: { host: new URL(url).hostname, model: body.model, status: response.status,
      projectContext: system.includes('Источники RAG (embeddings)'),
      sources: system.includes('Источники RAG (embeddings): ') ? JSON.parse(system.split('Источники RAG (embeddings): ')[1].split('\n')[0]) : [] } });
    return response;
  };
  require('../server');
} else {
  (async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'project-help-eval-'));
    const provider = process.env.EVAL_PROVIDER || 'deepseek';
    const model = process.env.EVAL_MODEL || 'deepseek-flash';
    const output = path.join(__dirname, `../data/project-help-e2e-${provider}.json`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
    const upstream = [];
    const child = fork(__filename, [], { silent: true, env: { ...process.env,
      PROJECT_HELP_EVAL_CHILD: '1', PORT: '0', HOST: '127.0.0.1', PRIVATE_LLM: '0',
      AGENT_DB_PATH: path.join(directory, 'chat.sqlite'), SCHEDULE_DB_PATH: path.join(directory, 'schedules.sqlite') } });
    child.on('message', event => { if (event.upstream) upstream.push(event.upstream); });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const report = { date: new Date().toISOString(), provider, model, branch, cases: [] };
    try {
      const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Server startup timeout')), 15000);
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exit ${code}: ${stderr}`)); });
        child.stdout.on('data', chunk => {
          const match = chunk.toString().match(/localhost:(\d+)/);
          if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
      });
      const cases = [
        { id: 'overview', question: '/help', expected: [/server\.js/, /agent\.js/, /\/help/] },
        { id: 'structure', question: '/help Какие основные файлы проекта и за что они отвечают?', expected: [/server\.js/, /agent\.js/, /public\//] },
        { id: 'storage', question: '/help Где хранится история?', expected: [/sqlite-store\.js/, /agent-memory\.sqlite/] },
        { id: 'paraphrase', question: '/help В каком месте сохраняются прошлые беседы?', expected: [/agent-memory\.sqlite/] },
        { id: 'branch', question: '/help Какая текущая git-ветка?', expected: [new RegExp(branch)] },
        { id: 'api', question: '/help Какой формат запроса и ответа у API чата?', expected: [/\/api\/chat/, /conversationId/, /text\/event-stream|SSE/i] },
        { id: 'unknown', question: '/help Какой точный SLA гарантирован проекту по договору с заказчиком?', expected: [/не знаю|нет (?:сведений|информации|ответа)|не (?:указан|описан|содерж)/i] },
        { id: 'book-enabled', question: '/help Где хранится история?', expected: [/agent-memory\.sqlite/], extra: { documentStrategy: 'structure' } },
        { id: 'plain-after-help', question: 'Ответь одним словом: сколько будет два плюс два?', expected: [/^(?:четыре|4)[.!]?$/i], conversationId: 'help-eval-book-enabled', plain: true }
      ];
      for (const item of cases) {
        if (process.env.EVAL_CASES && !process.env.EVAL_CASES.split(',').includes(item.id)) continue;
        console.log(`RUN ${item.id}`);
        const start = Date.now(), offset = upstream.length;
        const result = { id: item.id, question: item.question };
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(300000),
            body: JSON.stringify({ conversationId: item.conversationId || `help-eval-${item.id}`, provider, model,
              temperature: 0, keepMessages: 10, message: item.question, ...item.extra }) });
          const raw = await response.text();
          assert.equal(response.status, 200, raw);
          const events = raw.split('\n').filter(line => line.startsWith('data: ') && line.trim() !== 'data: [DONE]')
            .map(line => JSON.parse(line.slice(6)));
          result.errors = events.filter(e => e.error);
          result.answer = events.map(e => e.choices?.[0]?.delta?.content || '').join('');
          result.trace = events.filter(e => e.mcpTrace?.tool?.name === 'git_context').at(-1)?.mcpTrace;
          result.upstream = upstream.slice(offset);
          result.saved = events.find(e => e.messages)?.messages.at(-1);
          assert.deepEqual(result.errors, []);
          assert.ok(raw.includes('data: [DONE]'));
          assert.equal(result.saved?.content, result.answer);
          const actualGeneration = result.upstream.filter(e => e.projectContext);
          if (!item.plain) {
            assert.equal(result.saved.ragMode, 'project-rag');
            assert.ok(result.upstream.some(event => event.model === 'nomic-embed-text' && event.status === 200), 'No real embedding request');
            assert.ok(actualGeneration.length > 0, 'No real generation with project sources');
            assert.ok(actualGeneration.every(e => e.status === 200));
            assert.equal(result.trace?.result?.branch, branch);
            assert.equal(result.trace?.status, 'done');
            if (!['unknown', 'branch'].includes(item.id)) assert.match(result.answer, /docs\/|README\.md/, 'No documentation citation');
          } else assert.equal(actualGeneration.length, 0, 'Project context leaked into ordinary turn');
          for (const pattern of item.expected) assert.match(result.answer.trim(), pattern);
          result.passed = true;
        } catch (error) { result.passed = false; result.error = error.message; }
        result.seconds = (Date.now() - start) / 1000;
        report.cases.push(result);
        fs.writeFileSync(output, JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ id: result.id, passed: result.passed, seconds: result.seconds, answer: result.answer, error: result.error }));
      }
      report.passed = report.cases.every(c => c.passed);
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(`Report: ${output}`);
      if (!report.passed) process.exitCode = 1;
    } finally { child.kill(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
