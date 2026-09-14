const test = require('node:test');
const assert = require('node:assert/strict');
const { Agent, AgentRegistry } = require('../agent');
const { HistoryStore } = require('../history-store');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
for (const provider of ['deepseek', 'openrouter', 'gemini']) {
  test(`${provider}: window, facts, branches, persistence and rollback`, async t => {
    const key = `${provider.toUpperCase()}_API_KEY`, original = process.env[key]; process.env[key] = 'test';
    const dir = mkdtempSync(join(tmpdir(), 'strategy-'));
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; rmSync(dir, { recursive: true, force: true }); });
    const requests = []; let fail = false, malformed = false, factCount = 0;
    const fetchImpl = async (_, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      if (fail) throw new Error('offline');
      const extracting = JSON.stringify(body).includes('Обнови facts');
      const text = extracting ? (malformed ? 'oops' : JSON.stringify({ goal: ++factCount === 1 ? 'old' : 'new' })) : `answer-${requests.length}`;
      const payload = provider === 'gemini' ? { candidates: [{ content: { parts: [{ text }] } }] } : { choices: [{ delta: { content: text } }] };
      return { ok: true, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(`data: ${JSON.stringify(payload)}\n\n`); } } };
    };
    const settings = { provider, model: provider === 'gemini' ? 'gemini-3.5-flash' : provider === 'openrouter' ? 'openrouter/free' : 'deepseek-flash', keepMessages: 2 };
    const file = join(dir, 'chats.json');
    let registry = new AgentRegistry({ store: new HistoryStore(file), fetchImpl });
    let agent = registry.get('chat', settings);
    await agent.respond('first'); await agent.respond('second'); await agent.respond('third');
    assert.equal(requests.length, 3); assert.equal(agent.messages.length, 2);
    assert.ok(!JSON.stringify(requests.at(-1)).includes('first'));
    const texts = body => provider === 'gemini' ? body.contents.map(m => m.parts[0].text) : body.messages.filter(m => m.role !== 'system').map(m => m.content);
    assert.deepEqual(texts(requests.at(-1)), ['answer-2', 'third']);
    agent.configure({ ...settings, contextStrategy: 'facts' });
    await agent.respond('goal old'); await agent.respond('goal new');
    assert.equal(factCount, 2); assert.deepEqual(agent.context.facts, { goal: 'new' });
    assert.ok(JSON.stringify(requests.at(-1)).includes('new'));
    const before = structuredClone({ messages: agent.messages, context: agent.context });
    malformed = true; await assert.rejects(agent.respond('bad'), /JSON/); malformed = false;
    assert.deepEqual({ messages: agent.messages, context: agent.context }, before);
    agent.configure({ ...settings, contextStrategy: 'branching' });
    agent.branchAction('checkpoint'); const checkpoint = Object.keys(agent.context.checkpoints)[0];
    const base = structuredClone(agent.messages);
    agent.branchAction('fork', checkpoint); const branchA = agent.context.activeBranch;
    await agent.respond('only-A'); const answerA = agent.messages.at(-1).content;
    agent.branchAction('fork', checkpoint); const branchB = agent.context.activeBranch;
    assert.deepEqual(agent.messages, base);
    await agent.respond('only-B'); assert.ok(!JSON.stringify(requests.at(-1)).includes('only-A'));
    agent.branchAction('switch', branchA); assert.equal(agent.messages.at(-1).content, answerA);
    assert.deepEqual(agent.context.checkpoints[checkpoint].messages, base);
    registry = new AgentRegistry({ store: new HistoryStore(file), fetchImpl });
    agent = registry.get('chat', { ...settings, contextStrategy: 'branching' });
    assert.equal(agent.context.activeBranch, branchA);
    agent.branchAction('switch', branchB); assert.equal(agent.messages.at(-2).content, 'only-B');
    fail = true; const previous = structuredClone(agent.messages);
    await assert.rejects(agent.respond('failed'), /offline/); assert.deepEqual(agent.messages, previous);
    agent.busy = true; assert.throws(() => agent.branchAction('checkpoint'), /Дождитесь/); agent.busy = false;
    registry.reset('chat'); assert.deepEqual(agent.context, { facts: {}, turns: [] });
  });
}
test('rejects unknown strategy and invalid window', () => {
  const settings = { provider: 'deepseek', model: 'deepseek-flash' };
  assert.throws(() => new Agent({ ...settings, contextStrategy: 'summary' }), /стратегия/);
  for (const keepMessages of [0, -1, 1.5, 'oops', 1001]) assert.throws(() => new Agent({ ...settings, keepMessages }), /Параметры/);
});

test('facts normalizes structured values and a facts wrapper before answering', async () => {
  const agent = new Agent({ provider: 'deepseek', model: 'deepseek-flash', contextStrategy: 'facts' });
  const original = Agent.prototype.createCompletion;
  const outputs = [JSON.stringify({ facts: { goal: 'trip', budget: 100, confirmed: false, preferences: ['quiet', 'sea'], constraints: { days: 3 }, removed: null } }), 'Ready'];
  const prompts = [];
  Agent.prototype.createCompletion = async function () {
    prompts.push(this.systemPrompt());
    const text = outputs.shift();
    return { provider: 'deepseek', body: { async *[Symbol.asyncIterator]() { yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`); } } };
  };
  try {
    assert.equal(await agent.respond('Plan my trip'), 'Ready');
    assert.deepEqual(agent.context.facts, { goal: 'trip', budget: '100', confirmed: 'false', preferences: '["quiet","sea"]', constraints: '{"days":3}' });
    assert.ok(prompts[1].includes('quiet'));
    assert.equal(agent.messages.at(-1).content, 'Ready');
  } finally { Agent.prototype.createCompletion = original; }
});
