const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { MemoryStore } = require('../memory-store');
const { Agent } = require('../agent');
const { SQLiteStore } = require('../sqlite-store');
const { createTask } = require('../task-state');

test('imports legacy JSON into SQLite once', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-migration-'));
  const conversationsFile = join(directory, 'conversations.json');
  const memoryFile = join(directory, 'memory.json');
  const databaseFile = join(directory, 'agent-memory.sqlite');
  writeFileSync(conversationsFile, JSON.stringify({ chat: {
    id: 'chat', settings: { provider: 'deepseek', model: 'deepseek-flash' },
    messages: [{ role: 'user', content: 'Вопрос' }], tokenStats: null, context: {}, updatedAt: 10
  } }));
  writeFileSync(memoryFile, JSON.stringify({
    shortTermByConversation: { chat: [{ role: 'user', content: 'Полная история' }] },
    workingByConversation: { chat: [{ id: 'work', content: 'Срок — пятница', createdAt: 11 }] },
    longTerm: [{ id: 'long', content: 'Отвечать по-русски', createdAt: 12 }]
  }));
  const store = new SQLiteStore(databaseFile, { legacyConversationsPath: conversationsFile, legacyMemoryPath: memoryFile });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.list().length, 1);
  assert.deepEqual(store.view('chat').shortTerm.map(item => item.content), ['Полная история']);
  assert.deepEqual(store.view('chat').working.map(item => item.content), ['Срок — пятница']);
  assert.deepEqual(store.view('other').longTerm.map(item => item.content), ['Отвечать по-русски']);
  store.migrateLegacy(conversationsFile, memoryFile);
  assert.equal(store.view('chat').shortTerm.length, 1);
});

test('working and long-term memory are stored separately', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-memory-'));
  const file = join(directory, 'memory.sqlite');
  const stores = [];
  t.after(() => { stores.forEach(item => item.close()); rmSync(directory, { recursive: true, force: true }); });
  let store = new MemoryStore(file);
  stores.push(store);
  store.add('chat-a', 'working', 'Срок — пятница');
  store.add('chat-a', 'longTerm', 'Предпочитает краткие ответы');
  store.add('chat-b', 'working', 'Другая задача');
  store.addShortTerm('chat-a', [{ role: 'user', content: 'Первый вопрос' }, { role: 'assistant', content: 'Первый ответ' }]);

  assert.equal(store.view('chat-a').shortTerm.length, 2);
  assert.deepEqual(store.view('chat-a').working.map(item => item.content), ['Срок — пятница']);
  assert.deepEqual(store.view('chat-b').working.map(item => item.content), ['Другая задача']);
  assert.deepEqual(store.view('chat-b').longTerm.map(item => item.content), ['Предпочитает краткие ответы']);

  store = new MemoryStore(file);
  stores.push(store);
  assert.equal(store.view('chat-a').working.length, 1);
  assert.equal(store.view('chat-a').shortTerm.length, 2);
  assert.equal(store.view('chat-a').longTerm.length, 1);
  store.removeConversation('chat-a');
  assert.equal(store.view('chat-a').working.length, 0);
  assert.equal(store.view('chat-a').shortTerm.length, 0);
  assert.equal(store.view('chat-b').longTerm.length, 1);
});

test('user profiles are separate persisted entities', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-profiles-'));
  const file = join(directory, 'profiles.sqlite');
  const stores = [];
  t.after(() => { stores.forEach(item => item.close()); rmSync(directory, { recursive: true, force: true }); });
  let store = new SQLiteStore(file);
  stores.push(store);
  const created = store.createProfile({
    name: 'Рабочий', occupation: 'Дизайнер', language: 'Русский',
    responseFormat: 'Краткие списки', constraints: 'Без эмодзи'
  });
  assert.equal(store.getProfile(created.id).occupation, 'Дизайнер');
  store.updateProfile(created.id, { ...created, name: 'Основной', responseFormat: 'Сначала вывод' });

  store = new SQLiteStore(file);
  stores.push(store);
  assert.deepEqual(store.listProfiles().map(profile => profile.name), ['Основной']);
  assert.equal(store.getProfile(created.id).responseFormat, 'Сначала вывод');
  store.clear();
  assert.equal(store.listProfiles().length, 1);
  store.save('profile-chat', { provider: 'deepseek', model: 'deepseek-flash', profileId: created.id }, []);
  assert.equal(store.deleteProfile(created.id), true);
  assert.equal(store.getProfile(created.id), null);
  assert.equal(store.chats['profile-chat'].settings.profileId, '');
  assert.equal(store.deleteProfile(created.id), false);
});

test('memory commands are displayed but excluded from LLM messages', async () => {
  const requests = [];
  const agent = new Agent({ provider: 'deepseek', model: 'deepseek-flash' }, {
    getMemory: () => ({
      working: [{ content: 'Цель — релиз' }],
      longTerm: [{ content: 'Пользователь пишет по-русски' }]
    })
  });
  agent.recordMemoryCommand('working', 'Цель — релиз');
  agent.createCompletion = async function () {
    requests.push({ prompt: this.systemPrompt(), messages: structuredClone(this.contextMessages()) });
    return {};
  };
  agent.readCompletion = async function* () { yield 'Готово'; };
  await agent.respond('Продолжай');

  assert.equal(agent.messages[0].memoryCommand, true);
  assert.deepEqual(requests[0].messages, [{ role: 'user', content: 'Продолжай' }]);
  assert.match(requests[0].prompt, /Цель — релиз/);
  assert.match(requests[0].prompt, /Пользователь пишет по-русски/);
  assert.ok(requests[0].prompt.indexOf('Долговременная память') < requests[0].prompt.indexOf('ОБЯЗАТЕЛЬНАЯ РАБОЧАЯ'));
  assert.match(requests[0].prompt, /безусловно заменяют конфликтующие сведения/);
  assert.match(requests[0].prompt, /Не считай рабочую запись ошибочной/);
});

test('selected profile is added to every agent system prompt', () => {
  const profile = {
    id: 'profile-1', name: 'Рабочий', occupation: 'Аналитик', language: 'Русский',
    responseFormat: 'Сначала вывод, затем пункты', constraints: 'Без эмодзи'
  };
  const agent = new Agent({ provider: 'deepseek', model: 'deepseek-flash', profileId: profile.id }, {
    getProfile: id => id === profile.id ? profile : null
  });
  const prompt = agent.systemPrompt();
  assert.match(prompt, /ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ/);
  assert.match(prompt, /Род деятельности: Аналитик/);
  assert.match(prompt, /Язык диалога: Русский/);
  assert.match(prompt, /Сначала вывод, затем пункты/);
  assert.match(prompt, /Ограничения: Без эмодзи/);
});

test('each task keeps its own long-term memory and profile', t => {
  const directory = mkdtempSync(join(tmpdir(), 'task-memory-'));
  const file = join(directory, 'tasks.sqlite');
  const store = new SQLiteStore(file);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const profileA = store.createProfile({ name: 'A', occupation: '', language: '', responseFormat: '', constraints: '' });
  const profileB = store.createProfile({ name: 'B', occupation: '', language: '', responseFormat: '', constraints: '' });
  const taskA = store.saveTask(createTask({ name: 'Первая', description: 'Цель A', profileId: profileA.id }));
  const taskB = store.saveTask(createTask({ name: 'Вторая', description: 'Цель B', profileId: profileB.id }));
  store.save(taskA.id, { provider: 'deepseek', model: 'deepseek-flash' }, [{ role: 'user', content: 'Цель A' }]);
  store.save('ordinary-chat', { provider: 'deepseek', model: 'deepseek-flash' }, [{ role: 'user', content: 'Обычный чат' }]);
  store.add(taskA.id, 'longTerm', 'Память A');
  store.add(taskB.id, 'longTerm', 'Память B');
  assert.deepEqual(store.view(taskA.id).longTerm.map(item => item.content), ['Память A']);
  assert.deepEqual(store.view(taskB.id).longTerm.map(item => item.content), ['Память B']);
  assert.equal(store.getTask(taskA.id).profileId, profileA.id);
  assert.equal(store.getTask(taskB.id).profileId, profileB.id);
  assert.deepEqual(store.listChats().map(chat => chat.id), ['ordinary-chat']);
});

test('task action label is visible while hidden instruction alone reaches agent context', async () => {
  const recorded = [];
  let sentContext;
  const agent = new Agent({ provider: 'deepseek', model: 'deepseek-flash' }, {
    recordShortTerm: messages => recorded.push(...messages)
  });
  agent.createCompletion = async function () { sentContext = structuredClone(this.contextMessages()); return {}; };
  agent.readCompletion = async function* () { yield 'Что будет происходить и план'; };
  await agent.respond('Внутренняя команда планирования', { hiddenUserMessage: true, displayUserMessage: 'Сформировать план' });
  assert.equal(agent.messages[0].actionMessage, true);
  assert.equal(agent.messages[1].hidden, true);
  assert.deepEqual(sentContext, [{ role: 'user', content: 'Внутренняя команда планирования', hidden: true }]);
  assert.deepEqual(recorded, [
    { role: 'user', content: 'Сформировать план', actionMessage: true },
    { role: 'assistant', content: 'Что будет происходить и план' }
  ]);
});
