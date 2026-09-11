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

const { HistoryStore } = require('./history-store');
const store = new HistoryStore(path.join(__dirname, 'data', 'conversations.json'));
const agents = new AgentRegistry({ store });

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
      stopSequence: body.stopSequence,
      systemPrompt: process.env.AGENT_SYSTEM_PROMPT || ''
    };
    const agent = body.ephemeral ? new Agent(settings) : agents.get(body.conversationId, settings);

    await agent.respond(body.message, {
      onStart: () => startStream(response),
      onToken: token => writeToken(response, token)
    });
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
    return sendJson(response, 200, { ok: true });
  } catch (error) {
    return sendJson(response, error instanceof AgentError ? error.status : 500, { error: error.message || 'Не удалось очистить диалог.' });
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/api/chats') return sendJson(response, 200, { chats: store.list() });
  if (request.method === 'POST' && request.url === '/api/chats/clear') {
    try { agents.clear(); return sendJson(response, 200, { ok: true }); }
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
