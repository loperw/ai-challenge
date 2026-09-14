const test = require('node:test');
const assert = require('node:assert/strict');
const { Agent } = require('../agent');
const { estimateTokens, estimateHistory } = require('../public/token-counter');

function response(provider, payloads) {
  return { provider, body: { async *[Symbol.asyncIterator]() {
    // Split UTF-8 and SSE frames across arbitrary network boundaries.
    const bytes = Buffer.from(payloads.map(payload => `data: ${JSON.stringify(payload)}\r\n\r\n`).join(''));
    for (let i = 0; i < bytes.length; i += 7) yield bytes.subarray(i, i + 7);
  } } };
}
test('preview is an explicit text estimate, with empty and Unicode input', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('test'), 1);
  assert.equal(estimateTokens('Привет'), 3);
  assert.equal(estimateHistory([{ content: 'test' }, { content: 'Привет' }]), 4);
});
for (const provider of ['deepseek', 'openrouter', 'gemini']) {
  test(`${provider}: uses provider usage and finish reason, saves and rolls back stats`, async () => {
    let saved;
    const agent = new Agent({ provider, model: provider === 'gemini' ? 'gemini-3.5-flash' : provider === 'openrouter' ? 'openrouter/free' : 'deepseek-flash', maxTokens: 100 }, {
      persist: (...args) => { saved = args; }
    });
    const gemini = provider === 'gemini';
    agent.createCompletion = async () => response(provider, gemini ? [
      { candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: 'Привет' }] } }] },
      { candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 22, candidatesTokenCount: 8, totalTokenCount: 32, thoughtsTokenCount: 2 } }
    ] : [
      { choices: [{ delta: { content: 'Привет' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
      { choices: [], usage: { prompt_tokens: 22, completion_tokens: 8, total_tokens: 30 } }
    ]);
    assert.equal(await agent.respond('Вопрос'), 'Привет');
    assert.equal(agent.tokenStats.inputTokens, 22);
    assert.equal(agent.tokenStats.outputTokens, 8);
    assert.equal(agent.tokenStats.totalTokens, gemini ? 32 : 30);
    assert.equal(agent.tokenStats.limited, true);
    assert.deepEqual(saved[2], agent.tokenStats);
    const previous = agent.tokenStats;
    agent.createCompletion = async () => { throw new Error('offline'); };
    await assert.rejects(agent.respond('Ошибка'));
    assert.deepEqual(agent.tokenStats, previous);
    assert.equal(agent.messages.length, 2);
    agent.reset();
    assert.equal(agent.tokenStats, null);
  });
}
test('missing usage stays estimated', async () => {
  const agent = new Agent({ provider: 'deepseek', model: 'deepseek-flash' });
  agent.createCompletion = async () => response('deepseek', [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
  await agent.respond('hello');
  assert.equal(agent.tokenStats.outputTokens, undefined);
  assert.equal(agent.tokenStats.outputEstimate, 1);
  assert.equal(agent.tokenStats.limited, false);
});
test('invalid output limits are rejected', () => {
  for (const maxTokens of [0, -1, 1.5, 'abc', 384001]) {
    assert.throws(() => new Agent({ provider: 'deepseek', model: 'deepseek-flash', maxTokens }));
  }
});

test('exhausted dialogue budget rejects before API call and preserves history', async () => {
  let called = false;
  const messages = [{ role: 'user', content: 'test' }, { role: 'assistant', content: 'test' }];
  const agent = new Agent({ provider: 'deepseek', model: 'deepseek-flash', maxTokens: 3 }, { messages });
  agent.createCompletion = async () => { called = true; throw new Error('Unexpected API call'); };
  await assert.rejects(agent.respond('test'), /Лимит токенов диалога исчерпан/);
  assert.equal(called, false);
  assert.deepEqual(agent.messages, messages);
  assert.equal(agent.busy, false);
});

for (const provider of ['deepseek', 'openrouter', 'gemini']) {
  test(`${provider}: dialogue budget subtracts full history on subsequent requests`, async t => {
    const key = `${provider.toUpperCase()}_API_KEY`;
    const previousKey = process.env[key];
    process.env[key] = 'test-key';
    t.after(() => {
      if (previousKey === undefined) delete process.env[key];
      else process.env[key] = previousKey;
    });
    const requests = [];
    const gemini = provider === 'gemini';
    const agent = new Agent({
      provider, model: gemini ? 'gemini-3.5-flash' : provider === 'openrouter' ? 'openrouter/free' : 'deepseek-flash',
      maxTokens: 100, systemPrompt: 'System'
    }, { fetchImpl: async (url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, body: response(provider, [gemini
        ? { candidates: [{ content: { parts: [{ text: 'Reply' }] } }] }
        : { choices: [{ delta: { content: 'Reply' } }] }
      ]).body };
    } });
    await agent.respond('First question');
    await agent.respond('Next question');
    const body = requests[1];
    assert.equal(gemini ? body.generationConfig.maxOutputTokens : body.max_tokens, 100 - estimateHistory(agent.messages.slice(0, -1)) - estimateTokens('System'));
    const contents = gemini ? body.contents.map(message => message.parts[0].text)
      : body.messages.filter(message => message.role !== 'system').map(message => message.content);
    assert.deepEqual(contents, ['First question', 'Reply', 'Next question']);
    assert.equal(agent.tokenStats.requestEstimate, estimateTokens('Next question'));
    assert.equal(agent.tokenStats.historyEstimate, estimateTokens('First question') + 2 * estimateTokens('Reply') + estimateTokens('Next question'));
    assert.equal(agent.tokenStats.inputEstimate, agent.tokenStats.historyEstimate - estimateTokens('Reply') + estimateTokens('System'));
    agent.configure({ ...agent.settings, maxTokens: '' });
    await agent.respond('Default limit');
    assert.equal(gemini ? requests[2].generationConfig.maxOutputTokens : requests[2].max_tokens, undefined);
  });
}
