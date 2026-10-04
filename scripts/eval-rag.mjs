// Live retrieval/rewrite benchmark. --answers also generates independent LLM answers.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { searchBook, defaults, modes, filterCandidates, retrieve, rewriteQuery } from '../document-search.js';
import { compareRag } from '../rag-comparison.js';

const root = path.resolve(import.meta.dirname, '..');
try {
  for (const line of (await readFile(path.join(root, '.env'), 'utf8')).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const settings = { provider: process.env.EVAL_PROVIDER || 'deepseek', model: process.env.EVAL_MODEL || 'deepseek-flash' };
const strategy = process.env.EVAL_STRATEGY || 'structure';
const fixtures = JSON.parse(await readFile(path.join(root, 'indexing/rag-queries.json'), 'utf8'));
const codeHash = createHash('sha256').update(await readFile(path.join(root, 'document-search.js'))).update(await readFile(path.join(root, 'rag-comparison.js'))).update(JSON.stringify(fixtures)).digest('hex');
const indexHash = createHash('sha256').update(await readFile(path.join(root, `data/document-index/${strategy}.sqlite`))).digest('hex');
const resumePosition = process.argv.indexOf('--resume');
const resumed = resumePosition >= 0 ? JSON.parse(await readFile(process.argv[resumePosition + 1], 'utf8')) : null;
if (resumed && (resumed.codeHash !== codeHash || resumed.indexHash !== indexHash || resumed.strategy !== strategy || JSON.stringify(resumed.settings) !== JSON.stringify(settings) || resumed.options.candidateK !== defaults.candidateK || resumed.options.contextK !== defaults.contextK)) throw new Error('Код, индекс или параметры сохранённой калибровки отличаются от текущих.');
const directory = path.join(root, 'data/evals', `rag-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(directory, { recursive: true });
const cache = new Map();
const rewrites = new Map();
const dependencies = {
  settings,
  retrieve: async (query, index, top) => {
    const key = JSON.stringify([query, index, top]);
    if (!cache.has(key)) cache.set(key, await retrieve(query, index, top));
    return cache.get(key);
  },
  rewrite: async query => {
    if (!rewrites.has(query)) rewrites.set(query, rewriteQuery(query, settings));
    return rewrites.get(query);
  }
};
function measurements(result, item) {
  const relevant = hit => item.relevant_pages.some(page => hit.page_start <= page && page <= hit.page_end);
  const ranks = result.hits.map((hit, i) => relevant(hit) ? i + 1 : 0).filter(Boolean);
  return { answerable: item.relevant_pages.length > 0, hit: ranks.length > 0, mrr: ranks.length ? 1 / ranks[0] : 0,
    precision: result.hits.length ? ranks.length / result.hits.length : 0,
    empty: result.hits.length === 0, contextCount: result.hits.length,
    irrelevantContext: result.hits.filter(hit => !relevant(hit)).length };
}
function summarize(results) {
  const positive = results.filter(r => r.metrics.answerable);
  const negative = results.filter(r => !r.metrics.answerable);
  const mean = (rows, fn) => rows.length ? rows.reduce((sum, row) => sum + fn(row), 0) / rows.length : null;
  return { hitAtK: mean(positive, r => Number(r.metrics.hit)), mrr: mean(positive, r => r.metrics.mrr),
    pagePrecision: mean(positive, r => r.metrics.precision), emptyOnUnanswerable: mean(negative, r => Number(r.metrics.empty)),
    meanContext: mean(results, r => r.metrics.contextCount), irrelevantContextOnUnanswerable: mean(negative, r => r.metrics.irrelevantContext) };
}
const report = { createdAt: new Date().toISOString(), codeHash, indexHash, strategy, settings, options: { ...defaults },
  note: 'Малая выборка с приблизительной разметкой страниц. Test содержит другие формулировки знакомых тем, а не независимый корпус. Сходство не доказывает наличие ответа. Поиск/rewrite кешируются; времена с кешем не сравнивают скорость режимов. Корректность содержания ответов требует проверки человеком.', calibration: [], modes: {} };
try {
  const calibration = resumed?.calibrationCases || [];
  if (calibration.length) {
    report.resumedFrom = process.argv[resumePosition + 1];
    for (const value of calibration) rewrites.set(value.item.query, Promise.resolve({ query: value.rewritten.rewrite.query, tokenStats: value.rewritten.rewrite.tokenStats }));
    console.log(`Используем ${calibration.length} ранее полученных калибровочных примеров.`);
  }
  for (const [i, item] of (calibration.length ? [] : fixtures.calibration).entries()) {
    const original = await searchBook(item.query, strategy, { ...defaults, filter: false, rewrite: false }, dependencies);
    const rewritten = await searchBook(item.query, strategy, { ...defaults, filter: false, rewrite: true }, dependencies);
    if (rewritten.rewrite.status === 'failed') throw new Error(`Calibration rewrite failed: ${rewritten.rewrite.error}`);
    calibration.push({ item, original, rewritten });
    console.log(`Калибровка ${i + 1}/${fixtures.calibration.length}`);
  }
  for (let hundredths = 20; hundredths <= 85; hundredths++) {
    const threshold = hundredths / 100;
    const values = [];
    for (const group of calibration) for (const result of [group.original, group.rewritten]) {
      const filtered = filterCandidates(result.candidates, { ...defaults, filter: true, similarityThreshold: threshold });
      values.push({ metrics: measurements(filtered, group.item) });
    }
    const metrics = summarize(values);
    report.calibration.push({ threshold, ...metrics, balancedScore: (metrics.hitAtK + metrics.emptyOnUnanswerable) / 2 });
  }
  // Tie-break: preserve hit rate, then reduce irrelevant context, then use the smaller threshold.
  const best = [...report.calibration].sort((a, b) => b.balancedScore - a.balancedScore || b.hitAtK - a.hitAtK || b.pagePrecision - a.pagePrecision || a.threshold - b.threshold)[0];
  report.options.similarityThreshold = best.threshold;
  report.chosenThreshold = best;
  report.calibrationCases = calibration;
  console.log(`Выбран порог ${best.threshold}; контрольная выборка не участвует в подборе.`);
  const generateAnswers = process.argv.includes('--answers');
  for (const [mode, flags] of Object.entries(modes)) report.modes[mode] = { label: flags.label, cases: [] };
  for (const [i, item] of fixtures.test.entries()) {
    let answers;
    if (generateAnswers && i < 8) answers = await compareRag(item.query, strategy, report.options, settings, dependencies);
    for (const [mode, flags] of Object.entries(modes)) {
      const answer = answers?.results.find(value => value.mode === mode);
      const result = answer?.documentSearch || await searchBook(item.query, strategy, { ...report.options, filter: flags.filter, rewrite: flags.rewrite }, dependencies);
      if (flags.rewrite && result.rewrite.status === 'failed') throw new Error(`Test rewrite failed: ${result.rewrite.error}`);
      report.modes[mode].cases.push({ ...item, metrics: measurements(result, item), result,
        ...(answer && { answer: answer.answer, usedSources: result.usedSources, tokenStats: answer.tokenStats, answerMs: answer.answerMs }) });
    }
    console.log(`Контроль ${i + 1}/${fixtures.test.length}${answers ? ' + четыре ответа' : ''}`);
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  }
  for (const value of Object.values(report.modes)) value.summary = summarize(value.cases);
  if (process.argv.includes('--calibrate')) await writeFile(path.join(root, 'rag-config.json'), JSON.stringify(report.options, null, 2) + '\n');
  const lines = ['# Сравнение RAG', '', `Стратегия: ${strategy}; модель: ${settings.provider}/${settings.model}; Top-K ${defaults.candidateK} → ${defaults.contextK}; порог: ${best.threshold}.`, '', report.note, '',
    '| Режим | Hit@K (6 вопросов с ответом) | MRR | Точность по страницам | Пустой контекст (6 без ответа) | Среднее число фрагментов |', '| --- | ---: | ---: | ---: | ---: | ---: |'];
  for (const value of Object.values(report.modes)) {
    const m = value.summary;
    lines.push(`| ${value.label} | ${m.hitAtK.toFixed(3)} | ${m.mrr.toFixed(3)} | ${m.pagePrecision.toFixed(3)} | ${m.emptyOnUnanswerable.toFixed(3)} | ${m.meanContext.toFixed(2)} |`);
  }
  lines.push('', 'Пустой контекст — результат фильтра; отказ модели оценивается отдельно по тексту ответа. 32 ответа генерируются только с --answers на первых восьми вопросах.');
  for (const item of fixtures.test) {
    lines.push('', `## ${item.query}`, '');
    for (const value of Object.values(report.modes)) {
      const row = value.cases.find(row => row.query === item.query);
      lines.push(`### ${value.label}`, '', `Фрагментов: ${row.metrics.contextCount}; первый релевантный ранг: ${row.metrics.mrr ? Math.round(1 / row.metrics.mrr) : 'нет'}.`, '',
        `Rewrite: ${row.result.rewrite.query}`, '', row.answer || 'Ответ не генерировался.', '', `Использованные источники: ${JSON.stringify(row.usedSources || [])}.`, '');
    }
  }
  await writeFile(path.join(directory, 'comparison.md'), lines.join('\n'));
  console.log(JSON.stringify({ report: path.join(directory, 'comparison.md'), threshold: best.threshold, modes: Object.fromEntries(Object.entries(report.modes).map(([key, value]) => [key, value.summary])) }, null, 2));
} catch (error) {
  report.error = error.message;
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.error(`Сравнение не завершено: ${error.message}. Частичный отчёт: ${directory}`);
  process.exitCode = 1;
}
await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
