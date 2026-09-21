const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Agent, AgentError, enforceStateTransitionInvariants } = require('../agent');
const { SQLiteStore } = require('../sqlite-store');

const settings = { provider: 'deepseek', model: 'deepseek-flash', temperature: 1 };

test('invariants are persisted separately from dialogue and settings', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-invariants-'));
  const file = join(directory, 'invariants.sqlite');
  const stores = [];
  t.after(() => { stores.forEach(store => store.close()); rmSync(directory, { recursive: true, force: true }); });

  let store = new SQLiteStore(file);
  stores.push(store);
  store.save('chat', settings, [{ role: 'user', content: 'Привет' }]);
  store.addInvariant('chat', 'conversation', 'Использовать только PostgreSQL');
  store.addInvariant('chat', 'stateMachine', 'Не переходить без согласия');
  store.addInvariant('chat', 'global', 'Не транслитерировать английские термины');

  assert.deepEqual(store.chats.chat.messages, [{ role: 'user', content: 'Привет' }]);
  assert.equal(store.chats.chat.settings.invariants, undefined);
  assert.deepEqual(store.getInvariants('chat'), ['Не транслитерировать английские термины', 'Использовать только PostgreSQL']);
  assert.deepEqual(store.getInvariants('another-chat'), ['Не транслитерировать английские термины']);
  assert.deepEqual(store.getStateMachineInvariants('chat'), ['Не переходить без согласия']);
  assert.deepEqual(store.listInvariants('chat').map(item => item.scope), ['global', 'conversation', 'stateMachine']);

  store = new SQLiteStore(file);
  stores.push(store);
  assert.deepEqual(store.getInvariants('chat'), ['Не транслитерировать английские термины', 'Использовать только PostgreSQL']);
});

test('legacy per-dialogue invariants migrate to scoped list records', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-invariants-migration-'));
  const file = join(directory, 'invariants.sqlite');
  let store;
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  const database = new DatabaseSync(file);
  database.exec(`CREATE TABLE invariants (
    owner_id TEXT NOT NULL, position INTEGER NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (owner_id, position)
  ); CREATE INDEX invariants_owner_position ON invariants(owner_id, position);`);
  database.prepare('INSERT INTO invariants VALUES (?, ?, ?, ?, ?)').run('chat', 0, 'Старое правило', 1, 1);
  database.close();

  store = new SQLiteStore(file);
  assert.deepEqual(store.listInvariants('chat').map(item => ({ scope: item.scope, content: item.content })), [
    { scope: 'conversation', content: 'Старое правило' }
  ]);
});

test('state machine invariant blocks a transition and explains the reason', async () => {
  const checks = [];
  const agent = new Agent(settings, {
    evaluateInvariantRequest: async input => {
      checks.push(JSON.parse(input.userRequest));
      return input.userRequest.includes('"userConsent":false')
        ? { conflict: true, violations: [{ index: 0, reason: 'Нет явного согласия пользователя.' }] }
        : { conflict: false, violations: [] };
    }
  });
  const current = { name: 'Релиз', description: 'Выпустить продукт', stage: 'planning', currentStep: 0, paused: false };
  const next = { ...current, stage: 'execution' };

  await assert.rejects(
    enforceStateTransitionInvariants(agent, ['Не переходить к выполнению без согласия пользователя'], {
      current, next, event: 'APPROVE_PLAN', userConsent: false
    }),
    error => error instanceof AgentError && error.status === 409
      && /Переход состояния заблокирован/.test(error.message)
      && /Нет явного согласия/.test(error.message)
  );
  await assert.doesNotReject(enforceStateTransitionInvariants(agent, ['Не переходить к выполнению без согласия пользователя'], {
    current, next, event: 'APPROVE_PLAN', userConsent: true
  }));
  assert.deepEqual(checks.map(item => item.userConsent), [false, true]);
});

test('agent includes immutable invariants in its system instructions', () => {
  const agent = new Agent(settings, { getInvariants: () => ['Использовать только PostgreSQL'] });
  const prompt = agent.systemPrompt();
  assert.match(prompt, /НЕПРИКОСНОВЕННЫЕ ИНВАРИАНТЫ/);
  assert.match(prompt, /Использовать только PostgreSQL/);
  assert.match(prompt, /Инварианты имеют приоритет/);
  assert.match(prompt, /внутренне и молча/);
  assert.match(prompt, /не добавляй заголовок «ПРОВЕРКА ИНВАРИАНТОВ»/);
  assert.match(prompt, /только в отдельном интерфейсе инвариантов/);
  assert.match(prompt, /никогда не накладывают требования на форму или содержание сообщения пользователя/);
  assert.match(prompt, /ответы только 2 предложениями/);
});

test('conflicting request is refused with the violated invariant and skips solution generation', async () => {
  let completionCalled = false;
  const streamed = [];
  const agent = new Agent(settings, {
    getInvariants: () => ['Использовать только PostgreSQL'],
    evaluateInvariantRequest: async () => ({
      conflict: true,
      violations: [{ index: 0, reason: 'Запрос требует заменить PostgreSQL на MongoDB.' }]
    })
  });
  agent.createCompletion = async () => { completionCalled = true; return {}; };

  const answer = await agent.respond('Замени PostgreSQL на MongoDB', { onToken: token => streamed.push(token) });

  assert.equal(completionCalled, false);
  assert.equal(streamed.join(''), answer);
  assert.match(answer, /Не могу выполнить этот запрос/);
  assert.match(answer, /Использовать только PostgreSQL/);
  assert.match(answer, /заменить PostgreSQL на MongoDB/);
  assert.equal(agent.messages.at(-1).invariantRefusal, true);
  assert.equal(agent.context.lastInvariantCheck.status, 'conflict');
  assert.equal(agent.tokenStats.finishReason, 'invariant_conflict');
});

test('candidate response is checked before it becomes visible and unsafe output is replaced', async () => {
  const checks = [];
  const streamed = [];
  const agent = new Agent(settings, {
    getInvariants: () => ['Не использовать внешние облачные сервисы'],
    evaluateInvariantRequest: async input => {
      checks.push(input);
      return input.candidateResponse
        ? { conflict: true, violations: [{ index: 0, reason: 'Ответ предлагает внешний облачный сервис.' }] }
        : { conflict: false, violations: [] };
    },
    repairInvariantResponse: async () => 'Разместите данные во внешнем облаке.'
  });
  agent.createCompletion = async () => ({});
  agent.readCompletion = async function* () { yield 'Разместите данные во внешнем облаке.'; };

  const answer = await agent.respond('Предложи вариант хранения', { onToken: token => streamed.push(token) });

  assert.equal(checks.length, 3);
  assert.equal(streamed.length, 1);
  assert.doesNotMatch(streamed[0], /Разместите данные/);
  assert.match(answer, /Не использовать внешние облачные сервисы/);
  assert.equal(agent.context.lastInvariantCheck.phase, 'response-repair');
  assert.equal(agent.messages.at(-1).invariantRefusal, true);
  assert.equal(agent.tokenStats.finishReason, 'invariant_conflict');
});

test('response-only invariant does not constrain the user message and repairs the assistant draft', async () => {
  const checks = [];
  const agent = new Agent(settings, {
    getInvariants: () => ['Ответы только 2 предложениями'],
    evaluateInvariantRequest: async input => {
      checks.push(input);
      if (!input.candidateResponse) return { conflict: false, violations: [] };
      const sentenceCount = (input.candidateResponse.match(/[.!?](?:\s|$)/g) || []).length;
      return sentenceCount === 2
        ? { conflict: false, violations: [] }
        : { conflict: true, violations: [{ index: 0, reason: 'В ответе не два предложения.' }] };
    },
    repairInvariantResponse: async () => 'Первое предложение. Второе предложение.'
  });
  agent.createCompletion = async () => ({});
  agent.readCompletion = async function* () { yield 'Черновик состоит из одного предложения.'; };

  const answer = await agent.respond('Объясни подробно, пожалуйста. Это моё второе предложение. И третье.');

  assert.equal(answer, 'Первое предложение. Второе предложение.');
  assert.equal(checks.length, 3);
  assert.equal(checks[0].candidateResponse, '');
  assert.equal(agent.context.lastInvariantCheck.status, 'passed');
  assert.equal(agent.context.lastInvariantCheck.phase, 'response-repair');
  assert.equal(agent.messages.at(-1).invariantRefusal, undefined);
  assert.equal(agent.tokenStats.finishReason, 'invariant_repaired');
});

test('compatible request passes both invariant checks and returns the generated answer', async () => {
  let checks = 0;
  const agent = new Agent(settings, {
    getInvariants: () => ['Использовать только PostgreSQL'],
    evaluateInvariantRequest: async () => { checks += 1; return { conflict: false, violations: [] }; }
  });
  agent.createCompletion = async () => ({});
  agent.readCompletion = async function* () { yield 'ПРОВЕРКА ИНВАРИАНТОВ:\n1. PostgreSQL — соблюдается.\nКонфликтов нет.\n\nДобавьте индекс PostgreSQL.'; };

  assert.equal(await agent.respond('Как ускорить запрос?'), 'Добавьте индекс PostgreSQL.');
  assert.equal(checks, 2);
  assert.equal(agent.context.lastInvariantCheck.status, 'passed');
});
