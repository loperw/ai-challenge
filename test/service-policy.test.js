const test = require('node:test');
const assert = require('node:assert/strict');
const { createGate, createRateLimiter, applySettings } = require('../service-policy');
test('two active generations are accepted; third fails; slots recover', () => {
  const gate = createGate(2);
  const a = gate.acquire(), b = gate.acquire();
  assert.equal(gate.active, 2);
  assert.throws(() => gate.acquire(), { status: 429 });
  a(); a(); const c = gate.acquire(); b(); c();
  assert.equal(gate.active, 0);
});
test('rate limit is per client and resets at the window boundary', () => {
  let now = 0; const allowed = createRateLimiter(2, () => now);
  assert.ok(allowed('a')); assert.ok(allowed('a')); assert.ok(!allowed('a'));
  assert.ok(allowed('b')); now = 60000; assert.ok(allowed('a'));
});
test('private mode rejects cloud and oversized context before fetching', () => {
  process.env.PRIVATE_LLM = '1';
  try {
    assert.throws(() => applySettings({ provider: 'deepseek' }), { status: 400 });
    assert.throws(() => applySettings({ contextWindow: 8192 }), { status: 400 });
    assert.throws(() => applySettings({ maxTokens: 257 }), { status: 400 });
    const { Agent } = require('../agent');
    const agent = new Agent({ provider: 'local', model: 'qwen3:0.6b' });
    assert.equal(agent.settings.contextWindow, 4096);
    assert.equal(agent.responseTokenLimit(), 256);
    const { localOptions } = require('../local-model-config');
    assert.equal(localOptions(agent.settings, [{ content: 'Привет' }], 900).num_predict, 256);
    assert.throws(() => localOptions(agent.settings, [{ content: 'я'.repeat(4000) }]), { status: 413 });
  } finally { delete process.env.PRIVATE_LLM; }
});
test('two upstream streams overlap and a failed stream releases capacity', async () => {
  process.env.PRIVATE_LLM = '1';
  try {
    const { Agent } = require('../agent');
    let started = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    const settings = { provider: 'local', model: 'qwen3:0.6b' };
    const make = () => new Agent(settings, { fetchImpl: async () => {
      started++;
      return { ok: true, body: (async function* () {
        await barrier;
        yield Buffer.from(JSON.stringify({ message: { content: 'Ответ' } }) + '\n' + JSON.stringify({ done: true }));
      })() };
    } });
    const first = make(), second = make();
    const a = first.respond('Первый'), b = second.respond('Второй');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, 2, 'Both requests must reach upstream before either finishes');
    await assert.rejects(make().respond('Третий'), { status: 429 });
    release(); await Promise.all([a, b]);
    assert.equal(first.messages[0].content, 'Первый');
    assert.equal(second.messages[0].content, 'Второй');
    const broken = new Agent(settings, { fetchImpl: async () => { throw Error('offline'); } });
    await assert.rejects(broken.respond('Ошибка'), { status: 503 });
    await make().respond('Повтор');
  } finally { delete process.env.PRIVATE_LLM; }
});
