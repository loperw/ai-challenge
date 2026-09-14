const test = require('node:test');
const assert = require('node:assert/strict');
const { Agent } = require('../agent');
const { extractBranchOptions } = require('../branch-options');
const answer = `Виды отпусков:
1. **Пляжный** — отдых у моря.
   - Купание
   - Загар
2. **Экскурсионный** — музеи и города.
3. **Активный** — походы и спорт.
4. **Оздоровительный** — санатории.`;

test('extracts four named options without turning nested details into branches', () => {
  const options = extractBranchOptions(answer);
  assert.deepEqual(options.map(option => option.name), ['Пляжный', 'Экскурсионный', 'Активный', 'Оздоровительный']);
  assert.ok(options[0].detail.includes('Купание'));
  assert.equal(extractBranchOptions('Обычный ответ без вариантов.').length, 0);
  assert.deepEqual(extractBranchOptions('## Пляжный\nМоре\n## Активный\nГоры').map(option => option.name), ['Пляжный', 'Активный']);
  assert.deepEqual(extractBranchOptions('- Море: тепло\n- Горы: прохладно').map(option => option.name), ['Море', 'Горы']);
});

test('four vacation branches keep their topic and independent conversations across restart', async () => {
  const settings = { provider: 'deepseek', model: 'deepseek-flash', contextStrategy: 'branching' };
  const messages = [{ role: 'user', content: 'Виды отпусков' }, { role: 'assistant', content: answer }];
  let saved;
  const persist = (settings, messages, tokenStats, context) => { saved = structuredClone({ settings, messages, tokenStats, context }); };
  let agent = new Agent(settings, { messages, persist });
  agent.branchAction('options');
  const entries = Object.entries(agent.context.branches).filter(([id]) => id !== 'main');
  assert.equal(entries.length, 4);
  agent.branchAction('options');
  assert.equal(Object.keys(agent.context.branches).length, 5);
  const checkpoint = structuredClone(agent.context.checkpoints);
  const [beach, sightseeing] = entries.map(([id]) => id);
  const requests = [];
  const mock = () => {
    agent.createCompletion = async function () { requests.push({ prompt: this.systemPrompt(), messages: structuredClone(this.contextMessages()) }); return {}; };
    agent.readCompletion = async function* () { yield 'Ответ на вопрос выбранной ветки'; };
  };
  mock();
  agent.branchAction('switch', beach);
  await agent.respond('Сколько стоит отель у моря?');
  assert.ok(requests.at(-1).prompt.includes('Пляжный'));
  assert.equal(agent.context.branches[beach].name, 'Пляжный');
  const beachMessages = structuredClone(agent.messages);
  agent.branchAction('switch', sightseeing);
  assert.deepEqual(agent.messages, messages);
  await agent.respond('Какие музеи посетить?');
  assert.ok(requests.at(-1).prompt.includes('Экскурсионный'));
  assert.ok(!JSON.stringify(requests.at(-1).messages).includes('Сколько стоит отель'));
  assert.deepEqual(agent.context.checkpoints, checkpoint);
  agent = new Agent(saved.settings, { ...saved, persist }); mock();
  assert.equal(agent.context.activeBranch, sightseeing);
  assert.equal(agent.messages.at(-2).content, 'Какие музеи посетить?');
  agent.branchAction('switch', beach);
  assert.deepEqual(agent.messages, beachMessages);
  agent.branchAction('switch', 'main');
  assert.deepEqual(agent.messages, messages);
});

test('section titles take priority over their unindented descriptive bullets', () => {
  const answer = `### 1. Пассивный отдых (Восстановление)
Описание отдыха.
* **Суть:** Расслабление.
* **Цель:** Снять усталость.
* **Примеры:** Сон.
* **Кому подходит:** Уставшим.
### 2. Активный отдых (Переключение)
Описание отдыха.
* **Суть:** Движение.
* **Цель:** Переключение.
* **Примеры:** Поход.
* **Кому подходит:** Всем.`;
  const options = extractBranchOptions(answer);
  assert.deepEqual(options.map(option => option.name), ['Пассивный отдых (Восстановление)', 'Активный отдых (Переключение)']);
  assert.ok(options[0].detail.includes('Снять усталость'));
  assert.ok(!options[0].detail.includes('Движение'));
  const agent = new Agent({ provider: 'deepseek', model: 'deepseek-flash', contextStrategy: 'branching' }, {
    messages: [{ role: 'user', content: 'Виды отдыха' }, { role: 'assistant', content: answer }]
  });
  agent.branchAction('options');
  const checkpoint = Object.values(agent.context.checkpoints)[0];
  const oldId = checkpoint.optionBranches[0];
  agent.context.branches[oldId].name = 'Суть';
  agent.branchAction('options');
  assert.equal(Object.keys(agent.context.branches).length, 3);
  assert.equal(Object.keys(agent.context.checkpoints).length, 1);
  assert.deepEqual(Object.values(agent.context.branches).filter(b => b.topic).map(b => b.name), options.map(o => o.name));
  agent.branchAction('options');
  assert.equal(Object.keys(agent.context.branches).length, 3);
});
