const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWeather, blocks } = require('../public/file-preview');

test('weather presentation preserves exact decimal values, negative temperatures and remaining facts', () => {
  const parsed = parseWeather('Минск, Беларусь, 2026-09-28 — 2026-10-04: суточные минимумы -3.5…10.2 °C, максимумы 4.1…20.5 °C. Условия за весь период: пасмурно — 6 из 7 дней; ясно — 1 из 7 дней. Вероятность осадков 0…85%. Источник: Open-Meteo.');
  assert.equal(parsed.location, 'Минск, Беларусь');
  assert.deepEqual(parsed.facts.map(item => item.value), ['-3.5…10.2 °C', '4.1…20.5 °C', '0…85%']);
  assert.deepEqual(parsed.conditions, ['пасмурно — 6 из 7 дней', 'ясно — 1 из 7 дней']);
  assert.equal(parsed.rest, 'Источник: Open-Meteo.');
});

test('partial summaries never invent missing weather facts', () => {
  const parsed = parseWeather('Минск, 2026-09-28 — 2026-10-04: суточные минимумы 5 °C, максимумы 18 °C.');
  assert.equal(parsed.facts.length, 2);
  assert.deepEqual(parsed.conditions, []);
  assert.equal(parseWeather('Данных о погоде нет.'), null);
});

test('document parser keeps factual headings, lists, table values and literal HTML as text', () => {
  const parsed = blocks('# Факты\n\n- **Дней:** 7\n- Осадки: 0%\n\n| День | °C |\n| --- | --- |\n| Пн | -3.5 |\n\n<script>alert(1)</script>');
  assert.equal(parsed[0].text, 'Факты');
  assert.deepEqual(parsed[1].items, ['**Дней:** 7', 'Осадки: 0%']);
  assert.deepEqual(parsed[2].rows, [['Пн', '-3.5']]);
  assert.equal(parsed[3].text, '<script>alert(1)</script>');
});
