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
    const agent = new Agent({ provider, model: provider === 'gemini' ? 'gemini-3.5-flash' : provider === 'openrouter' ? 'openrouter/free' : 'deepseek-flash', maxTokens: 8 }, {
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
