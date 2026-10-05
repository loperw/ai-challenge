const fs = require('node:fs');
const path = require('node:path');
const { searchBook, documentPrompt } = require('../document-search');
const { Agent } = require('../agent');
const root = path.join(__dirname, '..');
const cases = ['что называется классами данных?', 'Для чего нужны data class в Kotlin?', 'Как работает supervisorScope?', 'Какая масса Юпитера?', 'Для чего они нужны?'];
const report = { cases: [] };
(async () => {
  for (const strategy of ['fixed', 'structure']) for (const query of cases) {
    const result = await searchBook(query, strategy, { rewrite: false });
    const row = { strategy, query, definitionInContext: documentPrompt(result).includes('Это простые представления структурированных данных'),
      headings: result.hits.filter(hit => hit.headingMatch).map(hit => hit.headingMatch), pages: result.hits.map(hit => hit.page_start), result };
    report.cases.push(row);
    console.log(JSON.stringify({ strategy, query, definitionInContext: row.definitionInContext, headings: row.headings, pages: row.pages }));
  }
  if (process.argv.includes('--answer')) {
    for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
    const agent = new Agent({ provider: 'deepseek', model: 'deepseek-flash', temperature: 0 });
    const result = report.cases.find(row => row.strategy === 'structure' && row.query === cases[0]).result;
    report.answer = await agent.respond(cases[0], { documentSearch: result, toolsEnabled: false });
    report.sources = agent.messages.at(-1).documentSearch.usedSources;
    console.log(JSON.stringify({ answer: report.answer, sources: report.sources }));
  }
  fs.mkdirSync(path.join(root, 'data', 'evals'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'evals', 'heading-search.json'), JSON.stringify(report, null, 2));
  if (report.cases.some(row => cases.slice(0, 2).includes(row.query) && !row.definitionInContext)) throw new Error('Definition missing');
  if (report.cases.some(row => cases.slice(3).includes(row.query) && row.headings.length)) throw new Error('False title match');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
