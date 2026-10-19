import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Agent } from '../agent.js';
import { openMultiMcpSession } from '../mcp/registry.mjs';
import { WorkspaceFiles } from '../workspace-files.mjs';

// Never print credentials. Use the same local configuration as the application.
try {
  for (const line of (await fs.readFile('.env', 'utf8')).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-assistant-live-'));
for (const name of ['README.md', 'docs/api.md', 'src/api-client.js', 'src/profile.js', 'src/dashboard.js']) {
  await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await fs.copyFile(path.resolve('examples/file-assistant', name), path.join(root, name));
}
const provider = process.env.FILE_ASSISTANT_PROVIDER || 'deepseek';
// Seed stale documentation only in the temporary demo, even after manual UI runs updated the examples.
await fs.writeFile(path.join(root, 'docs/api.md'), '# API\n\nfetchUser() не принимает аргументов и вызывает GET /api/users/me.\n');
await fs.writeFile(path.join(root, 'README.md'), '# Демонстрационный проект\n\nfetchUser вызывается без аргументов.\n');
const model = process.env.FILE_ASSISTANT_MODEL || 'deepseek-flash';
const results = { provider, model, root, runs: [] };
const workspace = new WorkspaceFiles(root);
try {
  for (const prompt of [
    'Найди все использования fetchUser в этом проекте, прочитай определение и места вызовов, сохрани отчёт в той же папке с номерами строк и влиянием изменения параметров. Имя отчёта: fetchUser-usage.md.',
    'Приведи документацию проекта в соответствие с текущим кодом API. Сам найди и прочитай код и документацию, подготовь изменения всех устаревших описаний.'
  ]) {
    const run = { prompt, calls: [] }; results.runs.push(run);
    const before = await workspace.read('docs/api.md');
    const agent = new Agent({ provider, model, maxTokens: 32000 }, {
      openToolSession: () => openMultiMcpSession({ registry: [{ id: 'workspace', role: 'workspace' }], env: { FILE_WORKSPACE_ROOT: root }, stderr: 'pipe' })
    });
    run.answer = await agent.respond(prompt, { onToolResult: (name, result) => {
      run.calls.push({ name, error: Boolean(result.isError) });
      if (name === 'workspace__create_report' && !result.isError) run.reportPath = result.structuredContent.path;
      if (result.structuredContent?.proposal) run.proposal = result.structuredContent.proposal;
    } });
    if (results.runs.length === 1 && run.proposal) throw new Error('New report must not require approval');
    if (run.proposal) {
      if (await workspace.read('docs/api.md') !== before) throw new Error('Preview modified files');
      if (run.proposal.entries.length < 2) throw new Error('Expected two documentation changes');
      run.previewVerified = true;
      // Live demo leaves proposed modifications unapproved. Approval is tested separately.
    }
  }
  if (!results.runs[0].reportPath) throw new Error('Model did not create a report');
  results.report = await workspace.read(results.runs[0].reportPath);
  if (!results.runs[1].proposal) throw new Error('Model did not propose changes');
  results.status = 'passed';
} catch (error) { results.status = 'failed'; results.error = error.message; process.exitCode = 1; }
await fs.mkdir('data/file-assistant', { recursive: true });
await fs.writeFile('data/file-assistant/live-results.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify({ status: results.status, error: results.error, root, calls: results.runs.map(r => r.calls), results: 'data/file-assistant/live-results.json' }, null, 2));
