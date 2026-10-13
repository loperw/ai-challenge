import assert from 'node:assert/strict';
const base = process.env.CHAT_URL || 'http://127.0.0.1:3000';
function request(message, maxTokens = 100) {
  return fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(180000), body: JSON.stringify({ ephemeral: true,
      provider: 'local', model: process.env.LOCAL_MODEL || 'qwen3:0.6b', maxTokens, message }) });
}
const streams = await Promise.all([
  request('Перечисли 30 видов деревьев с краткими описаниями.'),
  request('Перечисли 30 городов с краткими описаниями.')
]);
assert.ok(streams.every(r => r.status === 200));
const third = await request('Третий запрос');
assert.equal(third.status, 429, await third.text());
for (const stream of streams) {
  const body = await stream.text();
  assert.match(body, /\[DONE\]/); assert.ok(!body.includes('"error":'), body);
}
const recovery = await request('Скажи привет.', 8);
assert.equal(recovery.status, 200);
const body = await recovery.text(); assert.ok(!body.includes('"error":'), body);
console.log(JSON.stringify({ parallel: 2, third: 429, recovered: true }));
