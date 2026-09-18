const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Agent, AgentError, AgentRegistry } = require('./agent');

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

async function handleChat(request, response) {
  try {
    const body = await readBody(request);
    if (!body.ephemeral && !validConversationId(body.conversationId)) {
      return sendJson(response, 400, { error: 'Некорректный идентификатор диалога.' });
    }

    const settings = {
      provider: body.provider,
      model: body.model,
      jsonMode: body.jsonMode,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
      keepMessages: body.keepMessages,
      contextStrategy: body.contextStrategy,
      stopSequence: body.stopSequence,
      systemPrompt: process.env.AGENT_SYSTEM_PROMPT || ''
    };
    const agent = body.ephemeral ? new Agent(settings) : agents.get(body.conversationId, settings);

    await agent.respond(body.message, {
      onStart: () => startStream(response),
      onToken: token => writeToken(response, token)
    });
    response.write(`data: ${JSON.stringify({ tokenStats: agent.tokenStats, context: agent.context, messages: agent.messages })}\n\n`);
    response.end('data: [DONE]\n\n');
  } catch (error) {
    const message = error.message || 'Не удалось выполнить запрос.';
    const status = error instanceof AgentError ? error.status : 500;
    if (!response.headersSent) return sendJson(response, status, { error: message });
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
    chats: store.list().map(chat => ({ ...chat, memory: memoryStore.view(chat.id) })),
    longTerm: memoryStore.view('').longTerm
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
