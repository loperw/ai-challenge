const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Agent, AgentError, AgentRegistry, enforceStateTransitionInvariants } = require('./agent');
const { createTask, transitionTask, TaskStateError, allowedEvents, taskLifecycleInstructions } = require('./task-state');

const publicDir = path.join(__dirname, 'public');
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };

// Loads local settings without adding a dependency. `.env` is intentionally gitignored.
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

const { SQLiteStore } = require('./sqlite-store');
const store = new SQLiteStore(path.join(__dirname, 'data', 'agent-memory.sqlite'), {
  legacyConversationsPath: path.join(__dirname, 'data', 'conversations.json'),
  legacyMemoryPath: path.join(__dirname, 'data', 'memory.json')
});
const memoryStore = store;
const agents = new AgentRegistry({ store, memoryStore });

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function startStream(response) {
  if (response.headersSent) return;
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
}

function writeToken(response, token) {
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validConversationId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function profileFields(body) {
  const read = (key, max) => typeof body?.[key] === 'string' ? body[key].trim().slice(0, max) : '';
  const profile = {
    name: read('name', 80),
    occupation: read('occupation', 240),
    language: read('language', 120),
    responseFormat: read('responseFormat', 500),
    constraints: read('constraints', 1000)
  };
  if (!profile.name) throw new AgentError('Укажите название профиля.', 400);
  return profile;
}

function invariantFields(body) {
  const content = typeof body?.content === 'string' ? body.content.trim() : '';
  const scope = typeof body?.scope === 'string' ? body.scope : '';
  if (!content) throw new AgentError('Введите текст инварианта.', 400);
  if (content.length > 1000) throw new AgentError('Инвариант не должен превышать 1000 символов.', 400);
  if (!['conversation', 'task', 'stateMachine', 'global'].includes(scope)) throw new AgentError('Неизвестная область инварианта.', 400);
  return { content, scope };
}

async function handleChat(request, response) {
  let task = null;
  try {
    const body = await readBody(request);
    if (!body.ephemeral && !validConversationId(body.conversationId)) {
      return sendJson(response, 400, { error: 'Некорректный идентификатор диалога.' });
    }

    task = body.ephemeral ? null : store.getTask(body.conversationId);
    const taskEvent = typeof body.taskEvent === 'string' ? body.taskEvent : '';
    if (task && task.stage === 'paused') {
      throw new TaskStateError('Задача на паузе. Сначала нажмите «Продолжить».', 409, { code: 'TASK_PAUSED' });
    }
    if (task && body.taskAction) {
      const assistantEvents = ['PLAN_READY', 'APPROVE_PLAN', 'STEP_DONE', 'VALIDATED', 'REVISE_PLAN'];
      if (!assistantEvents.includes(taskEvent) || !allowedEvents(task).includes(taskEvent)) {
        throw new TaskStateError(`Действие ${taskEvent || 'не указано'} недоступно в состоянии ${task.stage}.`, 409, {
          code: 'INVALID_TASK_ACTION', state: task.stage, allowedEvents: allowedEvents(task)
        });
      }
    }
    const taskContext = task ? [
      'РЕЖИМ ЗАДАЧИ. Это отдельная сущность со своей памятью и профилем.',
      `Название: ${task.name}`,
      `Описание результата: ${task.description}`,
      `Этап: ${task.stage}; текущий шаг: ${task.currentStep + 1}; ожидаемое действие: ${task.expectedAction}.`,
      task.plan.length ? `Утверждённый или подготовленный план:\n${task.plan.map((step, index) => `${index + 1}. [${step.done ? 'готово' : 'не готово'}] ${step.title}`).join('\n')}` : '',
      taskLifecycleInstructions(task, { taskAction: Boolean(body.taskAction), event: taskEvent })
    ].filter(Boolean).join('\n') : '';
    const settings = {
      provider: body.provider,
      model: body.model,
      jsonMode: body.jsonMode,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
      keepMessages: body.keepMessages,
      contextStrategy: body.contextStrategy,
      stopSequence: body.stopSequence,
      profileId: body.profileId,
      systemPrompt: [process.env.AGENT_SYSTEM_PROMPT || '', taskContext].filter(Boolean).join('\n\n'),
      taskMode: Boolean(task)
    };
    if (settings.profileId && !store.getProfile(settings.profileId)) {
      return sendJson(response, 400, { error: 'Выбранный профиль не найден.' });
    }
    const agent = body.ephemeral
      ? new Agent(settings, {
        getProfile: profileId => store.getProfile(profileId),
        getInvariants: () => store.getInvariants('__ephemeral__')
      })
      : agents.get(body.conversationId, settings);

    await agent.respond(body.message, {
      onStart: () => startStream(response),
      onToken: token => writeToken(response, token),
      hiddenUserMessage: Boolean(task && body.taskAction),
      displayUserMessage: task && body.taskAction ? body.taskActionLabel : ''
    });
    response.write(`data: ${JSON.stringify({ tokenStats: agent.tokenStats, context: agent.context, messages: agent.messages })}\n\n`);
    response.end('data: [DONE]\n\n');
  } catch (error) {
    const message = error.message || 'Не удалось выполнить запрос.';
    const status = error.status || 500;
    if (!response.headersSent) return sendJson(response, status, {
      error: message,
      ...(error.code && { code: error.code }),
      ...(task && { task: store.getTask(task.id) })
    });
    response.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    response.end('data: [DONE]\n\n');
  }
}

async function handleReset(request, response) {
  try {
    const { conversationId } = await readBody(request);
    if (!validConversationId(conversationId)) return sendJson(response, 400, { error: 'Некорректный идентификатор диалога.' });
    agents.reset(conversationId);
    memoryStore.removeConversation(conversationId);
    return sendJson(response, 200, { ok: true });
  } catch (error) {
    return sendJson(response, error instanceof AgentError ? error.status : 500, { error: error.message || 'Не удалось очистить диалог.' });
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/api/tasks') {
    const chats = store.chats;
    return sendJson(response, 200, { tasks: store.listTasks().map(task => ({
      ...task,
      conversation: chats[task.id] || null,
      memory: store.view(task.id),
      invariants: store.listInvariants(task.id)
    })) });
  }
  if (request.method === 'POST' && request.url === '/api/tasks') {
    try {
      const body = await readBody(request);
      if (body.profileId && !store.getProfile(body.profileId)) throw new TaskStateError('Выбранный профиль не найден.', 400);
      const task = store.saveTask(createTask(body));
      const initialMessage = { role: 'user', content: task.description };
      const settings = {
        provider: body.provider,
        model: body.model,
        jsonMode: Boolean(body.jsonMode),
        temperature: body.temperature ?? 1,
        maxTokens: body.maxTokens,
        keepMessages: body.keepMessages ?? 100,
        contextStrategy: body.contextStrategy || 'sliding',
        profileId: task.profileId,
        taskMode: true
      };
      store.save(task.id, settings, [initialMessage], null, { facts: {}, turns: [] });
      store.addShortTerm(task.id, [initialMessage]);
      return sendJson(response, 201, { task: { ...task, conversation: store.chats[task.id], memory: store.view(task.id), invariants: store.listInvariants(task.id) } });
    } catch (error) {
      return sendJson(response, error.status || 500, { error: error.message || 'Не удалось создать задачу.' });
    }
  }
  const taskStateRoute = request.url.match(/^\/api\/tasks\/([a-f0-9-]+)\/state$/i);
  if (request.method === 'POST' && taskStateRoute) {
    try {
      const current = store.getTask(taskStateRoute[1]);
      if (!current) throw new TaskStateError('Задача не найдена.', 404);
      const body = await readBody(request);
      if (body.event === 'SET_PROFILE' && body.profileId && !store.getProfile(body.profileId)) throw new TaskStateError('Выбранный профиль не найден.', 400);
      if (body.event !== 'SET_PROFILE' && agents.agents.get(current.id)?.busy) {
        throw new TaskStateError('Дождитесь завершения текущего ответа. Состояние задачи не изменено.', 409, {
          code: 'TASK_BUSY', state: current.stage, version: current.version
        });
      }
      if (body.event !== 'SET_PROFILE' && (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 0)) {
        throw new TaskStateError('Для перехода нужна актуальная версия состояния задачи.', 400, {
          code: 'TASK_VERSION_REQUIRED', state: current.stage, version: current.version
        });
      }
      const nextTask = transitionTask(current, body.event, body);
      const stateInvariants = body.event === 'SET_PROFILE' ? [] : store.getStateMachineInvariants(current.id);
      if (stateInvariants.length) {
        const conversation = store.chats[current.id];
        if (!conversation) throw new TaskStateError('Контекст задачи не найден.', 404);
        const agent = agents.get(current.id, conversation.settings);
        await enforceStateTransitionInvariants(agent, stateInvariants, {
          current, next: nextTask, event: body.event, userConsent: body.userConsent
        });
      }
      const latest = store.getTask(current.id);
      if (body.event !== 'SET_PROFILE' && latest.version !== current.version) {
        throw new TaskStateError('Состояние задачи уже изменилось. Обновите задачу и повторите действие.', 409, {
          code: 'STALE_TASK_STATE', state: latest.stage, version: latest.version, allowedEvents: latest.allowedEvents
        });
      }
      const task = store.saveTask(nextTask);
      const actionLabel = { PAUSE: 'Пауза', RESUME: 'Продолжить' }[body.event];
      if (actionLabel) {
        const conversation = store.chats[task.id];
        if (conversation) agents.get(task.id, conversation.settings).recordActionMessage(actionLabel);
      }
      return sendJson(response, 200, { task, messages: store.chats[task.id]?.messages || [], memory: store.view(task.id) });
    } catch (error) {
      const authoritativeTask = store.getTask(taskStateRoute[1]);
      return sendJson(response, error.status || 500, {
        error: error.message || 'Не удалось изменить состояние задачи.',
        ...(error.code && { code: error.code }),
        ...(error.state && { state: error.state }),
        ...(error.allowedEvents && { allowedEvents: error.allowedEvents }),
        ...(error.version !== undefined && { version: error.version }),
        ...(authoritativeTask && { task: authoritativeTask })
      });
    }
  }
  const taskRoute = request.url.match(/^\/api\/tasks\/([a-f0-9-]+)$/i);
  if (request.method === 'DELETE' && taskRoute) {
    try {
      agents.reset(taskRoute[1]);
      store.removeTask(taskRoute[1]);
      return sendJson(response, 200, { ok: true });
    } catch (error) {
      return sendJson(response, error.status || 500, { error: error.message || 'Не удалось удалить задачу.' });
    }
  }
  if (request.method === 'GET' && request.url === '/api/profiles') {
    return sendJson(response, 200, { profiles: store.listProfiles() });
  }
  if (request.method === 'POST' && request.url === '/api/profiles') {
    try { return sendJson(response, 201, { profile: store.createProfile(profileFields(await readBody(request))) }); }
    catch (error) { return sendJson(response, error.status || 500, { error: error.message || 'Не удалось создать профиль.' }); }
  }
  const profileRoute = request.url.match(/^\/api\/profiles\/([a-f0-9-]+)$/i);
  if (request.method === 'PUT' && profileRoute) {
    try {
      const profile = store.updateProfile(profileRoute[1], profileFields(await readBody(request)));
      return profile ? sendJson(response, 200, { profile }) : sendJson(response, 404, { error: 'Профиль не найден.' });
    } catch (error) { return sendJson(response, error.status || 500, { error: error.message || 'Не удалось обновить профиль.' }); }
  }
  if (request.method === 'DELETE' && profileRoute) {
    try {
      return store.deleteProfile(profileRoute[1])
        ? sendJson(response, 200, { ok: true })
        : sendJson(response, 404, { error: 'Профиль не найден.' });
    } catch (error) { return sendJson(response, error.status || 500, { error: error.message || 'Не удалось удалить профиль.' }); }
  }
  if (request.method === 'POST' && request.url === '/api/memory') {
    try {
      const body = await readBody(request);
      if (!validConversationId(body.conversationId)) throw new AgentError('Некорректный диалог.', 400);
      if (!['working', 'longTerm'].includes(body.type)) throw new AgentError('Неизвестный тип памяти.', 400);
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      if (!content) throw new AgentError('После команды добавьте информацию для памяти.', 400);
      const saved = store.chats[body.conversationId];
      const settings = saved?.settings || body.settings;
      const agent = agents.get(body.conversationId, settings);
      if (agent.busy) throw new AgentError('Дождитесь завершения ответа агента.', 409);
      agent.recordMemoryCommand(body.type, content);
      memoryStore.add(body.conversationId, body.type, content);
      memoryStore.addShortTerm(body.conversationId, [{ role: 'user', content: `${body.type === 'working' ? '/working' : '/long'} ${content}`, memoryCommand: true, memoryType: body.type }]);
      return sendJson(response, 200, { memory: memoryStore.view(body.conversationId), messages: agent.messages });
    } catch (error) { return sendJson(response, error.status || 500, { error: error.message }); }
  }
  if (request.method === 'POST' && request.url === '/api/invariants') {
    try {
      const body = await readBody(request);
      if (!validConversationId(body.conversationId)) throw new AgentError('Некорректный диалог.', 400);
      if (agents.agents.get(body.conversationId)?.busy) throw new AgentError('Дождитесь завершения ответа агента.', 409);
      const invariant = invariantFields(body);
      const task = store.getTask(body.conversationId);
      if (task && invariant.scope === 'conversation') invariant.scope = 'task';
      if (!task && ['task', 'stateMachine'].includes(invariant.scope)) throw new AgentError('Эта область доступна только для задачи.', 400);
      const existing = store.listInvariants(body.conversationId);
      if (existing.filter(item => item.scope === invariant.scope).length >= 50) throw new AgentError('Можно задать не более 50 инвариантов в одной области.', 400);
      const saved = store.addInvariant(body.conversationId, invariant.scope, invariant.content);
      return sendJson(response, 201, { invariant: saved, invariants: store.listInvariants(body.conversationId) });
    } catch (error) { return sendJson(response, error.status || 500, { error: error.message || 'Не удалось сохранить инварианты.' }); }
  }
  const invariantRoute = request.url.match(/^\/api\/invariants\/([a-f0-9-]+)$/i);
  if (request.method === 'DELETE' && invariantRoute) {
    try {
      const invariant = store.getInvariant(invariantRoute[1]);
      if (!invariant) return sendJson(response, 404, { error: 'Инвариант не найден.' });
      if (invariant.scope !== 'global' && agents.agents.get(invariant.ownerId)?.busy) throw new AgentError('Дождитесь завершения ответа агента.', 409);
      store.removeInvariant(invariantRoute[1]);
      return sendJson(response, 200, { ok: true });
    } catch (error) { return sendJson(response, error.status || 500, { error: error.message || 'Не удалось удалить инвариант.' }); }
  }
  if (request.method === 'POST' && request.url === '/api/chat/branch') {
    try {
      const body = await readBody(request);
      if (!validConversationId(body.conversationId)) throw new AgentError('Некорректный диалог.', 400);
      const saved = store.chats[body.conversationId];
      if (!saved) throw new AgentError('Сначала отправьте сообщение.', 400);
      const agent = agents.get(body.conversationId, { ...saved.settings, contextStrategy: 'branching' });
      agent.branchAction(body.action, body.id);
      return sendJson(response, 200, { messages: agent.messages, context: agent.context, tokenStats: agent.tokenStats });
    } catch (error) { return sendJson(response, error.status || 500, { error: error.message }); }
  }
  if (request.method === 'GET' && request.url === '/api/chats') return sendJson(response, 200, {
    chats: store.listChats().map(chat => ({ ...chat, memory: memoryStore.view(chat.id), invariants: store.listInvariants(chat.id) })),
    longTerm: memoryStore.view('').longTerm,
    globalInvariants: store.listGlobalInvariants()
  });
  if (request.method === 'POST' && request.url === '/api/chats/clear') {
    try { agents.clear(); memoryStore.clear(); return sendJson(response, 200, { ok: true }); }
    catch (error) { return sendJson(response, error.status || 500, { error: error.message }); }
  }
  if (request.method === 'POST' && request.url === '/api/chat') return handleChat(request, response);
  if (request.method === 'POST' && request.url === '/api/chat/reset') return handleReset(request, response);

  const pathname = request.url === '/' ? '/index.html' : request.url;
  const safePath = path.normalize(path.join(publicDir, pathname));
  if (!safePath.startsWith(publicDir)) return sendJson(response, 403, { error: 'Forbidden' });
  fs.readFile(safePath, (error, data) => {
    if (error) return sendJson(response, 404, { error: 'Not found' });
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(safePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    response.end(data);
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Open http://localhost:3000'));
