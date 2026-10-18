const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { collect, allowed } = require('../pr-review');

test('PR diff uses merge-base, committed files and code/documentation chunks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init'); git('config', 'user.name', 'Review Test'); git('config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(root, 'README.md'), '# Contract\nReturn zero for an empty list.\n');
    fs.writeFileSync(path.join(root, 'sum.js'), 'module.exports = xs => xs.reduce((a, b) => a + b, 0);\n');
    git('add', '.'); git('commit', '-m', 'base');
    const ancestor = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'base-only.md'), 'not in PR');
    git('add', '.'); git('commit', '-m', 'base advances');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'feature', ancestor);
    fs.writeFileSync(path.join(root, 'sum.js'), 'module.exports = xs => xs.reduce((a, b) => a + b);\n');
    git('add', '.'); git('commit', '-m', 'regression');
    fs.writeFileSync(path.join(root, 'sum.js'), 'uncommitted content must not leak');
    const result = collect(root, base, 'HEAD');
    assert.deepEqual(result.files, ['sum.js']);
    assert.match(result.diff, /-module.exports.*0/);
    assert.ok(!result.diff.includes('uncommitted'));
    assert.ok(result.chunks.some(c => c.kind === 'documentation'));
    assert.ok(result.chunks.some(c => c.kind === 'code' && c.line === 1));
    assert.equal(result.ancestor, ancestor);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('secret and generated locations are excluded', () => {
  for (const file of ['.env', 'data/trace.js', 'node_modules/a.js', 'keys/credentials.json', 'private-key.md']) assert.equal(allowed(file), false);
  assert.equal(allowed('docs/api.md'), true);
  assert.equal(allowed('agent.js'), true);
});
