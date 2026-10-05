// Live, sequential dialogues: actual extraction, retrieval, answers and SQLite restart.
const fs = require('node:fs');
const path = require('node:path');
const { AgentRegistry } = require('../agent');
const { SQLiteStore } = require('../sqlite-store');
const { extractTaskMemory } = require('../task-memory');
const { searchBook } = require('../document-search');
const root = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}
const scenarios = [
  { id: 'data-classes', goal: /data class|класс.*данн/i, messages: [
    'Моя цель — подготовить памятку по data class в Kotlin. Отвечай по книге, кратко, по-русски, с источниками. Для чего нужны data class?',
    'Уточняю: памятка для начинающего. Какие методы автоматически создаёт data class?',
    'Под DTO в этой беседе я понимаю data class для хранения данных. Для чего нужен copy у DTO?',
    'Ограничение: примеры только на Kotlin, без Java. Как работает copy у data class?',
    'Не включай в памятку сравнение производительности. Как equals работает у data class?',
    'Небольшое отступление: как устроена null safety в Kotlin?',
    'Вернёмся к основной памятке. Какие свойства data class участвуют в equals?',
    'Считай, что читатель уже знает обычные классы. Какие ограничения есть у data class?',
    'А какие методы у нашего DTO генерируются автоматически?',
    'Как работает деструктуризация data class?',
    'Напомни применительно к памятке, чем полезен copy у DTO?',
    'Собери итоговую краткую памятку по data class для выбранного читателя, с учётом всех моих условий и с источниками.'
  ] },
  { id: 'coroutines', goal: /корутин|сопрограмм/i, messages: [
    'Цель диалога — подготовить памятку по обработке ошибок в корутинах Kotlin. Отвечай по книге, по-русски, с источниками. Что происходит с дочерними корутинами при исключении?',
    'Уточняю: памятка для разработчика, который уже знает suspend. Что такое coroutineScope?',
    'Ограничение: ответ максимум в двух предложениях. Как распространяются исключения в coroutineScope?',
    'Под группой здесь понимаем coroutineScope. Что будет с соседними корутинами при ошибке в группе?',
    'Примеры пока не нужны. Как работает supervisorScope?',
    'Исправляю ограничение длины: теперь максимум четыре предложения вместо двух. Как supervisorScope изолирует ошибки?',
    'Меняю термин: теперь под группой подразумеваем supervisorScope, а не coroutineScope. Что будет с соседями при ошибке в группе?',
    'Отвлечёмся на suspend: блокирует ли приостановка поток?',
    'Возвращаемся к памятке про ошибки. Разрешаю короткий пример на Kotlin. Как применить supervisorScope?',
    'А что с ошибкой одного ребёнка в нашей группе?',
    'Сравни распространение ошибок у coroutineScope и supervisorScope для нашей памятки.',
    'Подведи итог памятки по ошибкам корутин с учётом актуального значения группы и ограничения длины. Приведи источники.'
  ] }
];
const resumeIndex = process.argv.indexOf('--resume');
const directory = resumeIndex >= 0 ? path.resolve(process.argv[resumeIndex + 1]) : path.join(root, 'data', 'evals', 'task-memory-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(directory, { recursive: true });
const reportFile = path.join(directory, 'report.json');
const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : { settings: { provider: 'deepseek', model: 'deepseek-flash', keepMessages: 4 }, scenarios: [], startedAt: new Date().toISOString() };
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
const normalized = text => text.replace(/\s+/g, ' ').trim();
let store;
(async () => {
  console.log('Report: ' + reportFile);
  for (const scenario of scenarios) {
    let result = report.scenarios.find(item => item.id === scenario.id);
    if (!result) { result = { id: scenario.id, turns: [] }; report.scenarios.push(result); }
    store = new SQLiteStore(path.join(directory, scenario.id + '.sqlite'));
    let registry = new AgentRegistry({ store, extractTaskMemory, fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(120000) }) });
    for (let index = result.turns.length; index < scenario.messages.length; index++) {
      if (index === 7) { store.close(); store = new SQLiteStore(path.join(directory, scenario.id + '.sqlite')); registry = new AgentRegistry({ store, extractTaskMemory }); }
      const agent = registry.get(scenario.id, report.settings);
      console.log(`${scenario.id} ${index + 1}/12: start`);
      const answer = await agent.respond(scenario.messages[index], { toolsEnabled: false, ragMode: 'rag',
        retrieveDocuments: (query, taskMemory) => searchBook(query, 'structure', {}, { settings: report.settings, taskMemory }) });
      const search = agent.messages.at(-1).documentSearch;
      const eligible = require('../rag-answer').eligibleSources(search);
      const sourcesValid = search.usedSources.length > 0 && search.usedSources.every(number => eligible.includes(number));
      const quotesExact = search.quotes.length > 0 && search.quotes.every(quote => search.usedSources.includes(quote.source) && normalized(search.hits[quote.source - 1]?.text || '').includes(normalized(quote.text)));
      result.turns.push({ turn: index + 1, question: scenario.messages[index], answer, memory: agent.context.taskMemory,
        goalRetained: scenario.goal.test(agent.context.taskMemory.goal), sourcesValid, quotesExact,
        status: search.answerStatus, sources: search.usedSources, quotes: search.quotes,
        rewrite: search.rewrite, hits: search.hits.map(({ chunk_id, page_start, page_end, text, score }) => ({ chunk_id, page_start, page_end, text, score })) });
      save(); console.log(`${scenario.id} ${index + 1}/12: ${search.answerStatus}, goal=${result.turns.at(-1).goalRetained}, sources=${sourcesValid}, quotes=${quotesExact}`);
    }
    store.close(); store = null;
  }
  report.completedAt = new Date().toISOString(); save();
})().catch(error => { report.error = error.message; save(); console.error(error.message); process.exitCode = 1; }).finally(() => store?.close());
