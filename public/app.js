const messagesEl = document.querySelector('#messages');
const form = document.querySelector('#chatForm');
const promptEl = document.querySelector('#prompt');
const modelEl = document.querySelector('#model');
const temperatureEl = document.querySelector('#temperature');
const temperatureValueEl = document.querySelector('#temperatureValue');
const jsonModeEl = document.querySelector('#jsonMode');
const jsonModeStatusEl = document.querySelector('#jsonModeStatus');
const maxTokensEl = document.querySelector('#maxTokens');
const stopSequenceEl = document.querySelector('#stopSequence');
const sendButton = document.querySelector('#sendButton');
const chatTitleEl = document.querySelector('#chatTitle');
const chatHistoryEl = document.querySelector('#chatHistory');
const newChatButton = document.querySelector('#newChat');
const compareChatsButton = document.querySelector('#compareChats');
const comparisonModal = document.querySelector('#comparisonModal');
const comparisonResult = document.querySelector('#comparisonResult');
const closeComparisonButton = document.querySelector('#closeComparison');
const requestTemperatureEl = document.querySelector('#requestTemperature');
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
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    return Array.isArray(saved) ? saved.filter(chat => chat?.id && Array.isArray(chat.messages)) : [];
  } catch { return []; }
}
function saveChats() {
  sessionStorage.setItem(storageKey, JSON.stringify(chats));
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
function restoreChatTemperature(chat) {
  const temperature = Number(chat?.lastTemperature);
  temperatureEl.value = Number.isFinite(temperature) ? temperature : defaultTemperature;
  setTemperature();
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
  if (!firstPrompt) return 'Новый чат';
  const settings = chatSettings(chat);
  const prompt = String(chat.title && chat.title !== 'Новый чат' ? chat.title : firstPrompt)
    .replace(/\s+/g, ' ').slice(0, 42);
  const parameters = [settings.model, ...(settings.temperature !== defaultTemperature ? [`t=${settings.temperature.toFixed(1)}`] : [])];
  return [...parameters, prompt].join(' · ');
}
function renderHistory() {
  chatHistoryEl.innerHTML = '';
  chats.forEach(chat => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `history-chat${chat.id === activeChatId ? ' active' : ''}`;
    button.title = displayTitle(chat); button.textContent = displayTitle(chat);
    button.addEventListener('click', () => { activeChatId = chat.id; renderChat(); renderHistory(); });
    chatHistoryEl.append(button);
  });
}
function renderChat() {
  const chat = currentChat();
  if (!chat) return;
  restoreChatModel(chat);
  restoreChatTemperature(chat);
  chatTitleEl.textContent = displayTitle(chat);
  setRequestTemperature(chat.lastTemperature);
  messagesEl.innerHTML = '';
  chat.messages.forEach(message => addMessage(message.role, message.content, message.pending));
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

function setTemperature() {
  const value = Number(temperatureEl.value);
  const percentage = ((value - Number(temperatureEl.min)) / (Number(temperatureEl.max) - Number(temperatureEl.min))) * 100;
  temperatureValueEl.value = value.toFixed(1);
  temperatureEl.style.background = `linear-gradient(90deg, var(--accent) ${percentage}%, #e2e3ea ${percentage}%)`;
}
function resetTemperature() {
  temperatureEl.value = defaultTemperature;
  setTemperature();
}
temperatureEl.addEventListener('input', () => {
  setTemperature();
  const chat = currentChat();
  if (chat) {
    chat.lastTemperature = Number(temperatureEl.value);
    saveChats();
    renderHistory();
    chatTitleEl.textContent = displayTitle(chat);
  }
});
modelEl.addEventListener('change', () => {
  const chat = currentChat();
  if (chat) {
    chat.model = modelEl.value;
    chat.provider = selectedProvider();
    chat.lastTemperature = defaultTemperature;
    saveChats();
    renderHistory();
    chatTitleEl.textContent = displayTitle(chat);
  }
  resetTemperature();
});

function setRequestTemperature(temperature) {
  const value = Number(temperature);
  const shouldShow = Number.isFinite(value) && value !== defaultTemperature;
  requestTemperatureEl.hidden = !shouldShow;
  requestTemperatureEl.textContent = shouldShow ? `temperature — ${value.toFixed(1)}` : '';
}

function addMessage(role, content, pending = false) {
  const item = document.createElement('article'); item.className = `message ${role}`;
  const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = role === 'assistant' ? 'AI' : 'Я';
  const bubble = document.createElement('div'); bubble.className = `bubble${pending ? ' typing' : ''}`; bubble.textContent = content;
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
newChatButton.addEventListener('click', () => { activeChatId = createChat(); resetTemperature(); renderChat(); renderHistory(); promptEl.focus(); });
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
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      model: modelEl.value,
      provider: selectedProvider(),
      messages: [{ role: 'user', content: comparisonPrompt(chatsWithAnswers) }],
      jsonMode: false,
      maxTokens: maxTokensEl.value.trim(),
      stopSequence: stopSequenceEl.value.trim()
    }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Ошибка соединения'); }
    await readStream(response, token => { result += token; comparisonResult.textContent = result; });
    if (!result) throw new Error('Сервис не вернул текст сравнения.');
  } catch (error) { comparisonResult.textContent = `Не удалось выполнить сравнение: ${error.message}`; }
  finally { compareChatsButton.disabled = false; }
});
document.querySelector('#clearChat').addEventListener('click', () => {
  const chat = currentChat(); if (!chat) return;
  chat.lastTemperature = Number(temperatureEl.value);
  chat.model = modelEl.value; chat.provider = selectedProvider();
  chat.title = 'Новый чат'; chat.history = []; chat.messages = [{ role: 'assistant', content: 'Диалог очищен. Чем могу помочь?' }];
  saveChats(); renderChat(); renderHistory();
});
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
    temperature: Number(temperatureEl.value),
    maxTokens,
    stopSequence: stopSequenceEl.value.trim()
  };
  const chat = currentChat(); if (!chat) return;
  chat.model = modelEl.value;
  chat.provider = selectedProvider();
  chat.lastTemperature = settings.temperature;
  setRequestTemperature(settings.temperature);
  const userMessage = { role: 'user', content: text };
  chat.messages.push(userMessage); chat.history.push(userMessage);
  if (chat.title === 'Новый чат') chat.title = text.replace(/\s+/g, ' ').slice(0, 42);
  const assistantMessage = { role: 'assistant', content: '', pending: true };
  chat.messages.push(assistantMessage); saveChats();
  const isActive = () => activeChatId === chat.id;
  let pending;
  if (isActive()) { addMessage('user', text); pending = addMessage('assistant', '', true); }
  promptEl.value = ''; promptEl.style.height = 'auto'; sendButton.disabled = true; renderHistory(); chatTitleEl.textContent = displayTitle(chat);
  let answer = '';
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      model: modelEl.value,
      provider: selectedProvider(),
      messages: chat.history,
      ...settings
    }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Ошибка соединения'); }
    await readStream(response, token => {
      answer += token; assistantMessage.content = answer;
      if (isActive() && pending) { const answerBubble = pending.querySelector('.bubble'); answerBubble.textContent = answer; pending.scrollIntoView({ behavior: 'smooth', block: 'end' }); }
    });
    if (!answer) throw new Error('Сервис не вернул текст ответа.');
    chat.history.push({ role: 'assistant', content: answer });
  } catch (error) { assistantMessage.content = `Ошибка: ${error.message}`; }
  finally {
    assistantMessage.pending = false; saveChats();
    if (isActive()) { renderChat(); renderHistory(); promptEl.focus(); }
    sendButton.disabled = false;
  }
});

renderChat();
renderHistory();
setTemperature();
