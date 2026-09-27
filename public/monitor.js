// Loaded after app.js: shares the current workspace tab, but never writes to chat history.
let monitoringBusy = false;
let monitoringSnapshot = '';
let monitoringGeneration = 0;
const scheduleLabels = { active: 'Активно', paused: 'На паузе', completed: 'Завершено', cancelled: 'Отменено' };
const formatMonitorTime = value => value ? new Date(value).toLocaleString('ru-RU') : '—';

function monitorElement(tag, text, className = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
}

async function monitorJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Не удалось обновить мониторинг.');
  return data;
}

function renderMonitorJob({ job, summary, runs }) {
  const card = monitorElement('article', '', 'monitor-card');
  card.dataset.jobId = job.id;
  card.dataset.status = job.status;
  const heading = monitorElement('header', '');
  heading.append(monitorElement('h3', job.title), monitorElement('span', scheduleLabels[job.status], `monitor-status ${job.status}`));
  card.append(heading);
  const frequency = job.intervalSeconds === 60 ? 'Каждую минуту' : job.intervalSeconds
    ? `Интервал: ${job.intervalSeconds % 60 ? `${job.intervalSeconds} сек.` : `${job.intervalSeconds / 60} мин.`}` : 'Однократно';
  card.append(monitorElement('p', `${frequency} · ${job.running ? 'Выполняется…' : `Следующий запуск: ${formatMonitorTime(job.nextRunAt)}`}`, 'monitor-meta'));
  const controls = monitorElement('div', '', 'monitor-controls');
  if (['active', 'paused'].includes(job.status)) {
    for (const [label, status] of [[job.status === 'active' ? 'Пауза' : 'Продолжить', job.status === 'active' ? 'paused' : 'active'], ['Отменить', 'cancelled']]) {
      const button = monitorElement('button', label);
      button.type = 'button';
      button.dataset.action = status;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await monitorJson(`/api/schedules/${job.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
          monitoringSnapshot = '';
          await refreshMonitoring();
        } catch (error) { document.querySelector('#monitorConnection').textContent = error.message; }
        finally { button.disabled = false; }
      });
      controls.append(button);
    }
  }
  const deleteButton = monitorElement('button', 'Удалить', 'monitor-delete');
  deleteButton.type = 'button';
  deleteButton.dataset.action = 'delete';
  deleteButton.title = 'Удалить мониторинг и всю его историю';
  deleteButton.addEventListener('click', async () => {
    deleteButton.disabled = true;
    try {
      await monitorJson(`/api/schedules/${job.id}`, { method: 'DELETE' });
      monitoringGeneration++;
      monitoringSnapshot = '';
      const root = document.querySelector('#monitorJobs');
      for (const current of root.querySelectorAll('.monitor-card')) {
        if (current.dataset.jobId === job.id) current.remove();
      }
      document.querySelector('#monitorCount').textContent = root.querySelectorAll('.monitor-card[data-status="active"]').length;
      if (!root.querySelector('.monitor-card')) root.replaceChildren(monitorElement('p', 'Расписаний пока нет.', 'monitor-empty'));
      document.querySelector('#monitorConnection').textContent = 'Мониторинг и его история удалены.';
      await refreshMonitoring();
    } catch (error) { document.querySelector('#monitorConnection').textContent = error.message; }
    finally { deleteButton.disabled = false; }
  });
  controls.append(deleteButton);
  card.append(controls);
  const aggregate = monitorElement('div', '', 'monitor-summary');
  aggregate.append(monitorElement('strong', `Сводка · Запусков: ${summary.totalRuns}`));
  aggregate.append(monitorElement('p', `Успешно: ${summary.successes} · Ошибок: ${summary.failures}`));
  if (summary.temperature) {
    const t = summary.temperature;
    aggregate.append(monitorElement('p', `Средняя ${t.average} ${t.unit} · Мин. ${t.min}° · Макс. ${t.max}°`));
  }
  if (summary.from) aggregate.append(monitorElement('small', `${formatMonitorTime(summary.from)} — ${formatMonitorTime(summary.to)} · В архиве: ${summary.retainedRuns}`));
  card.append(aggregate);
  const latest = runs[0];
  if (latest) {
    const result = latest.result;
    const text = latest.error ? `Ошибка: ${latest.error}` : result.current
      ? `${result.location}: ${result.current.temperature} ${result.units.temperature}, ${result.current.conditions}. Ощущается как ${result.current.apparentTemperature}°. Ветер ${result.current.windSpeed} ${result.units.windSpeed}.`
      : result.message;
    card.append(monitorElement('p', text, latest.error ? 'mcp-error' : 'monitor-latest'));
    card.append(monitorElement('small', `Получено: ${formatMonitorTime(latest.finishedAt)}`, 'monitor-meta'));
    if (result?.current) card.append(monitorElement('small', `Open-Meteo · Данные: ${result.current.observedAt} (${result.timezone}). Частота обновления источника может быть ниже частоты сбора.`, 'monitor-meta'));
  } else card.append(monitorElement('p', 'Ожидается первый результат…', 'monitor-meta'));
  const history = monitorElement('details', '');
  history.dataset.jobId = job.id;
  history.append(monitorElement('summary', `История · Записей: ${runs.length}`));
  const list = monitorElement('ol', '', 'monitor-history');
  for (const run of runs) {
    const result = run.result;
    const text = run.error ? `Ошибка: ${run.error}` : result.current
      ? `${result.current.temperature} ${result.units.temperature}, ${result.current.conditions}` : result.message;
    list.append(monitorElement('li', `${formatMonitorTime(run.finishedAt)} — ${text}`));
  }
  history.append(list);
  card.append(history);
  return card;
}

function resetMonitoring() {
  monitoringGeneration++;
  monitoringSnapshot = '';
  document.querySelector('#monitorCount').textContent = '0';
  document.querySelector('#monitorJobs').replaceChildren(monitorElement('p', 'Расписаний пока нет.', 'monitor-empty'));
  document.querySelector('#monitorConnection').textContent = 'Все расписания и результаты удалены.';
}

async function refreshMonitoring() {
  if (monitoringBusy) return;
  monitoringBusy = true;
  const generation = monitoringGeneration;
  try {
    const { jobs } = await monitorJson('/api/schedules');
    if (generation !== monitoringGeneration) return;
    document.querySelector('#monitorCount').textContent = jobs.filter(job => job.status === 'active').length;
    if (sidePanel === 'monitor') {
      const results = await Promise.all(jobs.map(job => monitorJson(`/api/schedules/${job.id}`)));
      if (generation !== monitoringGeneration) return;
      const snapshot = JSON.stringify(results);
      if (snapshot !== monitoringSnapshot) {
        const root = document.querySelector('#monitorJobs');
        const open = new Set([...root.querySelectorAll('details[open]')].map(item => item.dataset.jobId));
        const focused = document.activeElement;
        const focusJob = focused.closest('.monitor-card')?.dataset.jobId;
        const focusAction = focused.dataset.action;
        root.replaceChildren(...results.map(renderMonitorJob));
        if (!results.length) root.append(monitorElement('p', 'Расписаний пока нет. Напишите в чате: «мониторинг погоды в Москве каждую минуту» или «напомни через 10 минут сделать перерыв».', 'monitor-empty'));
        for (const details of root.querySelectorAll('details')) details.open = open.has(details.dataset.jobId);
        const focusCard = [...root.querySelectorAll('.monitor-card')].find(card => card.dataset.jobId === focusJob);
        const focusTarget = focusAction
          ? [...(focusCard?.querySelectorAll('button') || [])].find(button => button.dataset.action === focusAction)
          : focusCard?.querySelector('summary');
        focusTarget?.focus({ preventScroll: true });
        monitoringSnapshot = snapshot;
      }
    }
    document.querySelector('#monitorConnection').textContent = `Сервер доступен · Обновлено ${new Date().toLocaleTimeString('ru-RU')}`;
  } catch (error) {
    if (generation !== monitoringGeneration) return;
    document.querySelector('#monitorConnection').textContent = `Нет обновлений: ${error.message}. Повтор через 3 секунды.`;
  } finally { monitoringBusy = false; }
}

document.querySelector('#monitorTabButton').addEventListener('click', () => {
  sidePanel = 'monitor'; renderWorkspaceMode(); refreshMonitoring();
});
document.querySelector('#monitorExample').addEventListener('click', () => {
  promptEl.value = 'мониторинг погоды в Москве каждую минуту';
  promptEl.dispatchEvent(new Event('input'));
  promptEl.focus();
});
setInterval(refreshMonitoring, 3000);
refreshMonitoring();
