// Real Ollama embeddings, no LLM generation or API keys required.
const fs = require('node:fs');
const path = require('node:path');
const { buildProjectIndex, searchProject } = require('../project-help');
(async () => {
  const index = await buildProjectIndex();
  const cases = [
    ['Какие основные файлы проекта?', 'Основные файлы и каталоги'],
    ['Где хранится история?', 'Память и сохранение истории'],
    ['В каком месте сохраняются прошлые беседы?', 'Память и сохранение истории'],
    ['Какой формат запроса и ответа у API чата?', 'Запрос к чату']
  ];
  const results = [];
  for (const [question, section] of cases) {
    const hits = await searchProject(question, index, 3);
    results.push({ question, expectedSection: section, passed: hits.some(hit => hit.section.endsWith(section)), hits });
  }
  const reused = await buildProjectIndex();
  const report = { date: new Date().toISOString(), model: index.model, digest: index.digest, dimension: index.dimension,
    chunks: index.chunks.length, reusedWithoutEmbedding: reused.embeddedCount === 0,
    passed: results.every(result => result.passed) && reused.embeddedCount === 0, results };
  fs.writeFileSync(path.join(__dirname, '../data/project-retrieval-eval.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, dimension: report.dimension, chunks: report.chunks,
    reusedWithoutEmbedding: report.reusedWithoutEmbedding, results: results.map(({ question, passed }) => ({ question, passed })) }, null, 2));
  if (!report.passed) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
