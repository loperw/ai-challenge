const messagesEl = document.querySelector('#messages');
const form = document.querySelector('#chatForm');
const promptEl = document.querySelector('#prompt');
const modelEl = document.querySelector('#model');
const jsonModeEl = document.querySelector('#jsonMode');
const jsonModeStatusEl = document.querySelector('#jsonModeStatus');
const maxTokensEl = document.querySelector('#maxTokens');
const stopSequenceEl = document.querySelector('#stopSequence');
const sendButton = document.querySelector('#sendButton');
let history = [];

function setJsonModeStatus() {
  jsonModeStatusEl.value = jsonModeEl.checked ? 'Включен' : 'Выключен';
}
jsonModeEl.addEventListener('change', setJsonModeStatus);

function addMessage(role, content) {
  const item = document.createElement('article'); item.className = `message ${role}`;
  const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = role === 'assistant' ? 'AI' : 'Я';
  const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = content;
  item.append(avatar, bubble); messagesEl.append(item); item.scrollIntoView({ behavior: 'smooth', block: 'end' }); return item;
}
async function readStream(response, onToken) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      const chunk = JSON.parse(data);
      const token = chunk.choices?.[0]?.delta?.content;
      if (token) onToken(token);
    }
  }
}
document.querySelector('#clearChat').addEventListener('click', () => { history = []; messagesEl.innerHTML = ''; addMessage('assistant', 'Диалог очищен. Чем могу помочь?'); });
promptEl.addEventListener('input', () => { promptEl.style.height = 'auto'; promptEl.style.height = `${Math.min(promptEl.scrollHeight, 160)}px`; });
promptEl.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
form.addEventListener('submit', async event => {
  event.preventDefault(); const text = promptEl.value.trim(); if (!text) return;
  const maxTokens = maxTokensEl.value.trim();
  if (maxTokens && (!Number.isInteger(Number(maxTokens)) || Number(maxTokens) < 1 || Number(maxTokens) > 384000)) {
    maxTokensEl.focus();
    return;
  }
  const settings = {
    jsonMode: jsonModeEl.checked,
    maxTokens,
    stopSequence: stopSequenceEl.value.trim()
  };
  addMessage('user', text); history.push({ role: 'user', content: text }); promptEl.value = ''; promptEl.style.height = 'auto'; sendButton.disabled = true;
  const pending = addMessage('assistant', '');
  const answerBubble = pending.querySelector('.bubble');
  answerBubble.classList.add('typing');
  let answer = '';
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      model: modelEl.value,
      messages: history,
      ...settings
    }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Ошибка соединения'); }
    await readStream(response, token => { answer += token; answerBubble.textContent = answer; pending.scrollIntoView({ behavior: 'smooth', block: 'end' }); });
    answerBubble.classList.remove('typing');
    if (!answer) throw new Error('Сервис не вернул текст ответа.');
    history.push({ role: 'assistant', content: answer });
  } catch (error) { answerBubble.classList.remove('typing'); answerBubble.textContent = `Ошибка: ${error.message}`; } finally { sendButton.disabled = false; promptEl.focus(); }
});

