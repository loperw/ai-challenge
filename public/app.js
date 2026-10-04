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
const taskHistoryEl = document.querySelector('#taskHistory');
const createTaskButton = document.querySelector('#createTask');
const taskStageBar = document.querySelector('#taskStageBar');
const taskControls = document.querySelector('#taskControls');
const taskPrimaryAction = document.querySelector('#taskPrimaryAction');
const taskPauseButton = document.querySelector('#taskPause');
const revisePlanButton = document.querySelector('#revisePlan');
const storageKey = 'deepseek-chat-conversations';
const profileStorageKey = 'deepseek-active-profile';
const profileSelectEl = document.querySelector('#profileSelect');
const editProfileButton = document.querySelector('#editProfile');
const profileModal = document.querySelector('#profileModal');
const profileForm = document.querySelector('#profileForm');
const profileFormError = document.querySelector('#profileFormError');
const invariantModal = document.querySelector('#invariantModal');
const invariantForm = document.querySelector('#invariantForm');
const invariantInput = document.querySelector('#invariantInput');
const invariantScope = document.querySelector('#invariantScope');
const invariantList = document.querySelector('#invariantList');
const invariantFormError = document.querySelector('#invariantFormError');
const defaultTemperature = 1;
const maxTokensEl = document.querySelector('#maxTokens');
const keepMessagesEl = document.querySelector('#keepMessages');
const strategyEl = document.querySelector('#contextStrategy');
for (const [element, key] of [[keepMessagesEl, 'keepMessages'], [strategyEl, 'contextStrategy']]) {
  element.addEventListener('input', () => {
    const chat = currentChat();
    if (chat) { chat[key] = element.value; saveChats(); renderContextControls(); }
  });
}
const { estimateTokens, estimateHistory } = TokenCounter;

function renderTokenStats() {
  const chat = currentChat();
  if (!chat) return;
  const stats = chat.tokenStats;
  const pending = chat.messages.find(message => message.pending);
  const request = promptEl.value.trim() || chat.history?.findLast(message => message.role === 'user')?.content || '';
  const display = (id, value) => { document.querySelector(id).textContent = value; };
  const count = (actual, estimate) => actual != null ? actual.toLocaleString('ru-RU') : estimate != null ? `≈${estimate.toLocaleString('ru-RU')}` : '—';
  display('#requestTokens', count(null, estimateTokens(request)));
  display('#historyTokens', count(null, estimateHistory(chat.history) + (pending ? estimateTokens(pending.content) : 0)));
  display('#inputTokens', pending ? '…' : count(stats?.inputTokens, stats?.inputEstimate));
  display('#outputTokens', pending ? count(null, estimateTokens(pending.content)) : count(stats?.outputTokens, stats?.outputEstimate));
  display('#totalTokens', pending ? '…' : count(stats?.totalTokens, stats ? (stats.inputTokens ?? stats.inputEstimate) + (stats.outputTokens ?? stats.outputEstimate) : null));
  const turns = chat.context?.turns || [];
  const lastTurn = turns.at(-1);
  const afterSummary = turns.findLast(turn => turn.summaryTokens > 0);
  display('#contextTokens', count(null, stats?.contextEstimate));
  display('#afterSummaryTokens', afterSummary ? count(afterSummary.estimated ? null : afterSummary.requestTokens, afterSummary.requestTokens) : '—');
  display('#summaryTokens', lastTurn ? count(lastTurn.estimated ? null : lastTurn.summaryTokens, lastTurn.summaryTokens) : '—');
  display('#summarizedCount', Object.keys(chat.context?.facts || {}).length);
  display('#summaryText', JSON.stringify(chat.context?.facts || {}, null, 2));
  renderTokenChart(turns);
  display('#tokenBehavior', pending ? 'Модель отвечает… Оценка обновляется по мере генерации.'
    : stats?.limited ? `Последний ответ остановлен по лимиту токенов${stats.maxTokens ? ` (бюджет диалога ${stats.maxTokens}, на ответ ${stats.responseLimit ?? "—"})` : ''}. Он может быть неполным; увеличьте лимит и повторите запрос.`
    : stats ? `Причина завершения: ${stats.finishReason || 'API не сообщил'}. Бюджет диалога: ${stats.maxTokens ?? 'без общего лимита'}. На последний ответ: ${stats.responseLimit ?? 'по умолчанию модели'}.`
    : 'Отправьте запрос, чтобы увидеть фактический расход API.');
}
function renderTokenChart(turns) {
  const chart = document.querySelector('#tokenChart');
  const tooltip = document.querySelector('#chartTooltip');
  const maximum = Math.max(1, ...turns.map(turn => turn.requestTokens + turn.summaryTokens));
  document.querySelector('#chartScale').textContent = turns.length ? `Шкала: 0 — ${maximum.toLocaleString('ru-RU')} токенов` : '';
  chart.replaceChildren();
  tooltip.textContent = turns.length ? 'Наведите курсор на столбец для подробностей.' : 'Здесь появится первый ход.';
  turns.forEach((turn, index) => {
    const column = document.createElement('button');
    column.type = 'button'; column.className = 'token-column';
    const description = `Ход ${index + 1}: ${turn.estimated ? '≈' : ''}${(turn.requestTokens + turn.summaryTokens).toLocaleString('ru-RU')} токенов. Запрос и ответ: ${turn.requestTokens}. Обновление facts: ${turn.summaryTokens}.`;
    column.title = description; column.setAttribute('aria-label', description);
    const track = document.createElement('span'); track.className = 'token-track';
    for (const [kind, value] of [['request', turn.requestTokens], ['summary', turn.summaryTokens]]) {
      const fill = document.createElement('span'); fill.className = `token-fill ${kind}`;
      fill.style.height = `${100 * value / maximum}%`; track.append(fill);
    }
    const label = document.createElement('span'); label.textContent = index + 1;
    column.append(track, label);
    for (const event of ['mouseenter', 'focus', 'click']) column.addEventListener(event, () => { tooltip.textContent = description; });
    chart.append(column);
  });
}
maxTokensEl.addEventListener('input', () => {
  const chat = currentChat();
  if (chat) { chat.maxTokens = maxTokensEl.value; saveChats(); }
});
promptEl.addEventListener('input', renderTokenStats);
let chats = loadChats();
let tasks = [];
let globalInvariants = chats.flatMap(chat => chat.invariants || []).filter(item => item?.scope === 'global');
let longTermMemory = chats.find(chat => chat.memory?.longTerm)?.memory.longTerm || [];
let profiles = [];
let selectedProfileId = '';
let editingProfileId = '';
let activeChatId = chats[0]?.id || createChat();
let activeTaskId = '';
let activeMode = 'chat';
let sidePanel = 'primary';

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
    messages: [], history: [], invariants: structuredClone(globalInvariants || []), memory: { shortTerm: [], working: [], longTerm: structuredClone(longTermMemory || []) },
    model: modelEl.value, provider: selectedProvider(), lastTemperature: defaultTemperature,
    profileId: selectedProfileId
  };
  chats.unshift(chat); saveChats(); return chat.id;
}
function currentTask() { return tasks.find(task => task.id === activeTaskId); }
function currentChat() { return activeMode === 'task' ? currentTask() : chats.find(chat => chat.id === activeChatId); }

function renderProfiles() {
  profileSelectEl.replaceChildren();
  if (!profiles.length) {
    const option = document.createElement('option');
    option.value = ''; option.textContent = 'Профиль не выбран'; profileSelectEl.append(option);
    selectedProfileId = '';
  } else {
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Профиль не выбран'; profileSelectEl.append(empty);
    for (const profile of profiles) {
      const option = document.createElement('option');
      option.value = profile.id; option.textContent = profile.name; profileSelectEl.append(option);
    }
    if (selectedProfileId && !profiles.some(profile => profile.id === selectedProfileId)) selectedProfileId = '';
    profileSelectEl.value = selectedProfileId;
  }
  if (selectedProfileId) localStorage.setItem(profileStorageKey, selectedProfileId);
  else localStorage.removeItem(profileStorageKey);
  editProfileButton.disabled = !selectedProfileId;
}

function openProfileModal(profile = null) {
  editingProfileId = profile?.id || '';
  document.querySelector('#profileModalTitle').textContent = profile ? 'Редактировать профиль' : 'Новый профиль';
  document.querySelector('#saveProfile').textContent = profile ? 'Сохранить изменения' : 'Создать профиль';
  document.querySelector('#deleteProfile').hidden = !profile;
  for (const [id, value] of [
    ['#profileName', profile?.name], ['#profileOccupation', profile?.occupation],
    ['#profileLanguage', profile?.language], ['#profileResponseFormat', profile?.responseFormat],
    ['#profileConstraints', profile?.constraints]
  ]) document.querySelector(id).value = value || '';
  profileFormError.textContent = '';
  profileModal.hidden = false;
  document.querySelector('#profileName').focus();
}

function closeProfileModal() {
  profileModal.hidden = true;
  editingProfileId = '';
  profileForm.reset();
  profileFormError.textContent = '';
}
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
  if (chat?.name && Object.hasOwn(chat, 'stage')) return chat.name;
  const firstPrompt = chat?.history?.find(message => message.role === 'user')?.content;
  if (!firstPrompt) return 'Новый чат · 0 сообщений';
  const prompt = String(chat.title && chat.title !== 'Новый чат' ? chat.title : firstPrompt)
    .replace(/\s+/g, ' ').slice(0, 42);
  return `${prompt} · ${chat.history.length} сообщений`;
}
function isTaskInstructionMessage(message) {
  if (message?.role !== 'user') return false;
  return /^(?:Составь план работы над запросом:|Сформируй практический план задачи|Подготовь способ выполнения пользовательской задачи|План задачи «|Выполни текущий шаг задачи «|Проверь итог задачи «|Пересмотри (?:план|способ выполнения))/i.test(message.content || '');
}
function taskInstructionLabel(message) {
  const content = message?.content || '';
  if (/^(?:Составь план работы над запросом:|Сформируй практический план задачи|Подготовь способ выполнения пользовательской задачи)/i.test(content)) return 'Сформировать план';
  if (/^План задачи «/i.test(content)) return 'Утвердить план';
  const step = content.match(/^Выполни текущий шаг задачи .*?: шаг (\d+)/i)?.[1];
  if (step) return `Выполнить шаг ${step}`;
  if (/^Проверь итог задачи «/i.test(content)) return 'Проверить результат';
  if (/^Пересмотри (?:план|способ выполнения)/i.test(content)) return 'Пересмотреть план';
  return '';
}
function visibleMessages(chat) {
  return (chat?.messages || []).flatMap(message => {
    if (message.hidden) return [];
    if (chat?.stage && isTaskInstructionMessage(message)) return [{ role: 'user', content: taskInstructionLabel(message), actionMessage: true }];
    return [message];
  });
}
function renderChatTitle(chat) {
  const title = document.createElement('span');
  title.textContent = displayTitle(chat).replace(/ · \d+ сообщений$/, '');
  const count = document.createElement('span');
  count.className = 'chat-memory-count';
  count.textContent = ' · ' + visibleMessages(chat).length + ' сообщений';
  const branchName = chat.contextStrategy === 'branching' && chat.context?.branches?.[chat.context.activeBranch]?.name;
  if (branchName && activeMode === 'chat') title.textContent += ' · ' + branchName;
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
    button.addEventListener('click', () => { activeMode = 'chat'; activeChatId = chat.id; selectedProfileId = chat.profileId || ''; renderProfiles(); renderChat(); renderHistory(); renderTaskHistory(); });
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
  maxTokensEl.value = chat.maxTokens ?? '';
  keepMessagesEl.value = chat.keepMessages ?? 4;
  strategyEl.value = chat.contextStrategy ?? 'sliding';
  renderContextControls();
  renderTokenStats();
  renderChatTitle(chat);
  renderInvariantControl();
  renderWorkspaceMode();
  renderMcpTrace();
  messagesEl.innerHTML = '';
  visibleMessages(chat).forEach(message => addMessage(message.role, message.content, message.pending, message.memoryCommand, message.memoryType, message.invariantRefusal, message.files, message.documentSearch, message.ragMode));
  if (!visibleMessages(chat).length) {
    const empty = document.createElement('div'); empty.className = 'empty-chat'; empty.textContent = 'Чем помочь?'; messagesEl.append(empty);
  }
  renderMemory();
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function renderInvariantControl() {
  const chat = currentChat();
  const count = Array.isArray(chat?.invariants) ? chat.invariants.length : 0;
  document.querySelector('#invariantCount').textContent = String(count);
  document.querySelector('#openInvariants').classList.toggle('has-invariants', count > 0);
  document.querySelector('#openInvariants').title = count
    ? `Задано инвариантов: ${count}. Нажмите, чтобы изменить.`
    : 'Задать непреложные ограничения';
}
function stageLabel(stage) {
  return { planning: 'Планирование', awaiting_approval: 'Утверждение плана', execution: 'Выполнение', validation: 'Проверка', paused: 'Пауза', done: 'Готово' }[stage] || stage;
}
function renderWorkspaceMode() {
  const task = currentTask();
  const isTask = activeMode === 'task' && task;
  document.querySelector('#entityKind').textContent = isTask ? 'ЗАДАЧА' : 'ЧАТ';
  document.querySelector('#clearChat').textContent = isTask ? 'Удалить задачу' : 'Очистить';
  createTaskButton.hidden = Boolean(isTask);
  taskControls.hidden = !isTask;
  taskStageBar.hidden = !isTask;
  document.querySelector('#settingsTabButton').textContent = isTask ? 'Процесс' : 'Настройки';
  document.querySelector('#memoryTabButton').textContent = isTask ? 'Память' : 'Память агента';
  document.querySelector('#settingsTabButton').setAttribute('aria-controls', isTask ? 'processTab' : 'settingsTab');
  document.querySelector('#settingsTab').hidden = isTask || sidePanel !== 'primary';
  document.querySelector('#processTab').hidden = !isTask || sidePanel !== 'primary';
  document.querySelector('#memoryTab').hidden = sidePanel !== 'memory';
  document.querySelector('#mcpTab').hidden = sidePanel !== 'mcp';
  document.querySelector('#monitorTab').hidden = sidePanel !== 'monitor';
  document.querySelector('#indexesTab').hidden = sidePanel !== 'indexes';
  document.querySelector('#indexesTabButton').classList.toggle('active', sidePanel === 'indexes');
  document.querySelector('#indexesTabButton').setAttribute('aria-selected', String(sidePanel === 'indexes'));
  document.querySelector('#monitorTabButton').classList.toggle('active', sidePanel === 'monitor');
  document.querySelector('#monitorTabButton').setAttribute('aria-selected', String(sidePanel === 'monitor'));
  document.querySelector('#settingsTabButton').classList.toggle('active', sidePanel === 'primary');
  document.querySelector('#memoryTabButton').classList.toggle('active', sidePanel === 'memory');
  document.querySelector('#mcpTabButton').classList.toggle('active', sidePanel === 'mcp');
  document.querySelector('#settingsTabButton').setAttribute('aria-selected', String(sidePanel === 'primary'));
  document.querySelector('#memoryTabButton').setAttribute('aria-selected', String(sidePanel === 'memory'));
  document.querySelector('#mcpTabButton').setAttribute('aria-selected', String(sidePanel === 'mcp'));
  promptEl.disabled = Boolean(isTask && task.paused);
  if (isTask && task.paused) sendButton.disabled = true;
  else if (isTask && !task.busyAction && !task.messages.some(message => message.pending)) sendButton.disabled = false;
  if (isTask) renderProcess();
}
function renderProcess() {
  const task = currentTask(); if (!task) return;
  const hasPendingResponse = task.messages.some(message => message.pending);
  const stages = [
    ['planning', 'Планирование', '◇'], ['awaiting_approval', 'Утверждение', '○'], ['execution', 'Выполнение', '▶'],
    ['validation', 'Проверка', '◎'], ['done', 'Готово', '✓']
  ];
  const visibleStage = task.stage === 'paused' ? task.resumeStage : task.stage;
  const activeIndex = stages.findIndex(([id]) => id === visibleStage);
  const track = document.createElement('div'); track.className = 'task-stage-track';
  stages.forEach(([id, label, icon], index) => {
    const item = document.createElement('div');
    item.className = `task-stage${index < activeIndex || visibleStage === 'done' ? ' complete' : ''}${index === activeIndex ? ' active' : ''}${index === activeIndex && task.paused ? ' paused' : ''}`;
    const mark = document.createElement('span'); mark.className = 'task-stage-icon'; mark.textContent = index < activeIndex || task.stage === 'done' ? '✓' : task.paused && index === activeIndex ? '||' : icon;
    const text = document.createElement('span'); text.textContent = label; item.append(mark, text); track.append(item);
  });
  const caption = document.createElement('p'); caption.className = 'task-stage-caption';
  caption.textContent = `${task.paused ? 'Пауза · ' : ''}${task.activity} Текущий шаг: ${Math.min(task.currentStep + 1, Math.max(task.plan.length, 1))}.`;
  taskStageBar.replaceChildren(track, caption);
  document.querySelector('#processTaskName').textContent = task.name;
  document.querySelector('#processStage').textContent = stageLabel(task.stage);
  document.querySelector('#processStep').textContent = task.plan.length ? `${Math.min(task.currentStep + 1, task.plan.length)} из ${task.plan.length}` : 'План ещё не создан';
  document.querySelector('#processExpected').textContent = task.expectedAction;
  const activity = document.querySelector('#processActivity'); activity.textContent = task.busyAction ? `Выполняется… ${task.busyLabel || task.expectedAction}` : task.activity;
  activity.classList.toggle('running', Boolean(task.busyAction));
  const icon = document.querySelector('#processStatusIcon'); icon.textContent = task.paused ? '||' : task.busyAction ? '▶' : visibleStage === 'done' ? '✓' : stages[activeIndex]?.[2] || '◇';
  icon.className = `settings-icon process-icon${task.busyAction ? ' running' : ''}${task.paused ? ' paused' : ''}`;
  const list = document.querySelector('#planList'); list.replaceChildren();
  if (!task.plan.length) {
    const empty = document.createElement('li'); empty.className = 'plan-empty'; empty.textContent = 'План появится после первого действия.'; list.append(empty);
  } else task.plan.forEach((step, index) => {
    const item = document.createElement('li'); item.textContent = step.title;
    item.className = `${step.done ? 'done' : ''}${task.stage === 'execution' && index === task.currentStep ? ' current' : ''}`; list.append(item);
  });
  document.querySelector('#planProgress').textContent = `${task.plan.filter(step => step.done).length} / ${task.plan.length}`;
  taskPrimaryAction.textContent = task.expectedAction;
  taskPrimaryAction.disabled = task.paused || task.stage === 'done' || Boolean(task.busyAction) || hasPendingResponse;
  taskPauseButton.textContent = task.paused ? 'Продолжить' : task.pauseRequested ? 'Пауза запрошена' : 'Пауза';
  taskPauseButton.disabled = task.stage === 'done' || Boolean(task.pauseRequested) || (hasPendingResponse && !task.busyAction);
  revisePlanButton.disabled = task.paused || task.stage === 'done' || !task.plan.length || Boolean(task.busyAction) || hasPendingResponse;
}
function chatTranscript(chat) {
  const settings = chatSettings(chat);
  const lines = chat.messages
    .filter(message => !message.hidden && !message.pending && message.content && !message.memoryCommand)
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



function setInvariantRefusalMark(item, enabled) {
  item.classList.toggle('invariant-refusal', enabled);
  const body = item.querySelector('.message-body');
  if (!body) return;
  const currentBadge = body.querySelector('.invariant-refusal-badge');
  if (!enabled) {
    currentBadge?.remove();
    return;
  }
  if (currentBadge) return;
  const badge = document.createElement('span');
  badge.className = 'invariant-refusal-badge';
  badge.textContent = 'Запрос не выполнен · конфликт с инвариантом';
  body.insertBefore(badge, body.querySelector('.bubble'));
}

function addMessage(role, content, pending = false, memoryCommand = false, memoryType = '', invariantRefusal = false, files = [], documentSearch = null, ragMode = null) {
  const item = document.createElement('article'); item.className = `message ${role}${memoryCommand ? ' memory-command' : ''}`;
  const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = role === 'assistant' ? 'A' : 'Я';
  const bubble = document.createElement('div'); bubble.className = `bubble${pending ? ' typing' : ''}`; bubble.textContent = content;
  if (memoryCommand) {
    const badge = document.createElement('span'); badge.className = 'memory-command-badge'; badge.textContent = 'Команда памяти';
    bubble.dataset.memoryType = memoryType; bubble.append(badge);
  }
  if (role === 'assistant') {
    const body = document.createElement('div'); body.className = 'message-body';
    const author = document.createElement('span'); author.className = 'message-author'; author.textContent = 'Агент';
    body.append(author, bubble); item.append(avatar, body);
    renderFileCards(item, files);
    window.renderDocumentSources(body, documentSearch, ragMode);
    setInvariantRefusalMark(item, Boolean(invariantRefusal));
  } else item.append(avatar, bubble);
  messagesEl.append(item); return item;
}

const filePreviewModal = document.querySelector('#filePreviewModal');
let previewRequest;
let previewTrigger;
let previewReady = false;
let previewMode = 'document';

function setPreviewMode(mode) {
  previewMode = mode;
  document.querySelector('#filePreviewDocumentButton').setAttribute('aria-pressed', String(mode === 'document'));
  document.querySelector('#filePreviewSourceButton').setAttribute('aria-pressed', String(mode === 'source'));
  document.querySelector('#filePreviewContent').hidden = !previewReady || mode !== 'document';
  document.querySelector('#filePreviewSource').hidden = !previewReady || mode !== 'source';
}
document.querySelector('#filePreviewDocumentButton').addEventListener('click', () => setPreviewMode('document'));
document.querySelector('#filePreviewSourceButton').addEventListener('click', () => setPreviewMode('source'));

function fileLinks(file) {
  // Derive same-origin routes from the name; never trust stored link schemes.
  const url = `/api/files/${encodeURIComponent(file.name)}`;
  return { preview: url, download: `${url}?download=1` };
}
function renderFileCards(message, files = []) {
  const body = message.querySelector('.message-body');
  if (!body) return;
  body.querySelector('.message-files')?.remove();
  if (!files.length) return;
  const list = document.createElement('div'); list.className = 'message-files';
  for (const file of files) {
    if (!file || typeof file.name !== 'string') continue;
    const card = document.createElement('section'); card.className = 'file-card'; card.setAttribute('aria-label', `Файл ${file.name}`);
    const icon = document.createElement('span'); icon.className = 'file-type-icon'; icon.textContent = file.name.split('.').at(-1).toUpperCase(); icon.setAttribute('aria-hidden', 'true');
    const info = document.createElement('div'); info.className = 'file-info';
    const name = document.createElement('strong'); name.textContent = file.name;
    const meta = document.createElement('span'); meta.textContent = Number.isFinite(file.bytes)
      ? file.bytes < 1024 ? `${file.bytes} Б` : `${(file.bytes / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} КБ`
      : 'Текстовый файл';
    info.append(name, meta);
    const actions = document.createElement('div'); actions.className = 'file-actions';
    const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'file-action'; preview.textContent = 'Предпросмотр';
    preview.addEventListener('click', () => openFilePreview(file, preview));
    const download = document.createElement('a'); download.className = 'file-action file-download'; download.textContent = 'Скачать';
    download.href = fileLinks(file).download; download.download = file.name;
    actions.append(preview, download); card.append(icon, info, actions); list.append(card);
  }
  body.append(list);
}
async function openFilePreview(file, trigger) {
  previewRequest?.abort();
  const controller = new AbortController(); previewRequest = controller; previewTrigger = trigger;
  const status = document.querySelector('#filePreviewStatus');
  const content = document.querySelector('#filePreviewContent');
  const source = document.querySelector('#filePreviewSource');
  previewReady = false; setPreviewMode('document');
  source.textContent = '';
  document.querySelector('#filePreviewMeta').textContent = `${file.name.split('.').at(-1).toUpperCase()} · UTF-8`;
  document.querySelector('#filePreviewTitle').textContent = file.name;
  const download = document.querySelector('#filePreviewDownload');
  download.href = fileLinks(file).download; download.download = file.name;
  status.textContent = 'Загрузка…'; status.hidden = false;
  content.textContent = ''; content.hidden = true;
  if (!filePreviewModal.open) filePreviewModal.showModal();
  document.querySelector('#closeFilePreview').focus();
  try {
    const response = await apiFetch(fileLinks(file).preview, { signal: controller.signal });
    if (!response.ok) throw new Error('Файл недоступен или был удалён.');
    const text = await response.text();
    if (controller.signal.aborted) return;
    FilePreview.render(content, text);
    source.textContent = text;
    previewReady = true; setPreviewMode(previewMode); status.hidden = true;
  } catch (error) {
    if (!controller.signal.aborted) status.textContent = error.message;
  }
}
document.querySelector('#closeFilePreview').addEventListener('click', () => filePreviewModal.close());
filePreviewModal.addEventListener('close', () => { previewRequest?.abort(); previewTrigger?.focus(); });
filePreviewModal.addEventListener('click', event => {
  if (event.target !== filePreviewModal) return;
  const rect = filePreviewModal.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) filePreviewModal.close();
});

function renderMemoryItems(element, items, label) {
  element.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p'); empty.className = 'memory-empty'; empty.textContent = 'Пока пусто'; element.append(empty); return;
  }
  items.forEach(item => {
    const row = document.createElement('div'); row.className = 'memory-item';
    const meta = document.createElement('span'); meta.textContent = label(item);
    const content = document.createElement('p'); content.textContent = item.content;
    row.append(meta, content); element.append(row);
  });
}
function renderTaskHistory() {
  taskHistoryEl.replaceChildren();
  tasks.forEach(task => {
    const row = document.createElement('div'); row.className = 'history-chat-row';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `history-chat task-entry ${task.stage}${task.paused ? ' paused' : ''}${activeMode === 'task' && task.id === activeTaskId ? ' active' : ''}`;
    button.title = `${task.name} · ${task.expectedAction}`;
    const label = document.createElement('span'); label.className = 'history-chat-title'; label.textContent = task.name;
    const state = document.createElement('span'); state.className = 'memory-count'; state.textContent = task.paused ? 'Пауза' : task.stage === 'done' ? 'Готово' : `${task.currentStep + 1}`;
    button.append(label, state);
    button.addEventListener('click', () => {
      activeMode = 'task'; activeTaskId = task.id; selectedProfileId = task.profileId || '';
      renderProfiles(); renderChat(); renderHistory(); renderTaskHistory();
    });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'delete-chat'; remove.textContent = '×'; remove.title = 'Удалить задачу';
    remove.disabled = Boolean(task.busyAction || task.messages.some(message => message.pending));
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Удалить задачу «${task.name}» вместе с её памятью?`)) return;
      remove.disabled = true;
      try {
        const response = await apiFetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
        if (!response.ok) throw new Error((await response.json()).error || 'Не удалось удалить задачу.');
        tasks = tasks.filter(item => item.id !== task.id);
        if (activeTaskId === task.id) { activeMode = 'chat'; activeTaskId = ''; }
        renderProfiles(); renderChat(); renderHistory(); renderTaskHistory();
      } catch (error) { window.alert(error.message); remove.disabled = false; }
    });
    row.append(button, remove); taskHistoryEl.append(row);
  });
}

function renderMemory() {
  const chat = currentChat(); if (!chat) return;
  const shortTerm = (chat.memory?.shortTerm?.length ? chat.memory.shortTerm : chat.messages).flatMap(message => {
    if (message.hidden || !message.content || message.pending) return [];
    if (activeMode === 'task' && isTaskInstructionMessage(message)) return [{ role: 'user', content: taskInstructionLabel(message), actionMessage: true }];
    return [message];
  });
  const working = chat.memory?.working || [];
  const longTerm = chat.memory?.longTerm || longTermMemory || [];
  document.querySelector('#shortMemoryCount').textContent = shortTerm.length;
  document.querySelector('#workingMemoryCount').textContent = working.length;
  document.querySelector('#longMemoryCount').textContent = longTerm.length;
  renderMemoryItems(document.querySelector('#shortMemoryList'), shortTerm, item => item.memoryCommand ? 'Команда памяти' : item.role === 'user' ? 'Пользователь' : 'Агент');
  renderMemoryItems(document.querySelector('#workingMemoryList'), working, () => 'Текущая задача');
  renderMemoryItems(document.querySelector('#longMemoryList'), longTerm, () => activeMode === 'task' ? 'Эта задача' : 'Все чаты');
  const taskMode = activeMode === 'task';
  document.querySelector('#memoryTab .settings-title h2').textContent = taskMode ? 'Память задачи' : 'Память агента';
  document.querySelector('.memory-intro').innerHTML = taskMode
    ? 'Эта память и профиль принадлежат только выбранной задаче. Команды <code>/working</code> и <code>/long</code> не влияют на другие задачи.'
    : 'Команды <code>/working</code> и <code>/long</code> сохраняют информацию без запроса к модели.';
  document.querySelector('.short-memory .memory-description').textContent = taskMode ? 'Сообщения выбранной задачи' : 'Сообщения текущего диалога';
  document.querySelector('.working-memory .memory-description').textContent = taskMode ? 'Текущий этап, цели и ограничения задачи' : 'Цели и ограничения текущей задачи';
  document.querySelector('.long-memory .memory-description').textContent = taskMode ? 'Знания только этой задачи' : 'Профиль и знания для всех чатов';
}
document.querySelector('#settingsTabButton').addEventListener('click', () => { sidePanel = 'primary'; renderWorkspaceMode(); });
document.querySelector('#indexesTabButton').addEventListener('click', () => { sidePanel = 'indexes'; renderWorkspaceMode(); window.refreshDocumentIndexes(); });
document.querySelector('#memoryTabButton').addEventListener('click', () => { sidePanel = 'memory'; renderWorkspaceMode(); renderMemory(); });
document.querySelector('#mcpTabButton').addEventListener('click', () => { sidePanel = 'mcp'; renderWorkspaceMode(); renderMcpTrace(); });
document.querySelector('#mcpExample').addEventListener('click', () => {
  promptEl.value = 'Построй автомобильный маршрут из Москвы в Тулу, узнай погоду в Туле на 3 дня, объедини маршрут и прогноз, кратко подведи итог и сохрани в trip.md';
  promptEl.dispatchEvent(new Event('input')); promptEl.focus();
});

function jsonBlock(value) {
  const pre = document.createElement('pre'); pre.className = 'mcp-json';
  pre.textContent = JSON.stringify(value, null, 2); return pre;
}

function renderMcpTrace() {
  const root = document.querySelector('#mcpTrace');
  const trace = currentChat()?.mcpTrace;
  if (!trace) {
    root.innerHTML = '<div class="mcp-empty"><strong>Вызовов пока нет</strong><span>Отправьте запрос в Agent chat. Здесь появятся решения модели, аргументы и результаты всех вызовов.</span></div>';
    return;
  }
  root.replaceChildren();
  const header = document.createElement('div'); header.className = 'mcp-run-header';
  const identity = document.createElement('div');
  const label = document.createElement('span'); label.textContent = trace.servers?.length
    ? trace.servers.map(server => `${server.id}: ${server.status === 'connected' ? 'подключён' : 'недоступен'}`).join(' · ')
    : trace.server ? `${trace.server.name} · v${trace.server.version}` : 'MCP stdio · подключение';
  const tool = document.createElement('strong'); tool.textContent = trace.calls?.length
    ? trace.calls.map(call => call.name).join(' → ')
    : trace.status === 'done' ? 'Ответ без инструментов' : trace.tool?.name || 'Выбор инструмента…';
  identity.append(label, tool);
  const status = document.createElement('span'); status.className = `mcp-status ${trace.status}`;
  status.textContent = trace.status === 'done' ? 'Готово' : trace.status === 'error' ? 'Ошибка' : 'Вызов…';
  header.append(identity, status); root.append(header);
  if (trace.transfers?.length) {
    const details = document.createElement('details');
    const title = document.createElement('summary'); title.textContent = 'Передача данных между серверами';
    details.append(title, jsonBlock(trace.transfers)); root.append(details);
  }
  if (trace.error) { const error = document.createElement('p'); error.className = 'mcp-error'; error.textContent = trace.error; root.append(error); }
  const timeline = document.createElement('ol'); timeline.className = 'mcp-timeline';
  for (const [index, step] of (trace.steps || []).entries()) {
    const item = document.createElement('li'); item.className = `mcp-step ${step.status}`;
    const marker = document.createElement('span'); marker.className = 'mcp-step-marker';
    marker.textContent = step.status === 'done' ? '✓' : step.status === 'error' ? '!' : index + 1;
    const details = document.createElement('details'); details.open = ['running', 'error'].includes(step.status) || step.id === 'call' && trace.status === 'done';
    const summary = document.createElement('summary');
    const title = document.createElement('span'); title.textContent = step.title;
    const method = document.createElement('code'); method.textContent = step.method;
    summary.append(title, method); details.append(summary);
    const schemaTitle = document.createElement('p'); schemaTitle.className = 'mcp-data-label'; schemaTitle.textContent = 'Схема этапа';
    details.append(schemaTitle, jsonBlock(step.schema || {}));
    if (step.data !== undefined) {
      const dataTitle = document.createElement('p'); dataTitle.className = 'mcp-data-label'; dataTitle.textContent = step.id === 'call' ? 'Ответ MCP tool' : 'Фактические данные';
      details.append(dataTitle, jsonBlock(step.data));
    }
    if (step.error) { const message = document.createElement('p'); message.className = 'mcp-error'; message.textContent = step.error; details.append(message); }
    item.append(marker, details); timeline.append(item);
  }
  root.append(timeline);
}

function closeInvariantModal() {
  invariantModal.hidden = true;
  invariantFormError.textContent = '';
}
const invariantScopeLabels = {
  conversation: 'Текущий чат', task: 'Память задачи', stateMachine: 'State machine', global: 'Глобальная память'
};
function syncGlobalInvariants(records) {
  const globals = records.filter(item => item.scope === 'global');
  globalInvariants = structuredClone(globals);
  for (const entity of [...chats, ...tasks]) {
    entity.invariants = [...globals, ...(entity.invariants || []).filter(item => item.scope !== 'global')];
  }
}
function renderInvariantList() {
  const chat = currentChat();
  const records = Array.isArray(chat?.invariants) ? chat.invariants : [];
  document.querySelector('#invariantListCount').textContent = String(records.length);
  invariantList.replaceChildren();
  if (!records.length) {
    const empty = document.createElement('p'); empty.className = 'invariant-list-empty';
    empty.textContent = 'Инварианты пока не добавлены.'; invariantList.append(empty); return;
  }
  for (const invariant of records) {
    const row = document.createElement('article'); row.className = 'invariant-item';
    const scope = document.createElement('span'); scope.className = 'invariant-scope';
    scope.textContent = invariantScopeLabels[invariant.scope] || invariant.scope;
    const content = document.createElement('p'); content.textContent = invariant.content;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-invariant';
    remove.textContent = '×'; remove.title = 'Удалить инвариант'; remove.setAttribute('aria-label', `Удалить инвариант: ${invariant.content}`);
    remove.addEventListener('click', async () => {
      remove.disabled = true; invariantFormError.textContent = '';
      try {
        const response = await apiFetch(`/api/invariants/${invariant.id}`, { method: 'DELETE' });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Не удалось удалить инвариант.');
        for (const entity of [...chats, ...tasks]) entity.invariants = (entity.invariants || []).filter(item => item.id !== invariant.id);
        if (invariant.scope === 'global') globalInvariants = globalInvariants.filter(item => item.id !== invariant.id);
        saveChats(); renderInvariantList(); renderInvariantControl();
      } catch (error) { invariantFormError.textContent = error.message; remove.disabled = false; }
    });
    row.append(scope, content, remove); invariantList.append(row);
  }
}
function renderInvariantScopes() {
  const taskMode = activeMode === 'task';
  const scopes = taskMode
    ? [['task', 'Память этой задачи'], ['stateMachine', 'State machine задачи'], ['global', 'Глобальная память']]
    : [['conversation', 'Текущий чат'], ['global', 'Глобальная память']];
  invariantScope.replaceChildren(...scopes.map(([value, label]) => {
    const option = document.createElement('option'); option.value = value; option.textContent = label; return option;
  }));
}
document.querySelector('#openInvariants').addEventListener('click', () => {
  const chat = currentChat(); if (!chat) return;
  invariantInput.value = '';
  invariantFormError.textContent = '';
  renderInvariantScopes(); renderInvariantList();
  invariantModal.hidden = false;
  invariantInput.focus();
});
document.querySelector('#closeInvariants').addEventListener('click', closeInvariantModal);
document.querySelector('#cancelInvariants').addEventListener('click', closeInvariantModal);
invariantModal.addEventListener('click', event => { if (event.target === invariantModal) closeInvariantModal(); });
invariantForm.addEventListener('submit', async event => {
  event.preventDefault();
  const chat = currentChat(); if (!chat) return;
  const content = invariantInput.value.trim(); if (!content) { invariantInput.focus(); return; }
  const button = document.querySelector('#addInvariant');
  button.disabled = true; invariantFormError.textContent = '';
  try {
    const response = await apiFetch('/api/invariants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: chat.id, scope: invariantScope.value, content })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось сохранить инварианты.');
    chat.invariants = data.invariants;
    syncGlobalInvariants(data.invariants);
    invariantInput.value = ''; saveChats();
    renderInvariantList(); renderInvariantControl(); invariantInput.focus();
  } catch (error) { invariantFormError.textContent = error.message; }
  finally { button.disabled = false; }
});
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
async function readStream(response, onToken, onStats = () => {}, onMcpTrace = () => {}, onFile = () => {}) {
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
      if (chunk.mcpTrace) onMcpTrace(chunk.mcpTrace);
      if (chunk.fileCreated) onFile(chunk.fileCreated);
      if (chunk.scheduleCreated) { sidePanel = 'monitor'; renderWorkspaceMode(); refreshMonitoring(); }
      if (chunk.tokenStats) onStats(chunk.tokenStats, chunk.context, chunk.messages);
      const token = chunk.choices?.[0]?.delta?.content;
      if (token) onToken(token);
    }
  }
}
newChatButton.addEventListener('click', () => { activeMode = 'chat'; sidePanel = 'primary'; selectedProfileId = ''; activeChatId = createChat(); renderProfiles(); renderChat(); renderHistory(); renderTaskHistory(); promptEl.focus(); });
profileSelectEl.addEventListener('change', async () => {
  selectedProfileId = profileSelectEl.value;
  localStorage.setItem(profileStorageKey, selectedProfileId);
  const chat = currentChat();
  if (chat) {
    if (activeMode === 'task') {
      try {
        const response = await apiFetch(`/api/tasks/${chat.id}/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'SET_PROFILE', profileId: selectedProfileId }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error);
        Object.assign(chat, data.task);
      } catch (error) { window.alert(error.message); }
    } else { chat.profileId = selectedProfileId; saveChats(); }
  }
  editProfileButton.disabled = !selectedProfileId;
});
document.querySelector('#newProfile').addEventListener('click', () => openProfileModal());
editProfileButton.addEventListener('click', () => openProfileModal(profiles.find(profile => profile.id === selectedProfileId)));
document.querySelector('#closeProfile').addEventListener('click', closeProfileModal);
document.querySelector('#cancelProfile').addEventListener('click', closeProfileModal);
document.querySelector('#deleteProfile').addEventListener('click', async () => {
  const profile = profiles.find(item => item.id === editingProfileId);
  if (!profile || !window.confirm(`Удалить профиль «${profile.name}»? Это действие нельзя отменить.`)) return;
  const deleteButton = document.querySelector('#deleteProfile');
  deleteButton.disabled = true;
  profileFormError.textContent = '';
  try {
    const response = await apiFetch(`/api/profiles/${profile.id}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось удалить профиль.');
    profiles = profiles.filter(item => item.id !== profile.id);
    selectedProfileId = '';
    for (const chat of chats) {
      if (chat.profileId === profile.id) chat.profileId = selectedProfileId;
    }
    for (const task of tasks) if (task.profileId === profile.id) task.profileId = '';
    saveChats();
    renderProfiles();
    closeProfileModal();
  } catch (error) { profileFormError.textContent = error.message; }
  finally { deleteButton.disabled = false; }
});
profileModal.addEventListener('click', event => { if (event.target === profileModal) closeProfileModal(); });
profileForm.addEventListener('submit', async event => {
  event.preventDefault();
  const saveButton = document.querySelector('#saveProfile');
  const profile = Object.fromEntries(new FormData(profileForm));
  saveButton.disabled = true;
  profileFormError.textContent = '';
  try {
    const response = await apiFetch(editingProfileId ? `/api/profiles/${editingProfileId}` : '/api/profiles', {
      method: editingProfileId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось сохранить профиль.');
    const index = profiles.findIndex(item => item.id === data.profile.id);
    if (index >= 0) profiles[index] = data.profile;
    else profiles.unshift(data.profile);
    selectedProfileId = data.profile.id;
    const chat = currentChat();
    if (chat) {
      chat.profileId = selectedProfileId;
      if (activeMode === 'task') await apiFetch(`/api/tasks/${chat.id}/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'SET_PROFILE', profileId: selectedProfileId }) });
      else saveChats();
    }
    renderProfiles();
    closeProfileModal();
  } catch (error) { profileFormError.textContent = error.message; }
  finally { saveButton.disabled = false; }
});
closeComparisonButton.addEventListener('click', () => { comparisonModal.hidden = true; });
comparisonModal.addEventListener('click', event => { if (event.target === comparisonModal) comparisonModal.hidden = true; });
compareChatsButton.addEventListener('click', async () => {
  const chatsWithAnswers = chats.filter(chat => chat.messages.some(message => message.role === 'assistant' && message.content));
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
      profileId: selectedProfileId,
      jsonMode: false,
      temperature: defaultTemperature,

    }) });
    if (!response.ok) {
      const data = await response.json();
      if (data.task && activeMode === 'task' && data.task.id === chat.id) Object.assign(chat, data.task);
      throw new Error(data.error || 'Ошибка соединения');
    }
    await readStream(response, token => { result += token; comparisonResult.textContent = result; });
    if (!result) throw new Error('Сервис не вернул текст сравнения.');
  } catch (error) { comparisonResult.textContent = `Не удалось выполнить сравнение: ${error.message}`; }
  finally { compareChatsButton.disabled = false; }
});
document.querySelector('#clearChat').addEventListener('click', async event => {
  const chat = currentChat(); if (!chat) return;
  if (activeMode === 'task') {
    if (!window.confirm(`Удалить задачу «${chat.name}» вместе с её памятью?`)) return;
    event.currentTarget.disabled = true;
    try {
      const response = await apiFetch(`/api/tasks/${chat.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.json()).error || 'Не удалось удалить задачу.');
      tasks = tasks.filter(task => task.id !== chat.id); activeMode = 'chat'; activeTaskId = '';
      renderProfiles(); renderChat(); renderHistory(); renderTaskHistory();
    } catch (error) { window.alert(error.message); }
    finally { event.currentTarget.disabled = false; }
    return;
  }
  event.currentTarget.disabled = true;
  try {
    const response = await apiFetch('/api/chat/reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: chat.id })
    });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Ошибка соединения'); }
    chat.lastTemperature = defaultTemperature;
    chat.model = modelEl.value; chat.provider = selectedProvider();
    chat.title = 'Новый чат'; chat.history = []; chat.messages = [];
    chat.memory = { shortTerm: [], working: [], longTerm: structuredClone(longTermMemory) };
    chat.invariants = structuredClone(globalInvariants);
    chat.tokenStats = null;
    chat.context = null;
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
  event.preventDefault(); const text = promptEl.value.trim(); if (!text) return;
  await sendConversationMessage(text);
});
async function sendConversationMessage(text, { taskAction = false, taskActionLabel = '', taskEvent = '' } = {}) {
  if (sendButton.disabled) return '';
  const settings = {
    jsonMode: jsonModeEl.checked,
    temperature: defaultTemperature,
    maxTokens: maxTokensEl.value,
    keepMessages: keepMessagesEl.value,
    contextStrategy: strategyEl.value,
  };
  const chat = currentChat(); if (!chat) return;
  chat.model = modelEl.value;
  chat.provider = selectedProvider();
  chat.profileId = selectedProfileId;
  chat.lastTemperature = settings.temperature;
  const memoryMatch = text.match(/^\/(working|long)(?:\s+([\s\S]+))?$/i);
  if (memoryMatch) {
    const content = memoryMatch[2]?.trim();
    if (!content) { window.alert('После команды добавьте информацию для памяти.'); return; }
    sendButton.disabled = true;
    try {
      const type = memoryMatch[1].toLowerCase() === 'working' ? 'working' : 'longTerm';
      const response = await apiFetch('/api/memory', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: chat.id, type, content, settings: {
          ...settings, model: modelEl.value, provider: selectedProvider(), profileId: selectedProfileId
        } })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось сохранить память.');
      chat.messages = data.messages; chat.history = [...data.messages]; chat.memory = data.memory;
      if (type === 'longTerm' && activeMode === 'chat') {
        longTermMemory = data.memory.longTerm;
        for (const item of chats) { item.memory ||= { shortTerm: [], working: [], longTerm: [] }; item.memory.longTerm = structuredClone(longTermMemory); }
      }
      promptEl.value = ''; promptEl.style.height = 'auto'; saveChats(); renderChat(); renderHistory();
    } catch (error) { window.alert(error.message); }
    finally { sendButton.disabled = false; promptEl.focus({ preventScroll: true }); }
    return '';
  }
  const previousStats = chat.tokenStats;
  const previousContext = chat.context;
  chat.mcpTrace = null;
  if (currentChat()?.id === chat.id) renderMcpTrace();
  const userMessage = { role: 'user', content: text, ...(taskAction && { hidden: true }) };
  const actionMessage = taskAction && taskActionLabel ? { role: 'user', content: taskActionLabel, actionMessage: true } : null;
  if (actionMessage) { chat.messages.push(actionMessage); chat.history.push(actionMessage); }
  chat.messages.push(userMessage); chat.history.push(userMessage);
  chat.memory ||= { shortTerm: [], working: [], longTerm: structuredClone(longTermMemory) };
  chat.memory.shortTerm ||= [];
  if (actionMessage) chat.memory.shortTerm.push(actionMessage);
  else if (!taskAction) chat.memory.shortTerm.push({ role: 'user', content: text });
  if (!taskAction && chat.title === 'Новый чат') chat.title = text.replace(/\s+/g, ' ').slice(0, 42);
  const assistantMessage = { role: 'assistant', content: '', pending: true };
  chat.messages.push(assistantMessage); saveChats();
  const isActive = () => currentChat()?.id === chat.id;
  if (isActive()) {
    if (actionMessage) addMessage('user', actionMessage.content);
    else if (!taskAction) addMessage('user', text);
    const pendingElement = addMessage('assistant', taskAction ? 'Выполняется…' : '', true);
    if (taskAction) pendingElement.classList.add('task-action-running');
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  promptEl.value = ''; promptEl.style.height = 'auto'; sendButton.disabled = true; renderHistory(); renderTaskHistory(); renderChatTitle(chat);
  renderContextControls();
  renderTokenStats();
  renderMemory();
  let answer = '';
  try {
    const response = await apiFetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      conversationId: chat.id,
      model: modelEl.value,
      provider: selectedProvider(),
      profileId: selectedProfileId,
      message: text,
      documentStrategy: !taskAction && activeMode !== 'task' ? window.selectedDocumentStrategy() : null,
      taskAction,
      taskActionLabel,
      taskEvent,
      ...settings
    }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Ошибка соединения'); }
    await readStream(response, token => {
      answer += token; assistantMessage.content = answer;
      if (isActive()) {
        renderTokenStats();
        const follow = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
        messagesEl.lastElementChild.querySelector('.bubble').textContent = answer;
        if (follow) messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }, (stats, context, messages) => {
      chat.tokenStats = stats;
      chat.context = context;
      const savedAssistantMessage = [...(messages || [])].reverse().find(message => message.role === 'assistant');
      assistantMessage.invariantRefusal = Boolean(savedAssistantMessage?.invariantRefusal);
      assistantMessage.documentSearch = savedAssistantMessage?.documentSearch || null;
      assistantMessage.ragMode = savedAssistantMessage?.ragMode || null;
      assistantMessage.files = savedAssistantMessage?.files || assistantMessage.files || [];
    }, trace => {
      chat.mcpTrace = trace;
      if (isActive()) { sidePanel = 'mcp'; renderWorkspaceMode(); renderMcpTrace(); }
      saveChats();
    }, file => {
      assistantMessage.files ||= [];
      if (!assistantMessage.files.some(item => item.name === file.name)) assistantMessage.files.push(file);
    });
    if (!answer) throw new Error('Сервис не вернул текст ответа.');
    chat.history.push({ role: 'assistant', content: answer, invariantRefusal: assistantMessage.invariantRefusal, files: assistantMessage.files, documentSearch: assistantMessage.documentSearch, ragMode: assistantMessage.ragMode });
    chat.memory.shortTerm.push({ role: 'assistant', content: answer, invariantRefusal: assistantMessage.invariantRefusal, files: assistantMessage.files, documentSearch: assistantMessage.documentSearch, ragMode: assistantMessage.ragMode });
    if (settings.contextStrategy !== 'branching') {
      const recentDialogue = chat.history.filter(message => !message.memoryCommand).slice(-Number(settings.keepMessages));
      chat.history = chat.history.filter(message => message.memoryCommand || recentDialogue.includes(message));
      chat.messages = [...chat.history];
    }
  } catch (error) { chat.history.pop(); chat.tokenStats = previousStats; chat.context = previousContext; assistantMessage.content = `Ошибка: ${error.message}`; }
  finally {
    assistantMessage.pending = false; saveChats();
    if (isActive()) {
      const follow = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
      const bubble = messagesEl.lastElementChild.querySelector('.bubble');
      bubble.textContent = assistantMessage.content;
      bubble.classList.remove('typing');
      renderFileCards(messagesEl.lastElementChild, assistantMessage.files);
      window.renderDocumentSources(messagesEl.lastElementChild.querySelector('.message-body'), assistantMessage.documentSearch, assistantMessage.ragMode);
      setInvariantRefusalMark(messagesEl.lastElementChild, Boolean(assistantMessage.invariantRefusal));
      messagesEl.lastElementChild.classList.remove('task-action-running');
      if (follow) messagesEl.scrollTop = messagesEl.scrollHeight;
      renderChatTitle(chat);
      promptEl.focus({ preventScroll: true });
    }
    renderHistory(); renderTaskHistory();
    sendButton.disabled = false;
    renderContextControls();
    renderTokenStats();
    renderMemory();
  }
  return answer;
}


document.querySelector('#clearAll').addEventListener('click', async () => {
  const button = document.querySelector('#clearAll'); button.disabled = true;
  try {
    const response = await apiFetch('/api/chats/clear', { method: 'POST' });
    if (!response.ok) throw new Error((await response.json()).error);
    resetMonitoring();
    localStorage.removeItem(storageKey); sessionStorage.removeItem(storageKey);
    longTermMemory = [];
    globalInvariants = [];
    chats = []; tasks = []; activeMode = 'chat'; activeTaskId = ''; activeChatId = createChat();
    comparisonResult.textContent = ''; comparisonModal.hidden = true;
    promptEl.value = ''; renderChat(); renderHistory(); renderTaskHistory();
  } catch (error) { window.alert(error.message); }
  finally { button.disabled = false; }
});
async function initialize() {
  sendButton.disabled = true;
  try {
    const [response, profilesResponse, tasksResponse] = await Promise.all([apiFetch('/api/chats'), apiFetch('/api/profiles'), apiFetch('/api/tasks')]);
    if (!response.ok || !profilesResponse.ok || !tasksResponse.ok) throw new Error('Не удалось загрузить историю, задачи и профили.');
    const [data, profilesData, tasksData] = await Promise.all([response.json(), profilesResponse.json(), tasksResponse.json()]);
    profiles = Array.isArray(profilesData.profiles) ? profilesData.profiles : [];
    longTermMemory = Array.isArray(data.longTerm) ? data.longTerm : [];
    globalInvariants = Array.isArray(data.globalInvariants) ? data.globalInvariants : [];
    chats = data.chats.map(chat => ({
      id: chat.id, title: chat.messages.find(message => message.role === 'user' && !message.memoryCommand)?.content.slice(0, 42) || 'Новый чат',
      messages: chat.messages, history: [...chat.messages],
      model: chat.settings.model, provider: chat.settings.provider, lastTemperature: chat.settings.temperature,
      maxTokens: chat.settings.maxTokens ?? '', tokenStats: chat.tokenStats, context: chat.context,
      keepMessages: chat.settings.keepMessages ?? 4, contextStrategy: chat.settings.contextStrategy ?? 'sliding',
      profileId: chat.settings.profileId || '',
      memory: chat.memory || { shortTerm: [], working: [], longTerm: structuredClone(longTermMemory) },
      invariants: Array.isArray(chat.invariants) ? chat.invariants : []
    }));
    tasks = (tasksData.tasks || []).map(task => ({
      ...task,
      messages: task.conversation?.messages || [], history: [...(task.conversation?.messages || [])],
      model: task.conversation?.settings?.model || modelEl.value,
      provider: task.conversation?.settings?.provider || selectedProvider(),
      lastTemperature: task.conversation?.settings?.temperature ?? defaultTemperature,
      maxTokens: task.conversation?.settings?.maxTokens ?? '',
      keepMessages: task.conversation?.settings?.keepMessages ?? 100,
      contextStrategy: task.conversation?.settings?.contextStrategy ?? 'sliding',
      tokenStats: task.conversation?.tokenStats || null, context: task.conversation?.context || null,
      memory: task.memory || { shortTerm: [], working: [], longTerm: [] },
      invariants: Array.isArray(task.invariants) ? task.invariants : []
    }));
    selectedProfileId = '';
    activeChatId = chats[0]?.id || createChat();
    saveChats(); renderProfiles(); renderChat(); renderHistory(); renderTaskHistory(); sendButton.disabled = false;
  } catch (error) { addMessage('assistant', error.message + ' Перезагрузите страницу для повторной попытки.'); }
}
initialize();

function renderContextControls() {
  const chat = currentChat();
  const branching = strategyEl.value === 'branching';
  document.querySelector('#branchControls').hidden = !branching;
  keepMessagesEl.disabled = branching;
  document.querySelector('#strategyHelp').textContent = {
    sliding: 'Только последние N сообщений, включая новый запрос. Старые сообщения удаляются. Summary выключен.',
    facts: 'После каждого сообщения пользователя обновляются facts. В запрос идут facts и последние N сообщений.',
    branching: 'Получите список вариантов и нажмите «Создать ветки из вариантов ответа». Выберите тему в селекторе: у каждой ветки своя переписка.'
  }[strategyEl.value];
  for (const [selector, items, active] of [
    ['#branches', chat?.context?.branches || {}, chat?.context?.activeBranch]
  ]) {
    const select = document.querySelector(selector); select.replaceChildren();
    for (const [id, value] of Object.entries(items)) { const option = document.createElement('option'); option.value = id; option.textContent = value.name; select.append(option); }
    if (active && Object.hasOwn(items, active)) select.value = active;
  }
  const busy = Boolean(chat?.messages.some(message => message.pending));
  const hasAnswer = chat?.history?.at(-1)?.role === 'assistant';
  const button = document.querySelector('#optionBranches');
  button.disabled = !hasAnswer || busy;
  button.setAttribute('aria-busy', String(busy));
  button.title = busy ? 'Дождитесь завершения ответа.' : !hasAnswer ? 'Сначала получите ответ со списком вариантов.' : 'Создать отдельную ветку для каждого варианта из последнего ответа.';
  document.querySelector('#branches').disabled = busy;
}
async function branchAction(action, id) {
  if (sendButton.disabled) return;
  const chat = currentChat(); sendButton.disabled = true;
  try {
    const response = await apiFetch('/api/chat/branch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: chat.id, action, id }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error);
    Object.assign(chat, data, { history: [...data.messages], contextStrategy: 'branching' });
    saveChats(); renderChat(); renderHistory();
  } catch (error) { window.alert(error.message); }
  finally { sendButton.disabled = false; }
}
document.querySelector('#optionBranches').addEventListener('click', () => branchAction('options'));
document.querySelector('#branches').addEventListener('change', event => branchAction('switch', event.target.value));

createTaskButton.addEventListener('click', async () => {
  const description = promptEl.value.trim();
  if (!description) {
    window.alert('Сначала напишите задачу или вопрос в поле сообщения.');
    promptEl.focus();
    return;
  }
  createTaskButton.disabled = true;
  try {
    const compact = description.replace(/\s+/g, ' ');
    const payload = {
      name: `Задача: ${compact.slice(0, 105)}`, description, profileId: selectedProfileId,
      model: modelEl.value, provider: selectedProvider(), temperature: defaultTemperature,
      maxTokens: maxTokensEl.value, keepMessages: 100, contextStrategy: 'sliding', jsonMode: jsonModeEl.checked
    };
    const response = await apiFetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Не удалось создать задачу.');
    const task = data.task;
    const initialMessages = task.conversation?.messages || [{ role: 'user', content: description }];
    tasks.unshift({ ...task, messages: initialMessages, history: [...initialMessages], model: modelEl.value, provider: selectedProvider(), lastTemperature: defaultTemperature, maxTokens: maxTokensEl.value, keepMessages: 100, contextStrategy: 'sliding', tokenStats: null, context: task.conversation?.context || null, memory: task.memory || { shortTerm: [{ role: 'user', content: description }], working: [], longTerm: [] }, invariants: task.invariants || [] });
    activeMode = 'task'; activeTaskId = task.id; selectedProfileId = task.profileId || ''; sidePanel = 'primary';
    promptEl.value = ''; promptEl.style.height = 'auto';
    renderProfiles(); renderChat(); renderHistory(); renderTaskHistory(); promptEl.focus();
  } catch (error) { window.alert(error.message); }
  finally { createTaskButton.disabled = false; }
});

async function updateTaskState(event, payload = {}) {
  const task = currentTask(); if (!task) return null;
  const response = await apiFetch(`/api/tasks/${task.id}/state`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, userConsent: true, expectedVersion: task.version, ...payload })
  });
  const data = await response.json();
  if (!response.ok) {
    if (data.task?.id === task.id) Object.assign(task, data.task);
    throw new Error(data.error || 'Не удалось изменить состояние задачи.');
  }
  const returnedMessages = Array.isArray(data.messages) ? data.messages : task.messages;
  const runtime = { messages: returnedMessages, history: [...returnedMessages], memory: data.memory || task.memory, model: task.model, provider: task.provider, lastTemperature: task.lastTemperature, maxTokens: task.maxTokens, keepMessages: task.keepMessages, contextStrategy: task.contextStrategy, tokenStats: task.tokenStats, context: task.context };
  Object.assign(task, data.task, runtime);
  return task;
}
function parsePlan(answer) {
  const items = answer.split(/\r?\n/).map(line => line.match(/^\s*(?:\d+[.)]|[-*•])\s+(.+?)\s*$/)?.[1]).filter(Boolean);
  if (items.length) return items.slice(0, 4).map(title => ({ title: title.replace(/^\*\*(.+)\*\*$/, '$1') }));
  return answer.split(/[.!?]\s+/).map(title => title.trim()).filter(title => title.length > 8).slice(0, 4).map(title => ({ title }));
}
async function runTaskAction({ revision = '' } = {}) {
  const task = currentTask(); if (!task || task.paused || task.busyAction) return;
  let event;
  let prompt;
  if (revision) {
    event = 'REVISE_PLAN';
    prompt = `Пересмотри способ выполнения задачи «${task.name}». Причина изменений: ${revision}. Сейчас не решай задачу и не давай итоговый ответ. Сначала кратко объясни, что будет происходить во время выполнения и как эти действия приведут к результату. Затем добавь заголовок «План» и только действительно необходимые короткие нумерованные шаги. Обычно достаточно 1–2 шагов; добавляй третий или четвёртый только если без них нельзя получить качественный результат. Не дроби одно действие на несколько формальных пунктов.\nТекущий план:\n${task.plan.map((step, index) => `${index + 1}. ${step.title}`).join('\n')}`;
  } else if (task.stage === 'planning') {
    event = 'PLAN_READY';
    prompt = `Подготовь способ выполнения пользовательской задачи. На этом этапе не отвечай на сам вопрос, не решай задачу и не сообщай итоговые выводы. Сначала кратко и понятно объясни пользователю, что будет происходить во время выполнения задачи и как будет получен результат. Затем добавь заголовок «План» и только действительно необходимые короткие нумерованные шаги. Обычно достаточно 1–2 шагов; добавляй третий или четвёртый только если без них нельзя получить качественный результат. Не дроби одно действие на несколько формальных пунктов.`;
  } else if (task.stage === 'awaiting_approval') {
    event = 'APPROVE_PLAN';
    prompt = `План задачи «${task.name}» утверждён. Кратко сообщи, с какого первого шага начинаем и какой результат он должен дать. Не повторяй весь план.`;
  } else if (task.stage === 'execution') {
    event = 'STEP_DONE';
    const step = task.plan[task.currentStep];
    prompt = `Выполни текущий шаг задачи «${task.name}»: шаг ${task.currentStep + 1} — «${step.title}». Дай конкретный результат этого шага и кратко укажи, что сделано. Не переходи к следующему шагу.`;
  } else if (task.stage === 'validation') {
    event = 'VALIDATED';
    prompt = `Проверь итог задачи «${task.name}» по цели: ${task.description}. Сопоставь результат с выполненными шагами, перечисли найденные проблемы или явно подтверди готовность. Ответ дай кратко.`;
  } else return;
  task.busyAction = true; task.busyLabel = revision ? 'Пересматривается план' : task.expectedAction;
  renderProcess(); renderTaskHistory();
  try {
    const actionLabel = revision ? 'Пересмотреть план' : task.expectedAction;
    const answer = await sendConversationMessage(prompt, { taskAction: true, taskActionLabel: actionLabel, taskEvent: event });
    if (!answer) return;
    const plan = ['PLAN_READY', 'REVISE_PLAN'].includes(event) ? parsePlan(answer) : undefined;
    if (plan && !plan.length) throw new Error('Агент не вернул распознаваемые шаги плана. Попробуйте ещё раз.');
    await updateTaskState(event, plan ? { plan } : {});
    if (task.pauseRequested) { task.pauseRequested = false; await updateTaskState('PAUSE'); }
  } catch (error) { window.alert(error.message); }
  finally { task.busyAction = false; task.busyLabel = ''; renderChat(); renderHistory(); renderTaskHistory(); }
}
taskPrimaryAction.addEventListener('click', () => runTaskAction());
taskPauseButton.addEventListener('click', async () => {
  const task = currentTask(); if (!task) return;
  if (task.busyAction) { task.pauseRequested = true; renderProcess(); return; }
  taskPauseButton.disabled = true;
  try { await updateTaskState(task.paused ? 'RESUME' : 'PAUSE'); }
  catch (error) { window.alert(error.message); }
  finally { renderChat(); renderHistory(); renderTaskHistory(); }
});
function closeReviseModal() { document.querySelector('#reviseModal').hidden = true; document.querySelector('#reviseForm').reset(); document.querySelector('#reviseFormError').textContent = ''; }
revisePlanButton.addEventListener('click', () => { document.querySelector('#reviseModal').hidden = false; document.querySelector('#reviseReason').focus(); });
document.querySelector('#closeRevise').addEventListener('click', closeReviseModal);
document.querySelector('#cancelRevise').addEventListener('click', closeReviseModal);
document.querySelector('#reviseModal').addEventListener('click', event => { if (event.target.id === 'reviseModal') closeReviseModal(); });
document.querySelector('#reviseForm').addEventListener('submit', async event => {
  event.preventDefault(); const reason = document.querySelector('#reviseReason').value.trim(); if (!reason) return;
  closeReviseModal(); await runTaskAction({ revision: reason });
});
