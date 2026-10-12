const test = require('node:test');
const assert = require('node:assert/strict');
const { Agent } = require('../agent');
const { extractTaskMemory } = require('../task-memory');
const settings = { provider: 'local', model: 'qwen3.5:2b-q4_K_M', temperature: 0, keepMessages: 10 };
function response(text, complete = true) {
  const bytes = Buffer.from(JSON.stringify({ message: { content: text } }) + '\n' +
    (complete ? JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 3 }) : ''));
  return { ok: true, body: { async *[Symbol.asyncIterator]() {
    // Split inside UTF-8 characters and JSON lines.
    for (let i = 0; i < bytes.length; i += 2) yield bytes.subarray(i, i + 2);
  } } };
}
test('local chat streams UTF-8, retains history and never opens external tools', async () => {
  const requests = [];
  const agent = new Agent(settings, {
    openToolSession: () => { throw new Error('External tools must stay disabled'); },
    fetchImpl: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:11434/api/chat');
      assert.equal(init.headers.Authorization, undefined);
      requests.push(JSON.parse(init.body));
      return response('Привет!');
    }
  });
  const tokens = [];
  assert.equal(await agent.respond('Меня зовут Артём.', { toolsEnabled: true, onToken: token => tokens.push(token) }), 'Привет!');
  assert.equal(tokens.join(''), 'Привет!');
  await agent.respond('Как меня зовут?');
  assert.deepEqual(requests[1].messages.filter(m => m.role !== 'system'), [
    { role: 'user', content: 'Меня зовут Артём.' }, { role: 'assistant', content: 'Привет!' },
    { role: 'user', content: 'Как меня зовут?' }
  ]);
  assert.equal(requests[0].think, false);
  assert.equal(agent.tokenStats.outputTokens, 3);
});
test('memory extraction uses local JSON generation', async () => {
  const memory = { goal: 'Тест', clarifications: [], constraints: [], terms: [] };
  const result = await extractTaskMemory({ settings, userMessage: 'Тест', fetchImpl: async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(JSON.parse(init.body).format, 'json');
    return response(JSON.stringify(memory));
  } });
  assert.deepEqual(result.memory, memory);
});
test('local failures explain recovery and roll back incomplete messages', async () => {
  for (const [fetchImpl, pattern] of [
    [async () => { throw new Error('ECONNREFUSED'); }, /Ollama недоступна/],
    [async () => ({ ok: false, status: 404 }), /ollama pull qwen3.5/],
    [async () => response('Частичный ответ', false), /оборвался/],
    [async () => ({ ok: false, status: 500, json: async () => ({ error: 'out of memory' }) }), /out of memory/]
  ]) {
    const agent = new Agent(settings, { fetchImpl });
    await assert.rejects(agent.respond('Привет'), pattern);
    assert.deepEqual(agent.messages, []);
  }
});
test('local provider rejects arbitrary or cloud model names', () => {
  assert.throws(() => new Agent({ ...settings, model: 'cloud-model' }), /Выберите модель/);
});
