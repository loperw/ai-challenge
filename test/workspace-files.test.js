const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-files-'));
  for (const name of ['README.md', 'docs/api.md', 'src/api-client.js', 'src/profile.js', 'src/dashboard.js']) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.copyFile(path.resolve('examples/file-assistant', name), path.join(root, name));
  }
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { WorkspaceFiles } = await import('../workspace-files.mjs');
  return { root, workspace: new WorkspaceFiles(root) };
}
test('search across code, create report, repeat without overwriting', async t => {
  const { workspace } = await setup(t);
  const results = await workspace.search('fetchUser');
  assert.equal(new Set(results.matches.filter(m => m.path.startsWith('src/')).map(m => m.path)).size, 3);
  const report = results.matches.map(m => `${m.path}:${m.line} ${m.text}`).join('\n');
  assert.equal((await workspace.createReport('reports/api-usage.md', report)).status, 'applied');
  assert.equal(await workspace.read('reports/api-usage.md'), report);
  assert.equal((await workspace.createReport('fetchUser-usage.md', report)).status, 'applied');
  assert.equal(await workspace.read('fetchUser-usage.md'), report);
  assert.equal((await workspace.createReport('reports/api-usage.md', report)).status, 'unchanged');
  await assert.rejects(workspace.createReport('reports/api-usage.md', 'different'));
});
test('preview writes nothing; No rejects; Yes applies exact two-file diff; replay is harmless', async t => {
  const { workspace } = await setup(t);
  const before = await workspace.read('docs/api.md');
  const changes = [{ path: 'docs/api.md', content: '# API\nfetchUser(userId, { signal }) — GET /api/v2/users/:id\n' }, { path: 'README.md', content: '# Demo\nAPI v2\n' }];
  const rejected = await workspace.propose(changes);
  assert.match(rejected.diff, /--- a\/docs\/api.md/);
  assert.equal(await workspace.read('docs/api.md'), before);
  await workspace.decide(rejected, false);
  await workspace.decide(rejected, true);
  assert.equal(await workspace.read('docs/api.md'), before);
  const approved = await workspace.propose(changes);
  await workspace.decide(approved, true);
  await workspace.decide(approved, true);
  for (const change of changes) assert.equal(await workspace.read(change.path), change.content);
  assert.equal((await workspace.propose(changes)).status, 'unchanged');
});
test('stale second file blocks the entire proposal before any writes', async t => {
  const { root, workspace } = await setup(t);
  const before = await workspace.read('README.md');
  const proposal = await workspace.propose([{ path: 'README.md', content: 'updated' }, { path: 'docs/api.md', content: 'updated' }]);
  await fs.writeFile(path.join(root, 'docs/api.md'), 'external edit');
  await assert.rejects(workspace.decide(proposal, true), /изменился/);
  assert.equal(proposal.status, 'conflict');
  assert.equal(await workspace.read('README.md'), before);
});
test('reject paths outside workspace, hidden files, links, duplicate targets and oversized contents', async t => {
  const { root, workspace } = await setup(t);
  for (const name of ['../README.md', '.env', 'C:/README.md', 'src/../../README.md', 'data/keys.json', 'a\\b.md']) await assert.rejects(workspace.read(name));
  await assert.rejects(workspace.propose([{ path: 'README.md', content: 'a' }, { path: 'readme.md', content: 'b' }]));
  await assert.rejects(workspace.propose([{ path: 'README.md', content: 'a'.repeat(200001) }]));
  await t.test('hard links', async t => {
    try { await fs.link(path.join(root, 'README.md'), path.join(root, 'linked.md')); }
    catch (error) { if (error.code === 'EPERM') { t.skip('Windows sandbox disallows hard link creation'); return; } throw error; }
    await assert.rejects(workspace.read('linked.md'), /Ссылки/);
  });
});
test('real MCP discovery/search/read/proposal and automatic loop stop before approval', async t => {
  const { root, workspace } = await setup(t);
  const { openMultiMcpSession } = await import('../mcp/registry.mjs');
  const { runToolLoop } = await import('../mcp/tool-loop.mjs');
  let round = 0, proposal;
  const operations = [ ['workspace__search_files', { query: 'fetchUser' }], ['workspace__read_file', { path: 'src/api-client.js' }], ['workspace__read_file', { path: 'docs/api.md' }], ['workspace__read_file', { path: 'README.md' }], ['workspace__propose_changes', { changes: [{ path: 'docs/api.md', content: 'API v2' }, { path: 'README.md', content: 'API v2' }] }] ];
  const agent = { contextMessages: () => [{ role: 'user', content: 'Приведи документацию в соответствие с кодом.' }],
    async createCompletion({ messages, tools }) {
      assert.ok(tools.some(t => t.function.name === 'workspace__propose_changes'));
      if (round) assert.equal(JSON.parse(messages.at(-1).content).isError, undefined);
      const [name, args] = operations[round++];
      this.completionToolCalls = [{ id: 'call-' + round, function: { name, arguments: JSON.stringify(args) } }]; this.finishReason = 'tool_calls'; return null;
    }, async *readCompletion() {}, checkInvariants: async () => ({ conflict: false }) };
  const before = await workspace.read('docs/api.md');
  const answer = await runToolLoop(agent, {
    openSession: () => openMultiMcpSession({ registry: [{ id: 'workspace', role: 'workspace' }], env: { FILE_WORKSPACE_ROOT: root }, stderr: 'pipe' }),
    onResult: (_, result) => { if (result.structuredContent?.proposal) proposal = result.structuredContent.proposal; }
  });
  assert.equal(round, 5); assert.match(answer, /diff/); assert.equal(proposal.status, 'pending');
  assert.equal(await workspace.read('docs/api.md'), before);
  await workspace.decide(proposal, true);
  assert.equal(await workspace.read('docs/api.md'), 'API v2');
});
