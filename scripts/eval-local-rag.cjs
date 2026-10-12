// Same retrieved context for both providers; fresh conversations for every repeat.
const fs = require('node:fs');
const path = require('node:path');
const { Agent } = require('../agent');
const { searchBook } = require('../document-search');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const localOnly = !process.argv.includes('--cloud');
if (!localOnly && fs.existsSync('.env')) process.loadEnvFile('.env');
const fixtures = require('../indexing/rag-queries.json').test.filter(q => ['null', 'data', 'suspend', 'project'].includes(q.id));
const providers = [{ provider: 'local', model: 'qwen3.5:2b-q4_K_M' }];
if (!localOnly && process.env.DEEPSEEK_API_KEY) providers.push({ provider: 'deepseek', model: 'deepseek-flash' });
else if (!localOnly && process.env.GEMINI_API_KEY) providers.push({ provider: 'gemini', model: 'gemini-3.5-flash-lite' });
else if (!localOnly && process.env.OPENROUTER_API_KEY) providers.push({ provider: 'openrouter', model: 'openrouter/free' });
const report = { createdAt: new Date().toISOString(), providers, repeats: 2,
  note: 'Existing structure index, local rewrite and retrieval once per question, identical context for both providers. Generation excludes retrieval and chat memory extraction. First run may include model loading. Quality requires reading answers against context.', cases: [] };
const output = path.join(root, 'local-llm/rag-benchmark.json');
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
(async () => {
  for (const fixture of fixtures) {
    const context = await searchBook(fixture.query, 'structure', { rewrite: true }, { settings: providers[0] });
    const item = { ...fixture, context, runs: [] };
    report.cases.push(item);
    for (let repeat = 1; repeat <= report.repeats; repeat++) for (const settings of providers) {
      const agent = new Agent({ ...settings, temperature: 0, keepMessages: 1 }, {
        fetchImpl: (url, init) => {
          if (settings.provider === 'local' && new URL(url).origin !== 'http://127.0.0.1:11434') throw new Error('Non-local request blocked');
          return fetch(url, { ...init, signal: AbortSignal.timeout(300000) });
        }
      });
      const started = performance.now();
      const run = { ...settings, repeat };
      try {
        run.answer = await agent.respond(fixture.query, { documentSearch: structuredClone(context), ragMode: 'rag', toolsEnabled: false });
        run.result = agent.messages.at(-1).documentSearch;
        run.usage = agent.tokenStats;
      } catch (error) { run.error = error.message; }
      run.seconds = (performance.now() - started) / 1000;
      item.runs.push(run);
      save();
      console.log(JSON.stringify({ id: fixture.id, provider: settings.provider, repeat, seconds: run.seconds, status: run.result?.answerStatus, error: run.error }));
    }
  }
  save();
})().catch(error => { report.error = error.message; save(); console.error(error.message); process.exitCode = 1; });
