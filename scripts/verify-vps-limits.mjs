import assert from 'node:assert/strict';
const base = process.env.CHAT_URL || 'http://127.0.0.1:3000';
const model = process.env.LOCAL_MODEL || 'qwen3:0.6b';
async function post(extra = {}, headers = {}) {
  return fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ ephemeral: true, provider: 'local', model, message: 'Тест', ...extra }) });
}
const checks = [];
for (const [name, body, expected] of [
  ['cloud rejected', { provider: 'deepseek' }, 400],
  ['model rejected', { model: 'qwen3:cloud' }, 400],
  ['context setting capped', { contextWindow: 8192 }, 400],
  ['output capped', { maxTokens: 257 }, 400],
  ['prompt budget enforced', { message: 'я'.repeat(4000) }, 413],
  ['body capped', { message: 'a'.repeat(70000) }, 413]
]) {
  const r = await post(body); const detail = await r.text();
  assert.equal(r.status, expected, `${name}: ${detail}`); checks.push({ name, status: r.status });
}
const cross = await post({}, { Origin: 'https://unrelated.example' });
assert.equal(cross.status, 403); checks.push({ name: 'cross-origin rejected', status: cross.status });
for (let n = 0; n < 6; n++) { const r = await post({ model: 'not-allowed' }); assert.equal(r.status, 400); await r.text(); }
const limited = await post({ model: 'not-allowed' });
assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
checks.push({ name: '13th write rate limited', status: limited.status });
console.log(JSON.stringify({ checks }, null, 2));
