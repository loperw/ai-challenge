const fs = require('node:fs');
const path = require('node:path');
const model = 'qwen3.5:2b-q4_K_M';
const cases = [
  ['sum', 'Сколько будет 17 + 25? Ответь кратко по-русски.', 42],
  ['subtract', 'Вычисли 1000 - 487. Ответь только числом.', 513],
  ['multiply', 'Вычисли 18 × 13. Ответь только числом.', 234],
  ['discount', 'Товар стоит 2400 рублей. Скидка 15%, затем к цене добавляется доставка 300 рублей. Сколько рублей к оплате? Ответь только числом.', 2340],
  ['precedence', 'Вычисли 12 + 6 × 7 - 8. Ответь только числом.', 46],
  ['rate', 'Пять одинаковых станков делают пять деталей за пять минут. Сколько минут нужно ста таким станкам, чтобы сделать сто деталей? Ответь только числом.', 5]
];
const modes = [
  { name: 'baseline', temperature: 1, think: false },
  { name: 'zero', temperature: 0, think: false },
  { name: 'zero-thinking', temperature: 0, think: true }
];
const report = { model, cases: cases.map(([id, prompt, expected]) => ({ id, prompt, expected })), results: [] };
const destination = path.join(__dirname, '../local-llm/settings-benchmark.json');
const retry = process.argv.includes('--retry-truncated');
if (retry) {
  Object.assign(report, JSON.parse(fs.readFileSync(destination, 'utf8')));
  modes.splice(0, modes.length, { name: 'zero-thinking-8192', temperature: 0, think: true });
}
(async () => {
  for (const mode of modes) {
    for (const [id, prompt, expected] of cases) {
      if (retry && !report.results.some(row => row.id === id && row.mode === 'zero-thinking' && row.doneReason === 'length')) continue;
      const start = Date.now();
      try {
        const response = await fetch('http://127.0.0.1:11434/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }],
            stream: false, think: mode.think, options: { temperature: mode.temperature, seed: 42, num_ctx: retry ? 16384 : 8192, num_predict: retry ? 8192 : 2048 } }),
          signal: AbortSignal.timeout(180000)
        });
        if (!response.ok) throw new Error(await response.text());
        const result = await response.json();
        const answer = (result.message?.content || '').trim();
        // Score final answer only, never reasoning. Multiple numbers require manual review.
        const numbers = answer.replace(/(?<=\d)[ \u00a0](?=\d{3}(?:\D|$))/g, '').match(/-?\d+(?:[.,]\d+)?/g) || [];
        const correct = numbers.length === 1 && Number(numbers[0].replace(',', '.')) === expected;
        const item = { mode: mode.name, id, expected, answer, correct,
          seconds: (Date.now() - start) / 1000, generatedTokens: result.eval_count,
          thinkingCharacters: result.message?.thinking?.length || 0, doneReason: result.done_reason };
        report.results.push(item);
        console.log(JSON.stringify(item));
      } catch (error) {
        const item = { mode: mode.name, id, error: error.message, seconds: (Date.now() - start) / 1000 };
        report.results.push(item); console.log(JSON.stringify(item));
      }
      fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
    }
  }
  for (const mode of modes) {
    const rows = report.results.filter(row => row.mode === mode.name);
    console.log(JSON.stringify({ mode: mode.name, correct: rows.filter(row => row.correct).length, total: rows.length,
      averageSeconds: rows.reduce((sum, row) => sum + row.seconds, 0) / rows.length }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
