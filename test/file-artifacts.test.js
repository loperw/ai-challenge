const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { fileArtifact, serveFileArtifact, restoreLegacyFileCards } = require('../file-artifacts');
const { SQLiteStore } = require('../sqlite-store');

test('preview and download serve exact UTF-8 content, Unicode names and safe headers', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-cards-'));
  const content = '# Проверка 👋\n<script>alert("xss")</script>\n';
  const name = 'Отчёт MCP.md';
  await fs.writeFile(path.join(dir, name), content);
  const server = http.createServer((req, res) => serveFileArtifact(req, res, dir));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const file = fileArtifact(name, Buffer.byteLength(content));
  for (const [url, disposition] of [[file.previewUrl, 'inline'], [file.downloadUrl, 'attachment']]) {
    const response = await fetch(base + url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), content);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(response.headers.get('content-disposition').startsWith(disposition));
    assert.ok(response.headers.get('content-disposition').includes(encodeURIComponent(name)));
  }
  for (const name of ['missing.txt', '..%2Fsecret.txt', '..%5Csecret.txt', '%ZZ', 'index.html', '%00.txt']) {
    assert.equal((await fetch(`${base}/api/files/${name}`)).status, 404);
  }
});

test('file cards survive saved conversation reload without exposing filesystem paths', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-history-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'chats.sqlite');
  const file = fileArtifact('report.md', 123);
  const store = new SQLiteStore(dbPath);
  store.save('files', { provider: 'deepseek', model: 'deepseek-flash' }, [{ role: 'assistant', content: 'Готово.', files: [file] }]);
  store.close();
  const restored = new SQLiteStore(dbPath);
  try {
    assert.deepEqual(restored.chats.files.messages[0].files, [file]);
    assert.equal(Object.hasOwn(file, 'path'), false);
  } finally { restored.close(); }
});

test('old saved-file replies become cards only for existing files in the export directory', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-file-cards-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'report.md'), 'Отчёт');
  const messages = [
    { role: 'assistant', content: `Готовый отчёт.\n\nСохранено: \`${path.join(dir, 'report.md')}\`` },
    { role: 'assistant', content: `Сохранено: \`${path.join(dir, 'missing.md')}\`` },
    { role: 'user', content: `Сохранено: \`${path.join(dir, 'report.md')}\`` },
    { role: 'assistant', content: `Сохранено: \`${path.resolve(dir, '..', 'secret.txt')}\`` }
  ];
  const restored = await restoreLegacyFileCards(messages, dir);
  assert.equal(restored[0].content, 'Готовый отчёт.');
  assert.equal(restored[0].files[0].name, 'report.md');
  assert.deepEqual(restored.slice(1), messages.slice(1));
  assert.match(messages[0].content, /Сохранено/);
});
