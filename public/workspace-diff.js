(function (root) {
  const lines = text => text == null || text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  function compare(before, after) {
    const a = lines(before), b = lines(after), rows = [];
    let oldLine = 0, newLine = 0;
    const add = (kind, text) => rows.push({ kind, text, oldLine: kind === 'add' ? '' : ++oldLine, newLine: kind === 'remove' ? '' : ++newLine });
    if (a.length * b.length > 1000000) {
      a.forEach(text => add('remove', text)); b.forEach(text => add('add', text)); return rows;
    }
    const matrix = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
      matrix[i][j] = a[i] === b[j] ? 1 + matrix[i + 1][j + 1] : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { add('context', a[i++]); j++; }
      else if (i < a.length && (j === b.length || matrix[i + 1][j] >= matrix[i][j + 1])) add('remove', a[i++]);
      else add('add', b[j++]);
    }
    return rows;
  }
  function render(container, proposal) {
    const doc = container.ownerDocument;
    const el = (tag, cls, text) => { const node = doc.createElement(tag); node.className = cls; if (text !== undefined) node.textContent = text; return node; };
    container.replaceChildren();
    if (!proposal.entries?.length) { container.append(el('p', '', 'Изменений нет.')); return; }
    for (const entry of proposal.entries) {
      const rows = compare(entry.before, entry.after), file = el('section', 'diff-file');
      const header = el('header', 'diff-file-header');
      header.append(el('strong', 'diff-file-name', entry.path), el('span', 'diff-added-count', `+${rows.filter(r => r.kind === 'add').length}`), el('span', 'diff-removed-count', `−${rows.filter(r => r.kind === 'remove').length}`));
      const toggle = el('button', 'diff-view-toggle', 'Показать исходный текст'); toggle.type = 'button';
      const table = el('div', 'diff-lines');
      let source = !entry.path.endsWith('.md');
      const draw = () => {
        table.replaceChildren();
        toggle.textContent = source ? 'Показать документ' : 'Показать исходный текст';
        toggle.setAttribute('aria-pressed', String(source));
        for (const row of rows) {
          const line = el('div', 'diff-line diff-' + row.kind);
          line.append(el('span', 'diff-line-number', String(row.oldLine)), el('span', 'diff-line-number', String(row.newLine)), el('span', 'diff-sign', row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ''));
          const content = el('div', 'diff-line-content');
          if (!source && root.FilePreview) {
            // Render Markdown as a document; exact source stays available via the toggle.
            const text = /^\s*\|?\s*:?-{3,}:?\s*\|/.test(row.text) || /^\s*```/.test(row.text) ? '' : row.text.includes('|') ? row.text.replace(/^\s*\||\|\s*$/g, '').split('|').map(s => s.trim()).join('  ·  ') : row.text;
            root.FilePreview.render(content, text);
          } else content.textContent = row.text || ' ';
          line.append(content); table.append(line);
        }
      };
      if (entry.path.endsWith('.md')) header.append(toggle);
      toggle.addEventListener('click', () => { source = !source; draw(); });
      draw(); file.append(header, table); container.append(file);
    }
  }
  const api = { compare, render };
  if (typeof module !== 'undefined') module.exports = api;
  else root.WorkspaceDiff = api;
})(typeof globalThis === 'undefined' ? this : globalThis);
