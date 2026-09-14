const test = require('node:test');
const assert = require('node:assert/strict');
const { Agent, AgentRegistry } = require('../agent');
const { HistoryStore } = require('../history-store');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

for (const provider of ['deepseek', 'openrouter', 'gemini']) {
  test(`${provider}: summary replaces old messages, merges incrementally and survives restart`, async t => {
    const key = `${provider.toUpperCase()}_API_KEY`;
    const original = process.env[key];
    process.env[key] = 'test-key';
    const directory = mkdtempSync(join(tmpdir(), 'context-test-'));
    t.after(() => {
      if (original === undefined) delete process.env[key]; else process.env[key] = original;
      rmSync(directory, { recursive: true, force: true });
    });
    const requests = [];
    let fail = false;
    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (fail) throw new Error('offline');
      const text = `reply-${requests.length}`;
      const payload = provider === 'gemini'
        ? { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 } }
        : { choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
      return { ok: true, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(`data: ${JSON.stringify(payload)}\n\n`); } } };
    };
    const settings = { provider, model: provider === 'gemini' ? 'gemini-3.5-flash' : provider === 'openrouter' ? 'openrouter/free' : 'deepseek-flash', keepMessages: 2, summarizeEvery: 2 };
    const file = join(directory, 'chats.json');
    let registry = new AgentRegistry({ store: new HistoryStore(file), fetchImpl });
    let agent = registry.get('chat', settings);
    await agent.respond('first');
    await agent.respond('second');
    assert.equal(requests.length, 2);
    await agent.respond('third');
    assert.equal(requests.length, 4);
    assert.equal(agent.context.summarizedCount, 3);
    assert.equal(agent.context.summary, 'reply-3');
    const texts = body => provider === 'gemini' ? body.contents.map(item => item.parts[0].text) : body.messages.filter(item => item.role !== 'system').map(item => item.content);
    assert.deepEqual(texts(requests[3]), ['reply-2', 'third']);
    assert.equal(JSON.stringify(requests[3]).includes('first'), false);
    assert.equal(JSON.stringify(requests[3]).includes('reply-3'), true);
    assert.equal(agent.messages.length, 6);
    assert.deepEqual(agent.context.turns.at(-1), { requestTokens: 30, summaryTokens: 30, estimated: false, summarized: true });
    registry = new AgentRegistry({ store: new HistoryStore(file), fetchImpl });
    agent = registry.get('chat', settings);
    assert.equal(agent.context.summary, 'reply-3');
    assert.equal(agent.context.turns.length, 3);
    await agent.respond('fourth');
    const summaryData = JSON.parse(texts(requests[4])[0]);
    assert.equal(summaryData.previousSummary, 'reply-3');
    assert.deepEqual(summaryData.messages.map(item => item.content), ['reply-2', 'third']);
    const previous = structuredClone(agent.context);
    const previousMessages = structuredClone(agent.messages);
    fail = true;
    await assert.rejects(agent.respond('failed'), /offline/);
    assert.deepEqual(agent.context, previous);
    assert.deepEqual(agent.messages, previousMessages);
    assert.deepEqual(new HistoryStore(file).chats.chat.context, previous);
    registry.reset('chat');
    assert.deepEqual(agent.context, { summary: '', summarizedCount: 0, turns: [] });
  });
}

test('context settings reject invalid values', () => {
  for (const key of ['keepMessages', 'summarizeEvery']) {
    for (const value of ['', 0, -1, 1.5, 'oops', 1001]) {
      assert.throws(() => new Agent({ provider: 'deepseek', model: 'deepseek-flash', [key]: value }), /Параметры контекста/);
    }
  }
});
