const $ = id => document.getElementById(id);
let users = [], tickets = [], history = [], busy = false;
const key = () => `support-demo:${$('user').value}:${$('ticket').value}`;
async function api(url, body) {
  const response = await fetch(url, { ...(body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Ошибка сервера');
  return data;
}
function locked(value) {
  busy = value;
  for (const id of ['user', 'ticket', 'send', 'clear']) $(id).disabled = value;
}
function message(role, content, result) {
  $('messages').querySelector('.empty')?.remove();
  const article = document.createElement('article'); article.className = `message ${role}`;
  const title = document.createElement('strong'); title.textContent = role === 'user' ? 'Вы' : 'Поддержка · DeepSeek';
  article.append(title, document.createTextNode(content));
  if (result) {
    const sources = document.createElement('div'); sources.className = 'sources';
    for (const source of result.sources) {
      const link = document.createElement('a'); link.href = source.url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = `[${source.id}] ${source.title}`; sources.append(link);
    }
    const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Контекст MCP и найденные фрагменты';
    const pre = document.createElement('pre'); pre.textContent = JSON.stringify({ tool: result.trace.tool.name, context: result.context, sources: result.sources }, null, 2);
    details.append(summary, pre); article.append(sources, details);
  }
  $('messages').append(article); $('messages').scrollTop = $('messages').scrollHeight;
}
function selectTicket() {
  const ticket = tickets.find(item => item.id === $('ticket').value);
  $('ticketDetails').textContent = ticket ? `${ticket.id} · ${ticket.status}\n${ticket.description}\n\n${ticket.history.join('\n')}` : 'Общий вопрос: учитывается профиль пользователя.';
  history = []; $('messages').replaceChildren();
  try {
    const saved = JSON.parse(sessionStorage.getItem(key()) || '[]');
    if (Array.isArray(saved)) history = saved.filter(item => ['user', 'assistant'].includes(item.role) && typeof item.content === 'string').slice(-12);
  } catch {}
  history.forEach(item => message(item.role, item.content));
  $('status').textContent = 'Готов к вопросу · история текущего обращения';
}
async function selectUser() {
  locked(true); $('status').textContent = 'Получаю тикеты через MCP…';
  try {
    const user = users.find(item => item.id === $('user').value);
    $('profile').textContent = `${user.organization} · ${user.plan}\nВход: ${user.authMode === 'sso' ? 'SSO' : 'по паролю'} · ${user.id}`;
    tickets = (await api(`/api/support/tickets?userId=${encodeURIComponent(user.id)}`)).tickets;
    $('ticket').replaceChildren(new Option('Общий вопрос о продукте', ''), ...tickets.map(ticket => new Option(`${ticket.id} · ${ticket.title}`, ticket.id)));
    if (tickets.length) $('ticket').value = tickets[0].id;
    selectTicket(); locked(false);
  } catch (error) { $('status').textContent = error.message; $('user').disabled = false; }
}
$('user').addEventListener('change', selectUser);
$('ticket').addEventListener('change', selectTicket);
$('clear').addEventListener('click', () => { if (busy) return; history = []; try { sessionStorage.removeItem(key()); } catch {} $('messages').replaceChildren(); });
document.querySelectorAll('[data-question]').forEach(button => button.addEventListener('click', () => { $('question').value = button.dataset.question; $('question').focus(); }));
$('form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const question = $('question').value.trim(); if (!question) return;
  locked(true); $('question').disabled = true; $('status').textContent = 'MCP → поиск по FAQ → ответ DeepSeek…';
  message('user', question);
  try {
    const result = await api('/api/support/chat', { userId: $('user').value, ...($('ticket').value && { ticketId: $('ticket').value }), message: question, history });
    message('assistant', result.answer, result);
    history = [...history, { role: 'user', content: question }, { role: 'assistant', content: result.answer }].slice(-12);
    try { sessionStorage.setItem(key(), JSON.stringify(history)); } catch {}
    $('question').value = ''; $('status').textContent = 'Ответ готов · DeepSeek';
  } catch (error) { $('status').textContent = `Не удалось получить ответ: ${error.message}`; }
  finally { locked(false); $('question').disabled = false; $('question').focus(); }
});
(async () => {
  try {
    users = (await api('/api/support/users')).users;
    $('user').replaceChildren(...users.map(user => new Option(user.name, user.id)));
    await selectUser();
  } catch (error) { $('status').textContent = error.message; }
})();
