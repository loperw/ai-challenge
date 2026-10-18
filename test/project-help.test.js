const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { indexProject, parseHelp, prepareHelp } = require('../project-help');

test('help command requires a boundary and supplies overview for empty question', () => {
  assert.equal(parseHelp('/helper'), null);
  assert.equal(parseHelp('обычный вопрос'), null);
  assert.equal(parseHelp(' /help Где память? '), 'Где память?');
  assert.match(parseHelp('/help'), /Структура/);
});
test('RAG indexes README and nested docs, refreshes edits/deletions, ignores other files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-rag-'));
  try {
    fs.mkdirSync(path.join(root, 'docs/nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'README.md'), '# Обзор\nПриложение');
    const file = path.join(root, 'docs/nested/storage.md');
    fs.writeFileSync(file, '# История\nИстория хранится в sqlite-store.js');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=never-index');
    const first = indexProject(root);
    assert.ok(first.chunks.some(c => c.file === 'README.md'));
    assert.ok(first.chunks.some(c => c.file === 'docs/nested/storage.md'));
    assert.ok(!JSON.stringify(first).includes('SECRET'));
    fs.writeFileSync(file, '# Замена\nНовые сведения');
    assert.notEqual(indexProject(root).fingerprint, first.fingerprint);
    fs.unlinkSync(file);
    assert.ok(!indexProject(root).chunks.some(c => c.file === 'docs/nested/storage.md'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('real MCP returns current git branch and combines it with supplied retrieval results', async () => {
  const traces = [];
  const help = await prepareHelp('Где хранится история?', {
    retrieve: async () => indexProject().chunks.filter(c => c.file === 'docs/architecture.md' && c.text.includes('sqlite-store.js')),
    onTrace: t => traces.push(t) });
  const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
  assert.equal(help.trace.result.branch, branch);
  assert.ok(help.trace.result.files.includes('agent.js'));
  assert.ok(help.hits.some(h => h.file === 'docs/architecture.md' && h.text.includes('sqlite-store.js')));
  assert.match(help.prompt, /Источники RAG/);
  assert.ok(traces.some(t => t.steps.some(s => s.method === 'tools/call' && s.status === 'done')));
});
test('API indexing includes body evidence, not an isolated document title', () => {
  const hits = indexProject().chunks;
  assert.ok(hits.some(hit => hit.file === 'docs/api.md' && hit.text.includes('POST /api/chat')));
  assert.ok(hits.every(hit => hit.text.split('\n').some(line => line.trim() && !/^#+ /.test(line))));
});
test('help context reaches LLM and is removed after the turn', async () => {
  const { Agent } = require('../agent');
  const old = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test';
  const requests = [];
  const agent = new Agent({ provider: 'deepseek', model: 'deepseek-flash' }, {
    fetchImpl: async (url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, body: { async *[Symbol.asyncIterator]() {
        yield Buffer.from('data: {"choices":[{"delta":{"content":"История: sqlite-store.js (docs/architecture.md)."}}]}\n\ndata: [DONE]\n\n');
      } } };
    }
  });
  try {
    await agent.respond('/help Где история?', { toolsEnabled: false, projectHelpContext: 'UNIQUE_PROJECT_CONTEXT', projectHelpQuestion: 'Где история?' });
    assert.match(requests[0].messages.at(-1).content, /UNIQUE_PROJECT_CONTEXT/);
    assert.ok(requests[0].messages.at(-1).content.startsWith('Где история?\n\n'));
    assert.equal(agent.messages[0].content, '/help Где история?');
    assert.equal(agent.projectHelpQuestion, '');
    assert.ok(!agent.systemPrompt().includes('UNIQUE_PROJECT_CONTEXT'));
    assert.match(agent.systemPrompt(), /ordinary chat turn/);
    agent.documentSearch = { hits: [] };
    assert.ok(!agent.systemPrompt().includes('ordinary chat turn'), 'Book RAG must retain its citation rules');
    agent.documentSearch = null;
    assert.ok(!JSON.stringify(agent.messages).includes('UNIQUE_PROJECT_CONTEXT'));
  } finally { if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old; }
});
