const form = document.querySelector('#booking-form');

async function decodePayload(encoded) {
  const compressed = encoded.startsWith('z');
  const payload = compressed ? encoded.slice(1) : encoded;
  if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw new Error('В ссылке нет данных выбранного поезда. Откройте ссылку из нового уведомления.');
  }
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  let bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  if (compressed) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('Обновите браузер, чтобы открыть ссылку на выбор мест.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 40000) {
        await reader.cancel();
        throw new Error('Данные выбора мест в ссылке слишком велики. Выполните поиск заново.');
      }
      chunks.push(value);
    }
    bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

async function openTicket() {
  try {
    const encoded = location.hash.slice(1);
    if (!encoded || encoded.length > 40000) {
      throw new Error('В ссылке нет данных выбранного поезда. Откройте ссылку из нового уведомления.');
    }
    const data = await decodePayload(encoded);
  if (data.version !== 1 || typeof data.route !== 'string' || !data.route || data.route.length > 24000) {
    throw new Error('Ссылка не содержит корректную форму выбора мест. Выполните поиск заново.');
  }
  const returnUrl = new URL(String(data.returnUrl || '/ru/route/'), 'https://pass.rw.by');
  if (returnUrl.origin !== 'https://pass.rw.by' || returnUrl.pathname !== '/ru/route/' || returnUrl.username || returnUrl.password) {
    throw new Error('В ссылке указан некорректный адрес расписания. Выполните поиск заново.');
  }
  document.querySelector('#trip').textContent = `Поезд ${String(data.train || '')} · ${String(data.date || '')} · ${String(data.departure || '')}`;
  form.elements.namedItem('route').value = data.route;
  form.elements.namedItem('url').value = returnUrl.pathname + returnUrl.search;
  form.hidden = false;
  history.replaceState(null, '', location.pathname + location.search);
  form.requestSubmit();
  } catch (error) {
    document.querySelector('#title').textContent = 'Не удалось открыть выбор мест';
    document.querySelector('#status').textContent = error instanceof SyntaxError || error instanceof TypeError
      ? 'Данные ссылки повреждены. Откройте ссылку из нового уведомления.'
      : error.message;
  }
}

void openTicket();
