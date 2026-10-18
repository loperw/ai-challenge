const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildProjectIndex, searchProject } = require('../project-help');

test('vector search uses document/query prefixes, cosine, persistent cache and model digest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-vectors-'));
  const calls = [];
  let digest = 'v1';
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'nomic-embed-text:latest', digest }] }) };
    const body = JSON.parse(options.body);
    calls.push(body);
    return { ok: true, json: async () => ({ embeddings: body.input.map(text => text.startsWith('search_query:') || text.includes('Хранилище') ? [3, 0] : [0, 7]) }) };
  };
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'README.md'), '# Интерфейс\nКнопки');
    const file = path.join(root, 'docs/storage.md');
    fs.writeFileSync(file, '# Хранилище\nДанные');
    const first = await buildProjectIndex(root, { fetchImpl });
    assert.equal(first.embeddedCount, 2);
    assert.ok(calls[0].input.every(text => text.startsWith('search_document:')));
    assert.equal(calls[0].truncate, false);
    const hits = await searchProject('Где лежит переписка?', first, 1, { fetchImpl });
    assert.equal(hits[0].file, 'docs/storage.md');
    assert.equal(hits[0].score, 1);
    assert.ok(!('vector' in hits[0]) && !('titleVector' in hits[0]));
    assert.match(calls.at(-1).input[0], /^search_query:/);
    assert.equal((await buildProjectIndex(root, { fetchImpl })).embeddedCount, 0);
    fs.writeFileSync(file, '# Хранилище\nИзменённые данные');
    assert.equal((await buildProjectIndex(root, { fetchImpl })).embeddedCount, 1);
    fs.unlinkSync(file);
    const deleted = await buildProjectIndex(root, { fetchImpl });
    assert.equal(deleted.chunks.length, 1);
    assert.equal(deleted.embeddedCount, 0);
    digest = 'v2';
    assert.equal((await buildProjectIndex(root, { fetchImpl })).embeddedCount, 1);
    fs.writeFileSync(path.join(root, 'data/project-vectors.json'), 'corrupt');
    const concurrent = await Promise.all([buildProjectIndex(root, { fetchImpl }), buildProjectIndex(root, { fetchImpl })]);
    assert.deepEqual(concurrent.map(index => index.embeddedCount), [1, 0]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Ollama failure and invalid vectors do not silently fall back to keyword search', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-vectors-error-'));
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'README.md'), '# Test\nContent');
    await assert.rejects(buildProjectIndex(root, { fetchImpl: async () => { throw new Error('offline'); } }), /Эмбеддинги документации недоступны/);
    await assert.rejects(searchProject('query', { dimension: 2, chunks: [{ vector: [1, 0], titleVector: [1, 0] }] }, 3, {
      fetchImpl: async () => ({ ok: true, json: async () => ({ embeddings: [[0, 0]] }) })
    }), /Нулевой/);
    assert.ok(!fs.existsSync(path.join(root, 'data/project-vectors.json')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
