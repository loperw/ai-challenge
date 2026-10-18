// Real end-to-end evaluation: Ollama embeddings + DeepSeek generation, no mocked LLM.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { review } = require('../pr-review');
(async () => {
  const project = path.resolve(__dirname, '..');
  if (fs.existsSync(path.join(project, '.env'))) process.loadEnvFile(path.join(project, '.env'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-review-eval-'));
  const output = path.join(project, 'data/pr-review-eval');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init'); git('config', 'user.name', 'Review Eval'); git('config', 'user.email', 'eval@example.invalid');
    fs.writeFileSync(path.join(root, 'README.md'), '# Account contract\ngetBalance(accounts, id) must return zero when the account does not exist. Missing accounts are normal, not an error.\n');
    fs.writeFileSync(path.join(root, 'balance.js'), 'exports.getBalance = (accounts, id) => accounts.find(a => a.id === id)?.balance ?? 0;\n');
    git('add', '.'); git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'balance.js'), 'exports.getBalance = (accounts, id) => accounts.find(a => a.id === id).balance;\n');
    git('add', '.'); git('commit', '-m', 'introduce missing-account regression');
    const markdown = await review({ root, base, head: 'HEAD', output });
    const input = JSON.parse(fs.readFileSync(path.join(output, 'input.json')));
    assert.ok(input.context.some(c => c.kind === 'documentation'));
    assert.ok(input.context.some(c => c.kind === 'code'));
    for (const heading of ['Потенциальные баги', 'Архитектурные проблемы', 'Рекомендации']) assert.ok(markdown.includes(heading));
    assert.match(markdown, /balance\.js/);
    assert.match(markdown, /TypeError|undefined/);
    assert.match(markdown, /отсутств|не найден|не существ/);
    fs.writeFileSync(path.join(output, 'evaluation.json'), JSON.stringify({ passed: true, provider: 'deepseek',
      checks: ['real embedding documentation context', 'real embedding code context', 'missing account regression detected', 'three review sections'],
      date: new Date().toISOString() }, null, 2));
    console.log('PASS: real DeepSeek review detected missing-account regression; code and documentation RAG verified.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
