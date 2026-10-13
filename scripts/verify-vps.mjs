// Run from a VPN-connected device with Node 22+. No credentials are needed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const base = process.env.CHAT_URL || 'http://127.0.0.1:3000';
const model = process.env.LOCAL_MODEL || 'qwen3:0.6b';
const results = [];
async function chat(message) {
  const start = performance.now();
  let firstToken = null, end, text = '', done = false;
  const response = await fetch(`${base}/api/chat`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(300000),
    body: JSON.stringify({ conversationId: randomUUID(), provider: 'local', model,
      message, keepMessages: 2, maxTokens: 160 }) });
  assert.equal(response.status, 200);
  let buffer = ''; const decoder = new TextDecoder();
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') { done = true; continue; }
      const item = JSON.parse(payload);
      assert.ok(!item.error, item.error);
      const token = item.choices?.[0]?.delta?.content;
      if (token) { firstToken ??= performance.now(); text += token; }
    }
  }
  end = performance.now(); assert.ok(done && text.length, 'Incomplete generation');
  return { start, firstToken, end, durationMs: Math.round(end - start), text };
}
assert.equal((await fetch(`${base}/api/health`)).status, 200);
// Warm the model before measuring overlap.
await chat('Скажи: готово.');
for (let round = 0; round < 3; round++) {
  const pair = await Promise.all([
    chat('Расскажи подробно, как образуются облака.'),
    chat('Расскажи подробно, как растут деревья.')
  ]);
  const overlap = Math.max(...pair.map(r => r.firstToken)) < Math.min(...pair.map(r => r.end));
  results.push({ round: round + 1, overlap, pair });
}
console.log(JSON.stringify({ base, results }, null, 2));
assert.ok(results.every(r => r.overlap), 'Not all rounds streamed concurrently; inspect Ollama runner logs before claiming parallel inference.');
