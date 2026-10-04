(() => {
  const select = document.querySelector('#indexStrategy');
  const status = document.querySelector('#indexStatus');
  let data;
  const enabled = document.querySelector('#indexUseBook');
  try { enabled.checked = localStorage.getItem('documentIndexEnabled') !== 'false'; } catch {}
  window.selectedDocumentStrategy = () => enabled.checked ? select.value : null;
  enabled.addEventListener('change', () => { try { localStorage.setItem('documentIndexEnabled', String(enabled.checked)); } catch {} });
  window.renderDocumentSources = (container, result) => {
    container.querySelector('.document-sources')?.remove();
    if (!result) return;
    const block = document.createElement('section'); block.className = 'document-sources';
    const heading = document.createElement('h4');
    heading.textContent = `Поиск по книге · ${result.strategy === 'fixed' ? 'Фиксированный размер' : 'По структуре'}`;
    const note = document.createElement('p'); note.textContent = 'Найденные фрагменты. Ссылки открывают физические страницы PDF; сходство не гарантирует правильность ответа.';
    block.append(heading, note);
    for (const [i, hit] of result.hits.entries()) {
      const card = document.createElement('details'); card.className = 'index-card';
      const title = document.createElement('summary'); title.textContent = `[${i + 1}] ${hit.section} · PDF ${hit.page_start}–${hit.page_end}`;
      const link = document.createElement('a'); link.href = `/api/document-book#page=${Number(hit.page_start)}`; link.target = '_blank'; link.rel = 'noopener'; link.textContent = `${hit.file} · открыть страницу ${hit.page_start}`;
      const metadata = document.createElement('p'); metadata.className = 'index-chunk-id'; metadata.textContent = `chunk_id: ${hit.chunk_id} · сходство: ${Number(hit.score).toFixed(3)}`;
      const text = document.createElement('p'); text.textContent = hit.text;
      card.append(title, link, metadata, text); block.append(card);
    }
    container.append(block);
  };
  document.querySelector('#indexSearchButton').addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    const results = document.querySelector('#indexSearchResults'); results.textContent = 'Ищем в книге…';
    try {
      const response = await fetch('/api/document-search', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({query:document.querySelector('#indexSearchQuery').value, strategy:select.value})});
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error);
      results.replaceChildren(); window.renderDocumentSources(results, payload);
    } catch (error) { results.textContent = error.message; }
    finally { button.disabled = false; }
  });
  try { select.value = localStorage.getItem('documentIndexStrategy') === 'structure' ? 'structure' : 'fixed'; } catch {}
  const number = value => value == null ? '—' : Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  function render() {
    const index = data?.strategies?.[select.value];
    document.querySelector('#indexBookTitle').textContent = data?.book?.file || 'Книга ещё не проиндексирована';
    document.querySelector('#indexBookInfo').textContent = data?.book ? `${number(data.book.pages)} страниц PDF · ${number(data.book.sections)} разделов` : 'Создайте локальный индекс PDF, затем обновите информацию.';
    document.querySelector('#indexStrategyDescription').textContent = select.value === 'fixed'
      ? 'Текст делится на фрагменты фиксированной длины с перекрытием. Чанк может пересекать границы разделов.'
      : 'Разбиение по оглавлению и заголовкам PDF. Длинные разделы делятся на меньшие фрагменты; перекрытие остаётся внутри раздела.';
    const metrics = document.querySelector('#indexMetrics');
    const samples = document.querySelector('#indexSamples');
    metrics.replaceChildren(); samples.replaceChildren();
    if (!index?.available) { status.textContent = index?.error || 'Для выбранной стратегии индекс пока отсутствует.'; return; }
    status.textContent = 'Локальный индекс готов. Ниже показаны данные выбранной стратегии.';
    const fields = [['Чанки', number(index.chunks)], ['Размер чанка', `${number(index.size)} символов`],
      ['Перекрытие', `${number(index.overlap)} символов`], ['Размер SQLite', `${number(index.bytes / 1048576)} МиБ`],
      ['Время индексации', `${number(index.seconds)} с`], ['Пересечения разделов', number(index.crossSections)],
      ['Модель', index.model], ['Размерность', number(index.dimensions)],
      ['Найдено в top-5', index.hitAt5 == null ? '—' : `${number(index.hitAt5 * 100)}% · ${number(index.queryCount)} вопросов`],
      ['Создан', index.createdAt ? new Date(index.createdAt).toLocaleString('ru-RU') : '—']];
    for (const [label, value] of fields) {
      const term = document.createElement('dt'); term.textContent = label;
      const detail = document.createElement('dd'); detail.textContent = value;
      metrics.append(term, detail);
    }
    for (const sample of index.samples) {
      const card = document.createElement('details'); card.className = 'index-card';
      const summary = document.createElement('summary'); summary.textContent = `${sample.section} · стр. ${sample.page_start}–${sample.page_end}`;
      const id = document.createElement('p'); id.className = 'index-chunk-id'; id.textContent = `chunk_id: ${sample.chunk_id}`;
      const source = document.createElement('p'); source.className = 'index-chunk-id'; source.textContent = `source: ${sample.source}`;
      const text = document.createElement('p'); text.textContent = sample.text;
      card.append(summary, id, source, text); samples.append(card);
    }
  }
  window.refreshDocumentIndexes = async () => {
    status.textContent = 'Загрузка индексов…';
    try {
      const response = await fetch('/api/document-indexes', { cache: 'no-store' });
      if (!response.ok) throw new Error('Не удалось загрузить индексы');
      data = await response.json(); render();
    } catch { status.textContent = 'Не удалось загрузить данные. Проверьте сервер и нажмите «Обновить информацию».'; }
  };
  select.addEventListener('change', () => {
    try { localStorage.setItem('documentIndexStrategy', select.value); } catch {}
    render();
  });
  document.querySelector('#indexRefresh').addEventListener('click', window.refreshDocumentIndexes);
})();
