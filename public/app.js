const messagesEl = document.querySelector('#messages');
const form = document.querySelector('#chatForm');
const promptEl = document.querySelector('#prompt');
const modelEl = document.querySelector('#model');
const jsonModeEl = document.querySelector('#jsonMode');
const jsonModeStatusEl = document.querySelector('#jsonModeStatus');
const sendButton = document.querySelector('#sendButton');
const chatTitleEl = document.querySelector('#chatTitle');
const chatHistoryEl = document.querySelector('#chatHistory');
const newChatButton = document.querySelector('#newChat');
const compareChatsButton = document.querySelector('#compareChats');
const comparisonModal = document.querySelector('#comparisonModal');
const comparisonResult = document.querySelector('#comparisonResult');
const closeComparisonButton = document.querySelector('#closeComparison');
const welcomeMessage = 'Здравствуйте! Я готов помочь. Выберите модель справа и отправьте сообщение.';
const storageKey = 'deepseek-chat-conversations';
const defaultTemperature = 1;
let chats = loadChats();
let activeChatId = chats[0]?.id || createChat();

function selectedProvider() {
  return modelEl.selectedOptions[0]?.dataset.provider;
}

function loadChats() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    return Array.isArray(saved) ? saved.filter(chat => chat?.id && Array.isArray(chat.messages)) : [];
  } catch { return []; }
}
function saveChats() {
  localStorage.setItem(storageKey, JSON.stringify(chats));
}
function createChat() {
  const chat = {
    id: crypto.randomUUID(), title: 'Новый чат',
    messages: [{ role: 'assistant', content: welcomeMessage }], history: [],
    model: modelEl.value, provider: selectedProvider(), lastTemperature: defaultTemperature
  };
  chats.unshift(chat); saveChats(); return chat.id;
}
function currentChat() { return chats.find(chat => chat.id === activeChatId); }
function restoreChatModel(chat) {
  if (!chat?.model) return;
  const option = [...modelEl.options].find(item => item.value === chat.model && item.dataset.provider === chat.provider);
  if (option) modelEl.value = option.value;
}

function modelLabel(chat) {
  const option = [...modelEl.options].find(item => item.value === chat?.model && item.dataset.provider === chat?.provider);
  return option?.textContent.trim() || chat?.model || 'Модель не сохранена';
}
function chatSettings(chat) {
  const temperature = Number.isFinite(Number(chat?.lastTemperature)) ? Number(chat.lastTemperature) : defaultTemperature;
  return { model: modelLabel(chat), temperature };
}
function displayTitle(chat) {
  const firstPrompt = chat?.history?.find(message => message.role === 'user')?.content;
  if (!firstPrompt) return 'Новый чат · 0 сообщений';
  const prompt = String(chat.title && chat.title !== 'Новый чат' ? chat.title : firstPrompt)
    .replace(/\s+/g, ' ').slice(0, 42);
  return `${prompt} · ${chat.history.length} сообщений`;
}
function renderChatTitle(chat) {
  const title = document.createElement('span');
  title.textContent = displayTitle(chat).replace(/ · \d+ сообщений$/, '');
  const count = document.createElement('span');
  count.className = 'chat-memory-count';
  count.textContent = ' · ' + (chat.history?.length || 0) + ' сообщений';
  chatTitleEl.replaceChildren(title, count);
}
function renderHistory() {
  chatHistoryEl.innerHTML = '';
  chats.forEach(chat => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `history-chat${chat.id === activeChatId ? ' active' : ''}`;
    button.title = displayTitle(chat);
    const label = document.createElement('span'); label.className = 'history-chat-title';
    label.textContent = displayTitle(chat).replace(/ · \d+ сообщений$/, '');
    const count = document.createElement('span'); count.className = 'memory-count';
    count.textContent = String(chat.history?.length || 0); count.title = 'Сообщений в памяти';
    button.append(label, count);
    button.addEventListener('click', () => { activeChatId = chat.id; renderChat(); renderHistory(); });
    const row = document.createElement('div');
    row.className = 'history-chat-row';
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'delete-chat'; remove.textContent = '×';
    remove.title = 'Удалить чат';
    remove.setAttribute('aria-label', 'Удалить чат: ' + label.textContent);
    remove.disabled = chat.messages.some(message => message.pending);
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        const response = await apiFetch('/api/chat/reset', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: chat.id })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Не удалось удалить чат.');
        chats = chats.filter(item => item.id !== chat.id);
        if (activeChatId === chat.id) {
          activeChatId = chats[0]?.id || createChat();
          renderChat();
        }
        saveChats(); renderHistory();
      } catch (error) { window.alert(error.message); remove.disabled = false; }
    });
    row.append(button, remove);
    chatHistoryEl.append(row);
  });
}
function renderChat() {
  const chat = currentChat();
  if (!chat) return;
  restoreChatModel(chat);
  renderChatTitle(chat);
  messagesEl.innerHTML = '';
  chat.messages.forEach(message => addMessage(message.role, message.content, message.pending));
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function chatTranscript(chat) {
  const settings = chatSettings(chat);
  const lines = chat.messages
    .filter(message => !message.pending && message.content && message.content !== welcomeMessage)
    .map(message => `${message.role === 'user' ? 'Пользователь' : 'Модель'}: ${message.content}`);
  return `Условия запроса: модель — ${settings.model}; температура — ${settings.temperature.toFixed(1)}.\nДиалог:\n${lines.join('\n\n')}`;
}
function comparisonPrompt(chatsToCompare) {
  const settings = chatsToCompare.map(chatSettings);
  const models = new Set(settings.map(item => item.model));
  const temperatures = new Set(settings.map(item => item.temperature));
  const changedParameters = [
    ...(models.size > 1 ? ['модель'] : []),
    ...(temperatures.size > 1 ? ['температура'] : [])
  ];
  return [
    'Ты выступаешь независимым экспертом по качеству ответов. Сравни ответы в приведённых ниже условиях запроса.',
    changedParameters.length
      ? `Менялись параметры: ${changedParameters.join(' и ')}. Построй ответ по этим параметрам, а не по номерам или названиям чатов.`
      : 'Параметры модели и температуры не менялись. Сравни ответы по сути, не вводя номера или названия чатов.',
    'Для каждого условия явно укажи модель и температуру в формате «Модель …, температура …: результат …». Затем кратко определи различия по сути, точность и полноту. Если данных недостаточно, прямо скажи об этом. Ответь по-русски.',
    '',
    ...chatsToCompare.map(chatTranscript)
  ].join('\n');
}

function setJsonModeStatus() {
  jsonModeStatusEl.value = jsonModeEl.checked ? 'Включен' : 'Выключен';
}
jsonModeEl.addEventListener('change', setJsonModeStatus);

modelEl.addEventListener('change', () => {
  const chat = currentChat();
  if (chat) {
    chat.model = modelEl.value;
    chat.provider = selectedProvider();
    chat.lastTemperature = defaultTemperature;
    saveChats();
    renderHistory();
    renderChatTitle(chat);
  }

});



function addMessage(role, content, pending = false) {
  const item = document.createElement('article'); item.className = `message ${role}`;
  const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = role === 'assistant' ? 'AI' : 'Я';
  const bubble = document.createElement('div'); bubble.className = `bubble${pending ? ' typing' : ''}`; bubble.textContent = content;
  item.append(avatar, bubble); messagesEl.append(item); return item;
}
async function apiFetch(path, options) {
  try {
    return await fetch(path, options);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('Сервер недоступен. Запустите его командой «node server.js» и откройте http://localhost:3000.');
    }
    throw error;
  }
}
async function readStream(response, onToken) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error('Соединение прервано до сохранения ответа.');
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      const chunk = JSON.parse(data);
      if (chunk.error) throw new Error(chunk.error);
      const token = chunk.choices?.[0]?.delta?.content;
      if (token) onToken(token);
    }
  }
}
newChatButton.addEventListener('click', () => { activeChatId = createChat();  renderChat(); renderHistory(); promptEl.focus(); });
closeComparisonButton.addEventListener('click', () => { comparisonModal.hidden = true; });
comparisonModal.addEventListener('click', event => { if (event.target === comparisonModal) comparisonModal.hidden = true; });
compareChatsButton.addEventListener('click', async () => {
  const chatsWithAnswers = chats.filter(chat => chat.messages.some(message => message.role === 'assistant' && message.content && message.content !== welcomeMessage));
  comparisonModal.hidden = false;
  if (!chatsWithAnswers.length) {
    comparisonResult.textContent = 'Пока нет ответов для сравнения. Отправьте сообщения хотя бы в одном чате.';
    return;
  }
  comparisonResult.textContent = 'Модель сравнивает ответы…';
  compareChatsButton.disabled = true;
  let result = '';
  try {
    const response = await apiFetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      model: modelEl.value,
      provider: selectedProvider(),
      message: comparisonPrompt(chatsWithAnswers),
      ephemeral: true,
      jsonMode: false,
      temperature: defaultTemperature,

    }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Ошибка соединения'); }
    await readStream(response, token => { result += token; comparisonResult.textContent = result; });
    if (!result) throw new Error('Сервис не вернул текст сравнения.');
  } catch (error) { comparisonResult.textContent = `Не удалось выполнить сравнение: ${error.message}`; }
  finally { compareChatsButton.disabled = false; }
});
document.querySelector('#clearChat').addEventListener('click', async event => {
  const chat = currentChat(); if (!chat) return;
  event.currentTarget.disabled = true;
  try {
    const response = await apiFetch('/api/chat/reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: chat.id })
    });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Ошибка соединения'); }
    chat.lastTemperature = defaultTemperature;
    chat.model = modelEl.value; chat.provider = selectedProvider();
    chat.title = 'Новый чат'; chat.history = []; chat.messages = [{ role: 'assistant', content: 'Диалог очищен. Чем могу помочь?' }];
    saveChats(); renderChat(); renderHistory();
  } catch (error) {
    window.alert(`Не удалось очистить диалог: ${error.message}`);
  } finally {
    document.querySelector('#clearChat').disabled = false;
  }
});
promptEl.addEventListener('input', () => { promptEl.style.height = 'auto'; promptEl.style.height = `${Math.min(promptEl.scrollHeight, 160)}px`; });
promptEl.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
form.addEventListener('submit', async event => {
  event.preventDefault(); if (sendButton.disabled) return; const text = promptEl.value.trim(); if (!text) return;
  const settings = {
    jsonMode: jsonModeEl.checked,
    temperature: defaultTemperature,

  };
  const chat = currentChat(); if (!chat) return;
  chat.model = modelEl.value;
  chat.provider = selectedProvider();
  chat.lastTemperature = settings.temperature;
  const userMessage = { role: 'user', content: text };
  chat.messages.push(userMessage); chat.history.push(userMessage);
  if (chat.title === 'Новый чат') chat.title = text.replace(/\s+/g, ' ').slice(0, 42);
  const assistantMessage = { role: 'assistant', content: '', pending: true };
  chat.messages.push(assistantMessage); saveChats();
  const isActive = () => activeChatId === chat.id;
  if (isActive()) { addMessage('user', text); addMessage('assistant', '', true); messagesEl.scrollTop = messagesEl.scrollHeight; }
  promptEl.value = ''; promptEl.style.height = 'auto'; sendButton.disabled = true; renderHistory(); renderChatTitle(chat);
  let answer = '';
  try {
    const response = await apiFetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      conversationId: chat.id,
      model: modelEl.value,
      provider: selectedProvider(),
      message: text,
      ...settings
    }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Ошибка соединения'); }
    await readStream(response, token => {
      answer += token; assistantMessage.content = answer;
      if (isActive()) {
        const follow = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
        messagesEl.lastElementChild.querySelector('.bubble').textContent = answer;
        if (follow) messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    });
    if (!answer) throw new Error('Сервис не вернул текст ответа.');
    chat.history.push({ role: 'assistant', content: answer });
  } catch (error) { chat.history.pop(); assistantMessage.content = `Ошибка: ${error.message}`; }
  finally {
    assistantMessage.pending = false; saveChats();
    if (isActive()) {
      const follow = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
      const bubble = messagesEl.lastElementChild.querySelector('.bubble');
      bubble.textContent = assistantMessage.content;
      bubble.classList.remove('typing');
      if (follow) messagesEl.scrollTop = messagesEl.scrollHeight;
      renderChatTitle(chat);
      promptEl.focus({ preventScroll: true });
    }
    renderHistory();
    sendButton.disabled = false;
  }
});


document.querySelector('#clearAll').addEventListener('click', async () => {
  const button = document.querySelector('#clearAll'); button.disabled = true;
  try {
    const response = await apiFetch('/api/chats/clear', { method: 'POST' });
    if (!response.ok) throw new Error((await response.json()).error);
    localStorage.removeItem(storageKey); sessionStorage.removeItem(storageKey);
    chats = []; activeChatId = createChat();
    comparisonResult.textContent = ''; comparisonModal.hidden = true;
    promptEl.value = ''; renderChat(); renderHistory();
  } catch (error) { window.alert(error.message); }
  finally { button.disabled = false; }
});
async function initialize() {
  sendButton.disabled = true;
  try {
    const response = await apiFetch('/api/chats');
    if (!response.ok) throw new Error('Не удалось загрузить историю.');
    const data = await response.json();
    chats = data.chats.map(chat => ({
      id: chat.id, title: chat.messages.find(message => message.role === 'user')?.content.slice(0, 42) || 'Новый чат',
      messages: chat.messages, history: [...chat.messages],
      model: chat.settings.model, provider: chat.settings.provider, lastTemperature: chat.settings.temperature
    }));
    activeChatId = chats[0]?.id || createChat();
    saveChats(); renderChat(); renderHistory(); sendButton.disabled = false;
  } catch (error) { addMessage('assistant', error.message + ' Перезагрузите страницу для повторной попытки.'); }
}
initialize();
