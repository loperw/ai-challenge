import './env.mjs';

export function ticketSelectionUrl(criteria, train) {
  const appUrl = process.env.TICKET_AGENT_PUBLIC_URL || `http://127.0.0.1:${Number(process.env.TICKET_AGENT_PORT) || 3035}`;
  const url = new URL('/open-ticket', appUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('TICKET_AGENT_PUBLIC_URL должен быть HTTP(S)-адресом приложения.');
  url.search = new URLSearchParams({
    from: criteria.from, to: criteria.to, date: criteria.date,
    train: train.trainNumber, departure: train.departureTime
  }).toString();
  return url.href;
}

export function renderTicketTransfer(form, criteria) {
  const fields = Object.entries(form.fields).map(([name, value]) =>
    `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`
  ).join('\n');
  return page('Открываем выбор мест', criteria, `
    <p>Сейчас откроется страница выбора мест на сайте БЖД.</p>
    <form id="booking-form" action="${escapeHtml(form.action)}" method="post">
      ${fields}<button type="submit">Перейти к выбору мест</button>
    </form>
    <script>document.getElementById('booking-form').submit();</script>`);
}

export function renderTicketError(criteria, message, scheduleUrl) {
  return page('Не удалось открыть выбор мест', criteria, `
    <p>${escapeHtml(message)}</p>
    <a href="${escapeHtml(scheduleUrl)}">Открыть расписание БЖД</a>`);
}

function page(title, criteria, body) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · RailScout</title>
    <style>body{font:16px/1.6 system-ui,sans-serif;background:#f4f6f3;color:#1d2b25;margin:0;padding:32px}main{max-width:560px;margin:10vh auto;background:white;padding:32px;border:1px solid #e2e8e2;border-radius:18px}h1{font-size:24px;line-height:1.3}p{color:#67756c}button,a{font:inherit;color:#1d6749}button{background:#1d6749;color:white;border:0;border-radius:8px;padding:12px 18px;cursor:pointer}</style>
    </head><body><main><h1>${title}</h1>
    <p>Поезд ${escapeHtml(criteria.trainNumber)} · ${escapeHtml(criteria.date)} · ${escapeHtml(criteria.departureTime)}<br>
    ${escapeHtml(criteria.from)} → ${escapeHtml(criteria.to)}</p>${body}</main></body></html>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
