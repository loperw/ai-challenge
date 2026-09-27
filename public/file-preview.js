(function (root) {
  // Presentation only: every value comes from the saved file, without LLM rewriting.
  function parseWeather(text) {
    const match = text.match(/^(.+?), (\d{4}-\d{2}-\d{2}) [—–-] (\d{4}-\d{2}-\d{2}): суточные минимумы (.+?), максимумы (.+?)\.(?=\s|$)/u);
    if (!match) return null;
    let rest = text.slice(match[0].length).trim();
    const conditions = rest.match(/^Условия за весь период: (.+?)\.(?=\s|$)/u);
    if (conditions) rest = rest.slice(conditions[0].length).trim();
    const rain = rest.match(/^Вероятность осадков (.+?%)\.(?=\s|$)/u);
    if (rain) rest = rest.slice(rain[0].length).trim();
    return { location: match[1], from: match[2], to: match[3],
      facts: [{ label: 'Суточные минимумы', value: match[4] }, { label: 'Суточные максимумы', value: match[5] },
        ...(rain ? [{ label: 'Вероятность осадков', value: rain[1] }] : [])],
      conditions: conditions ? conditions[1].split(';').map(item => item.trim()) : [], rest };
  }

  function blocks(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const result = [];
    for (let i = 0; i < lines.length;) {
      const line = lines[i].trim();
      if (!line) { i++; continue; }
      if (/^```/.test(line)) {
        const code = []; i++;
        while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
        i++; result.push({ type: 'code', text: code.join('\n') }); continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) { result.push({ type: 'heading', level: Math.min(heading[1].length + 1, 6), text: heading[2] }); i++; continue; }
      if (/^([-*_])(?:\s*\1){2,}$/.test(line)) { result.push({ type: 'rule' }); i++; continue; }
      if (/^(?:[-*+]\s+|\d+[.)]\s+)/.test(line)) {
        const ordered = /^\d/.test(line), items = [];
        const pattern = ordered ? /^\d+[.)]\s+(.+)$/ : /^[-*+]\s+(.+)$/;
        while (i < lines.length) { const item = lines[i].trim().match(pattern); if (!item) break; items.push(item[1]); i++; }
        result.push({ type: 'list', ordered, items }); continue;
      }
      if (line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*\|/.test(lines[i + 1] || '')) {
        const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
        const headers = cells(line), rows = []; i += 2;
        while (i < lines.length && lines[i].includes('|')) rows.push(cells(lines[i++]));
        result.push({ type: 'table', headers, rows }); continue;
      }
      const paragraph = [line]; i++;
      while (i < lines.length && lines[i].trim() && !/^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```)/.test(lines[i].trim())) {
        if (lines[i].includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) break;
        paragraph.push(lines[i++].trim());
      }
      result.push({ type: 'paragraph', text: paragraph.join('\n') });
    }
    return result;
  }

  function render(container, text) {
    const doc = container.ownerDocument;
    const el = (tag, className, value) => {
      const node = doc.createElement(tag); if (className) node.className = className;
      if (value !== undefined) node.textContent = value; return node;
    };
    const inline = (node, value) => {
      // Text nodes only. Raw HTML, scripts and links from file content are never executed.
      for (const token of value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
        node.append(token.startsWith('**') && token.endsWith('**') ? el('strong', '', token.slice(2, -2))
          : token.startsWith('`') && token.endsWith('`') ? el('code', '', token.slice(1, -1)) : doc.createTextNode(token));
      }
      return node;
    };
    const renderBlocks = (parent, value) => {
      const parsed = blocks(value);
      // Plain, single-paragraph summaries are displayed as individual factual statements.
      if (parsed.length === 1 && parsed[0].type === 'paragraph' && !parsed[0].text.includes('\n')) {
        const sentences = [...new Intl.Segmenter('ru', { granularity: 'sentence' }).segment(parsed[0].text)].map(item => item.segment.trim()).filter(Boolean);
        if (sentences.length > 1) {
          const list = el('ul', 'preview-facts');
          for (const sentence of sentences) list.append(inline(el('li'), sentence));
          parent.append(el('p', 'preview-section-label', 'Ключевые факты'), list); return;
        }
      }
      for (const block of parsed) {
        if (block.type === 'rule') { parent.append(el('hr')); continue; }
        if (block.type === 'code') { const pre = el('pre', 'preview-code'); pre.append(el('code', '', block.text)); parent.append(pre); continue; }
        if (block.type === 'list') {
          const list = el(block.ordered ? 'ol' : 'ul');
          for (const item of block.items) list.append(inline(el('li'), item)); parent.append(list); continue;
        }
        if (block.type === 'table') {
          const wrapper = el('div', 'preview-table-wrap'), table = el('table'), head = el('thead'), row = el('tr'), body = el('tbody');
          for (const value of block.headers) row.append(inline(el('th'), value)); head.append(row); table.append(head);
          for (const cells of block.rows) { const row = el('tr'); for (const value of cells) row.append(inline(el('td'), value)); body.append(row); }
          table.append(body); wrapper.append(table); parent.append(wrapper); continue;
        }
        parent.append(inline(el(block.type === 'heading' ? `h${block.level}` : 'p'), block.text));
      }
    };
    container.replaceChildren();
    const article = el('article', 'preview-document');
    const weather = parseWeather(text.trim());
    if (weather) {
      const date = value => new Date(`${value}T00:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
      const header = el('header', 'preview-document-heading');
      header.append(el('p', 'preview-section-label', 'Сводка погоды'), el('h2', '', weather.location),
        el('p', 'preview-period', `${date(weather.from)} — ${date(weather.to)}`));
      article.append(header);
      const facts = el('div', 'preview-metrics');
      for (const fact of weather.facts) {
        const card = el('section', 'preview-metric');
        card.append(el('p', '', fact.label), el('strong', '', fact.value)); facts.append(card);
      }
      article.append(facts);
      if (weather.conditions.length) {
        article.append(el('h3', '', 'Условия за период'));
        const list = el('ul', 'preview-conditions');
        for (const condition of weather.conditions) {
          const split = condition.lastIndexOf(' — '), row = el('li');
          if (split < 0) row.textContent = condition;
          else row.append(el('span', '', condition.slice(0, split)), el('strong', '', condition.slice(split + 3)));
          list.append(row);
        }
        article.append(list);
      }
      if (weather.rest) renderBlocks(article, weather.rest);
    } else renderBlocks(article, text);
    container.append(article);
  }
  const api = { parseWeather, blocks, render };
  if (typeof module !== 'undefined') module.exports = api;
  else root.FilePreview = api;
})(typeof globalThis === 'undefined' ? this : globalThis);
