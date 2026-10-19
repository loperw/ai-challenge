const form = document.querySelector('#search-form');
const toast = document.querySelector('#toast');
const trainList = document.querySelector('#train-list');
let activeMonitorId = null;
let toastTimer;

function notify(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3400);
}

function value(name) { return form.elements.namedItem(name)?.value?.trim() || ''; }
function intervalLabel(seconds) { return seconds < 60 ? `${seconds} сек.` : `${seconds / 60} мин.`; }
function formData() {
  return {
    name: value('name'), from: value('from'), to: value('to'), date: value('date'),
    timeFrom: value('timeFrom') || '00:00', timeTo: value('timeTo') || '23:59',
    chatId: value('chatId'), everySeconds: Number(value('everySeconds')),
    ticketTypes: [...form.querySelectorAll('input[name="ticketTypes"]:checked')].map((input) => input.value),
    excludedTimes: [...document.querySelectorAll('.exclusion-row')].map((row) => ({ from: row.querySelector('[data-time="from"]').value, to: row.querySelector('[data-time="to"]').value })).filter((period) => period.from && period.to)
  };
}

async function api(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
  return data;
}

function renderStatus(status) {
  const dot = document.querySelector('.connection-dot');
  const ready = status.deepseekConfigured && status.railSourceConfigured;
  dot.classList.toggle('ready', ready); dot.classList.toggle('warn', !ready);
  const missing = [!status.deepseekConfigured && 'DeepSeek', !status.railSourceConfigured && 'источник билетов', !status.telegramConfigured && 'Telegram'].filter(Boolean);
  document.querySelector('#service-label').textContent = missing.length ? `Нужно настроить: ${missing.join(', ')}` : `Источник: ${status.railSource || 'pass.rw.by'}`;
  if (status.monitors?.length && !activeMonitorId) {
    const current = status.monitors[0]; activeMonitorId = current.id;
    document.querySelector('#monitor-card').hidden = false;
    document.querySelector('#monitor-info').textContent = `Проверка каждые ${intervalLabel(current.everySeconds)} · совпадений: ${current.lastCount}`;
  }
}

function renderTrain(train) {
  const card = document.createElement('article'); card.className = 'train-card';
  const top = document.createElement('div'); top.className = 'train-top';
  const number = document.createElement('strong'); number.className = 'train-number'; number.textContent = `Поезд ${train.trainNumber}${train.trainName ? ` · ${train.trainName}` : ''}`;
  const date = document.createElement('span'); date.className = 'train-date'; date.textContent = train.date || '';
  top.append(number, date);
  const route = document.createElement('div'); route.className = 'train-route';
  const departure = document.createElement('div'); departure.innerHTML = `<div class="train-time"></div><div class="train-station"></div>`;
  departure.querySelector('.train-time').textContent = train.departureTime || '—'; departure.querySelector('.train-station').textContent = train.from || '';
  const duration = document.createElement('span'); duration.className = 'train-duration'; duration.textContent = '→';
  const arrival = document.createElement('div'); arrival.style.textAlign = 'right'; arrival.innerHTML = `<div class="train-time"></div><div class="train-station"></div>`;
  arrival.querySelector('.train-time').textContent = train.arrivalTime || '—'; arrival.querySelector('.train-station').textContent = train.to || '';
  route.append(departure, duration, arrival);
  const seats = document.createElement('div'); seats.className = 'seat-list';
  for (const seat of train.availableSeats || []) {
    const pill = document.createElement('span'); pill.className = 'seat-pill';
    const details = document.createElement('span'); details.textContent = `${seat.type} · мест: ${seat.count}`;
    const price = document.createElement('strong'); price.className = 'seat-price'; price.textContent = seat.price ?? 'Цена не указана';
    pill.append(details, price); seats.append(pill);
  }
  card.append(top, route, seats);
  if (train.url) { const link = document.createElement('a'); link.className = 'train-link'; link.href = train.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Открыть источник ↗'; card.append(link); }
  return card;
}

function renderResult(result) {
  trainList.replaceChildren(...(result.trains || []).map(renderTrain));
  const count = (result.trains || []).length;
  document.querySelector('#result-count').textContent = String(count);
  document.querySelector('#results-title').textContent = count ? `Подходящих поездов: ${count}` : 'Подходящих поездов пока нет';
  document.querySelector('#results-copy').textContent = result.notification?.sent ? 'Сообщение уже отправлено в Telegram.' : result.notification?.error ? `Поиск завершён, но Telegram не отправил сообщение: ${result.notification.error}` : `Проверено ${new Date(result.checkedAt).toLocaleString('ru-RU')}.`;
  const answer = document.querySelector('#agent-answer'); answer.hidden = !result.answer; answer.textContent = result.answer || '';
  const sources = document.querySelector('#rag-sources'); sources.hidden = !result.knowledge?.length;
  document.querySelector('#source-list').replaceChildren(...(result.knowledge || []).map((text) => { const p = document.createElement('p'); p.textContent = text; return p; }));
}

function addExclusion(from = '', to = '') {
  const row = document.createElement('div'); row.className = 'exclusion-row';
  const start = document.createElement('input'); start.type = 'time'; start.dataset.time = 'from'; start.setAttribute('aria-label', 'Начало исключаемого времени'); start.value = from;
  const end = document.createElement('input'); end.type = 'time'; end.dataset.time = 'to'; end.setAttribute('aria-label', 'Окончание исключаемого времени'); end.value = to;
  const dash = document.createElement('span'); dash.textContent = '—'; dash.style.color = '#9aa49c';
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-exclusion'; remove.setAttribute('aria-label', 'Удалить период'); remove.textContent = '×'; remove.addEventListener('click', () => row.remove());
  row.append(start, dash, end, remove); document.querySelector('#exclusions').append(row);
}

document.querySelector('#add-exclusion').addEventListener('click', () => addExclusion());
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('[type="submit"]'); button.disabled = true; button.querySelector('span').textContent = 'Агент ищет…';
  try { renderResult(await api('/api/search', formData())); }
  catch (error) { notify(error.message); document.querySelector('#results-copy').textContent = error.message; }
  finally { button.disabled = false; button.querySelector('span').textContent = 'Найти подходящие билеты'; }
});

document.querySelector('#monitor-start').addEventListener('click', async (event) => {
  if (!form.reportValidity()) return;
  if (!value('chatId')) { notify('Введите Telegram ID для уведомлений мониторинга'); form.elements.namedItem('chatId').focus(); return; }
  const button = event.currentTarget; button.disabled = true;
  try {
    const result = await api('/api/monitor/start', formData()); activeMonitorId = result.id;
    document.querySelector('#monitor-card').hidden = false;
    document.querySelector('#monitor-info').textContent = `Проверка каждые ${intervalLabel(result.everySeconds)} · работает на сервере`;
    notify('Мониторинг запущен');
  } catch (error) { notify(error.message); }
  finally { button.disabled = false; }
});
document.querySelector('#monitor-stop').addEventListener('click', async () => {
  if (!activeMonitorId) return;
  try { await api('/api/monitor/stop', { id: activeMonitorId }); activeMonitorId = null; document.querySelector('#monitor-card').hidden = true; notify('Мониторинг остановлен'); }
  catch (error) { notify(error.message); }
});
document.querySelector('#telegram-test').addEventListener('click', async () => {
  if (!value('chatId')) { notify('Введите Telegram ID для тестового сообщения'); form.elements.namedItem('chatId').focus(); return; }
  try { await api('/api/telegram/test', { chatId: value('chatId') }); notify('Тестовое сообщение отправлено'); }
  catch (error) { notify(error.message); }
});

fetch('/api/status').then((response) => response.json()).then(renderStatus).catch(() => { document.querySelector('#service-label').textContent = 'Сервер не отвечает'; });
