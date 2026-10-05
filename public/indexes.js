(() => {
  const select = document.querySelector('#indexStrategy');
  const status = document.querySelector('#indexStatus');
  let data;
  const mode = document.querySelector('#indexRagMode');
  const processing = document.querySelector('#indexRetrievalMode');
  const limits = { candidateK: 10, contextK: 5 };
  const fields = { similarityThreshold: document.querySelector('#indexSimilarityThreshold') };
  const modes = {
    baseline: { filter: false, rewrite: false, label: 'Исходный RAG' },
    improved: { filter: true, rewrite: true, label: 'Фильтр + rewrite' }
  };
  let savedOptions = false;
  try {
    const saved = JSON.parse(localStorage.getItem('documentRetrievalOptions'));
    if (saved && typeof saved === 'object') {
      processing.value = modes[saved.mode] ? saved.mode : 'improved';
      for (const [key, field] of Object.entries(fields)) if (Number.isFinite(saved[key])) field.value = saved[key];
      savedOptions = true;
    }
  } catch {}
  window.selectedRetrievalOptions = () => ({
    ...limits,
    ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value === '' ? null : Number(field.value)])),
    filter: modes[processing.value].filter, rewrite: modes[processing.value].rewrite
  });
  try { mode.value = localStorage.getItem('documentIndexEnabled') === 'false' ? 'plain' : 'rag'; } catch {}
  window.selectedDocumentStrategy = () => mode.value === 'rag' ? select.value : null;
  const renderMode = () => {
    document.querySelector('#indexModeDescription').textContent = mode.value === 'rag'
      ? `С RAG · ${modes[processing.value].label}: поиск до ${limits.candidateK} кандидатов → ${modes[processing.value].filter ? 'фильтр → ' : ''}до ${limits.contextK} фрагментов → ответ с источниками.`
      : 'Без RAG: вопрос передаётся LLM без поиска и фрагментов книги. Доступны обычные MCP-инструменты чата.';
    fields.similarityThreshold.disabled = mode.value === 'plain' || !modes[processing.value].filter;
    processing.disabled = mode.value === 'plain';
  };
  renderMode();
  mode.addEventListener('change', () => {
    try { localStorage.setItem('documentIndexEnabled', String(mode.value === 'rag')); } catch {}
    renderMode();
  });
  for (const field of [processing, ...Object.values(fields)]) field.addEventListener('change', () => {
    savedOptions = true;
    try { localStorage.setItem('documentRetrievalOptions', JSON.stringify({ mode: processing.value, ...window.selectedRetrievalOptions() })); } catch {}
    renderMode();
  });
  fetch('/api/rag-config').then(response => response.ok ? response.json() : null).then(config => {
    if (!config || savedOptions) return;
    for (const [key, field] of Object.entries(fields)) field.value = config[key];
    renderMode();
  }).catch(() => {});
  window.renderDocumentSources = (container, result, ragMode = null) => {
    container.querySelector('.document-sources')?.remove();
    if (!result && !ragMode) return;
    const block = document.createElement('section'); block.className = 'document-sources';
    const heading = document.createElement('h4');
    heading.textContent = result ? `С RAG · ${result.strategy === 'fixed' ? 'Фиксированный размер' : 'По структуре'}` : ragMode === 'rag' ? 'С RAG' : 'Без RAG';
    if (!result) { block.append(heading); container.append(block); return; }
    const note = document.createElement('p'); note.textContent = result.hits.length
      ? 'Фрагменты, переданные модели. Ссылки открывают физические страницы PDF; сходство не гарантирует правильность ответа.'
      : 'Подходящих фрагментов не найдено. В книге не найден контекст для ответа.';
    block.append(heading, note);
    if (result.options) {
      const info = document.createElement('p');
      const config = result.options;
      info.textContent = `Фильтр: ${config.filter ? 'включён' : 'выключен'} · Rewrite: ${config.rewrite ? 'включён' : 'выключен'} · Top-K ${config.candidateK} → ${config.contextK} · порог ${config.similarityThreshold}. Кандидатов: ${result.candidateCount}; прошли порог: ${result.passedCount}; отсеяно порогом: ${result.rejectedCount}; передано: ${result.hits.length}. Порядок: ${result.ranking === 'rrf' ? 'объединение рангов RRF' : 'cosine similarity'}.`;
      block.append(info);
      if (result.rewrite.enabled) {
        const rewritten = document.createElement('p');
        rewritten.textContent = result.rewrite.status === 'failed'
          ? `Rewrite не выполнен: ${result.rewrite.error}. Поиск выполнен по исходному вопросу.`
          : `Исходный вопрос: ${result.query}\nЗапрос после rewrite: ${result.rewrite.query}`;
        rewritten.className = 'rag-query'; block.append(rewritten);
      }
      if (Array.isArray(result.usedSources) && !result.usedSources.length && result.hits.length) {
        const unused = document.createElement('p'); unused.textContent = 'Модель не указала подтверждающих источников для ответа.'; block.append(unused);
      }
      const diagnostic = document.createElement('details'); diagnostic.className = 'index-card';
      const summary = document.createElement('summary'); summary.textContent = 'Кандидаты и причины отбора'; diagnostic.append(summary);
      const selected = new Set(result.hits.map(hit => hit.chunk_id));
      for (const candidate of result.candidates || []) {
        const row = document.createElement('p');
        const reason = config.filter && candidate.score < config.similarityThreshold ? 'ниже порога' : selected.has(candidate.chunk_id) ? 'передан модели' : 'за пределами итогового top-K';
        row.textContent = `${candidate.section} · PDF ${candidate.page_start}–${candidate.page_end} · ${candidate.score.toFixed(3)} · ${reason}`;
        diagnostic.append(row);
      }
      block.append(diagnostic);
    }
    for (const [i, hit] of result.hits.entries()) {
      if (Array.isArray(result.usedSources) && !result.usedSources.includes(i + 1)) continue;
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
      const response = await fetch('/api/document-search', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({query:document.querySelector('#indexSearchQuery').value, strategy:select.value, retrievalOptions:window.selectedRetrievalOptions(), settings:window.selectedRagModelSettings()})});
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error);
      results.replaceChildren(); window.renderDocumentSources(results, payload);
    } catch (error) { results.textContent = error.message; }
    finally { button.disabled = false; }
  });
  document.querySelector('#indexCompareButton').addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    const results = document.querySelector('#indexCompareResults'); results.textContent = 'Готовим два независимых ответа…';
    try {
      const response = await fetch('/api/rag-compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: document.querySelector('#indexSearchQuery').value, strategy: select.value, retrievalOptions: window.selectedRetrievalOptions(), settings: window.selectedRagModelSettings() }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error);
      results.replaceChildren();
      for (const value of payload.results) {
        const card = document.createElement('section'); card.className = 'index-card';
        const heading = document.createElement('h3'); heading.textContent = value.label;
        const answer = document.createElement('p'); answer.className = 'rag-query'; answer.textContent = value.answer;
        card.append(heading, answer); window.renderDocumentSources(card, value.documentSearch, 'rag'); results.append(card);
      }
      const note = document.createElement('p'); note.className = 'memory-description'; note.textContent = payload.note; results.append(note);
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
