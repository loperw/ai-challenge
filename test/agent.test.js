const test = require('node:test');
const assert = require('node:assert/strict');
const { Agent, AgentError, AgentRegistry } = require('../agent');

function streamResponse(tokens) {
  return {
    ok: true,
    status: 200,
    body: {
      async *[Symbol.asyncIterator]() {
        for (const token of tokens) {
          yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`);
        }
        yield Buffer.from('data: [DONE]\n\n');
      }
    }
  };
}

function deepSeekSettings(overrides = {}) {
  return {
    provider: 'deepseek',
    model: 'deepseek-flash',
    temperature: 0.4,
    maxTokens: 500,
    stopSequence: '###',
    systemPrompt: 'Отвечай кратко.',
    ...overrides
  };
}

test('Agent owns the message stack and applies generation settings', async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const requests = [];
  const responses = [streamResponse(['Первый ответ']), streamResponse(['Второй ответ'])];
  const agent = new Agent(deepSeekSettings(), {
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return responses.shift();
    }
  });

  try {
    assert.equal(await agent.respond('Первый вопрос'), 'Первый ответ');
    assert.equal(await agent.respond('Второй вопрос'), 'Второй ответ');
  } finally {
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }

  assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(requests[0].body.temperature, 0.4);
  assert.equal(requests[0].body.max_tokens, 500);
  assert.deepEqual(requests[0].body.stop, ['###']);
  assert.equal(requests[0].body.messages[0].role, 'system');
  assert.equal(requests[0].body.messages[0].content, 'Отвечай кратко.');
  assert.deepEqual(requests[1].body.messages.slice(1), [
    { role: 'user', content: 'Первый вопрос' },
    { role: 'assistant', content: 'Первый ответ' },
    { role: 'user', content: 'Второй вопрос' }
  ]);
  assert.deepEqual(agent.messages, [
    { role: 'user', content: 'Первый вопрос' },
    { role: 'assistant', content: 'Первый ответ' },
    { role: 'user', content: 'Второй вопрос' },
    { role: 'assistant', content: 'Второй ответ' }
  ]);
});

test('Agent rolls back a user message when the LLM request fails', async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const agent = new Agent(deepSeekSettings(), {
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'Лимит' } }) })
  });

  try {
    await assert.rejects(agent.respond('Не сохранится'), error => error instanceof AgentError && error.status === 429);
  } finally {
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
  assert.deepEqual(agent.messages, []);
});

test('AgentRegistry isolates and resets conversations', () => {
  const registry = new AgentRegistry({ fetchImpl: async () => streamResponse(['ok']) });
  const first = registry.get('chat-1', deepSeekSettings());
  const second = registry.get('chat-2', deepSeekSettings());
  first.messages.push({ role: 'user', content: 'Контекст' });

  assert.notEqual(first, second);
  assert.deepEqual(second.messages, []);
  registry.reset('chat-1');
  assert.deepEqual(first.messages, []);
});

test('Agent validates the canonical DeepSeek V4.1 API model', () => {
  assert.doesNotThrow(() => new Agent(deepSeekSettings()));
  assert.throws(() => new Agent(deepSeekSettings({ model: 'deepseek-v4-flash' })), AgentError);
});
