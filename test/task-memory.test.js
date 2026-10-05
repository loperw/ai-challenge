const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Agent, AgentRegistry } = require('../agent');
const { SQLiteStore } = require('../sqlite-store');
const { EMPTY, normalizeTaskMemory, extractTaskMemory } = require('../task-memory');
const { rewriteQuery } = require('../document-search');
const settings = { provider: 'deepseek', model: 'deepseek-flash', keepMessages: 2 };
process.env.DEEPSEEK_API_KEY = 'test';
const stream = value => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) } }] }) + '\n\ndata: [DONE]\n\n');

test('extractor uses only explicit user decisions and validates structured output', async () => {
  const result = await extractTaskMemory({ settings, previous: EMPTY, userMessage: 'Цель: изучить Kotlin', fetchImpl: async (_, init) => {
    const request = JSON.parse(init.body);
    assert.match(request.messages[0].content, /Предложения ассистента не являются решениями/);
    assert.equal(JSON.parse(request.messages.at(-1).content).userMessage, 'Цель: изучить Kotlin');
    return stream({ ...EMPTY, goal: 'Изучить Kotlin' });
  } });
  assert.equal(result.memory.goal, 'Изучить Kotlin');
  for (const value of [null, [], {}, { ...EMPTY, constraints: [42] }, { ...EMPTY, goal: 'x'.repeat(2001) }]) assert.throws(() => normalizeTaskMemory(value));
});

for (const scenario of ['clarifications', 'corrections']) test(`12 turns retain memory, retrieval context, sources and restart: ${scenario}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'task-memory-'));
  const file = join(dir, 'state.sqlite');
  let store = new SQLiteStore(file);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let turn = 0;
  const dependencies = {
    extractTaskMemory: async ({ previous }) => ({ memory: { ...previous, goal: previous.goal || 'Изучить Kotlin',
      constraints: [scenario === 'corrections' && turn >= 6 ? 'Три предложения' : 'Два предложения'], terms: ['DTO — класс данных'],
      clarifications: ['Только по книге'] } }),
    fetchImpl: async (_, init) => {
      const request = JSON.parse(init.body);
      assert.match(request.messages[0].content, /Изучить Kotlin/);
      assert.match(request.messages[0].content, /DTO — класс данных/);
      if (scenario === 'corrections' && turn >= 6) { assert.match(request.messages[0].content, /Три предложения/); assert.doesNotMatch(request.messages[0].content, /Два предложения/); }
      return stream({ status: 'answered', answer: 'Классы данных хранят данные [1].', sources: [1], quotes: [{ source: 1, text: 'Data classes store data.' }] });
    }
  };
  let registry = new AgentRegistry({ ...dependencies, store });
  let agent = registry.get('dialogue', settings);
  for (turn = 0; turn < 12; turn++) {
    if (turn === 7) { store.close(); store = new SQLiteStore(file); registry = new AgentRegistry({ ...dependencies, store }); agent = registry.get('dialogue', settings); }
    await agent.respond(turn === 0 ? 'Изучить Kotlin' : 'А для этого случая?', {
      retrieveDocuments: async (query, memory) => {
        assert.equal(memory.goal, 'Изучить Kotlin');
        return { strategy: 'structure', options: { similarityThreshold: .76 }, hits: [{ text: 'Data classes store data.', score: .9, page_start: 34, page_end: 35, chunk_id: 'data', file: 'book.pdf' }] };
      }
    });
    assert.equal(agent.messages.length, 2);
    assert.deepEqual(agent.messages.at(-1).documentSearch.usedSources, [1]);
    assert.equal(agent.context.taskMemory.goal, 'Изучить Kotlin');
  }
  const isolated = registry.get('other', settings);
  assert.equal(isolated.context.taskMemory, undefined);
});

test('failure rolls memory back; manual edit rejects busy, stale and invalid writes; hidden actions do not extract', async () => {
  let fail = false, extracts = 0;
  const agent = new Agent(settings, { extractTaskMemory: async () => { extracts++; return { memory: { ...EMPTY, goal: 'New goal' } }; }, fetchImpl: async () => { if (fail) throw new Error('offline'); return stream({ answer: 'ok' }); } });
  agent.editTaskMemory({ ...EMPTY, goal: 'Manual goal' }, 0);
  assert.throws(() => agent.editTaskMemory(EMPTY, 0), /изменилась/);
  agent.busy = true; assert.throws(() => agent.editTaskMemory(EMPTY, 1), /Дождитесь/); agent.busy = false;
  fail = true;
  await assert.rejects(agent.respond('change'), /offline/);
  assert.equal(agent.context.taskMemory.goal, 'Manual goal');
  fail = false;
  await agent.respond('PLAN_READY', { hiddenUserMessage: true });
  assert.equal(extracts, 1);
  assert.equal(agent.context.taskMemory.goal, 'Manual goal');
  agent.editTaskMemory(EMPTY, 1);
  assert.deepEqual(agent.context.taskMemory, EMPTY);
});

test('dialogue branches retain independent memory', async () => {
  const agent = new Agent({ ...settings, contextStrategy: 'branching' }, { fetchImpl: async () => stream('ok') });
  agent.editTaskMemory({ ...EMPTY, goal: 'Original' }, 0);
  await agent.respond('hello'); agent.branchAction('checkpoint');
  const checkpoint = Object.keys(agent.context.checkpoints)[0];
  agent.branchAction('fork', checkpoint);
  agent.editTaskMemory({ ...EMPTY, goal: 'Fork' }, agent.context.taskMemoryVersion);
  agent.branchAction('switch', 'main');
  assert.equal(agent.context.taskMemory.goal, 'Original');
});

test('query rewrite receives memory for resolving follow-ups', async () => {
  await rewriteQuery('А это?', settings, async (_, init) => {
    const input = JSON.parse(JSON.parse(init.body).messages.at(-1).content);
    assert.equal(input.taskMemory.goal, 'Kotlin data class');
    assert.equal(input.question, 'А это?');
    return stream({ query: 'Kotlin data class' });
  }, { ...EMPTY, goal: 'Kotlin data class' });
});
