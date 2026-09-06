const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

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

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/api/chat') {
    try {
      const { model, messages, temperature } = await readBody(request);
      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!apiKey) return sendJson(response, 500, { error: 'В локальном файле .env не задан DEEPSEEK_API_KEY.' });
      if (!Array.isArray(messages) || !messages.length) return sendJson(response, 400, { error: 'Добавьте сообщение.' });

      const upstream = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model || 'deepseek-v4-flash', messages, temperature: Number(temperature) || 1, stream: true })
      });
      if (!upstream.ok) {
        const payload = await upstream.json();
        return sendJson(response, upstream.status, { error: payload.error?.message || 'DeepSeek вернул ошибку.' });
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      for await (const chunk of upstream.body) response.write(chunk);
      return response.end();
    } catch (error) {
      return sendJson(response, 500, { error: error.message || 'Не удалось выполнить запрос.' });
    }
  }

  const pathname = request.url === '/' ? '/index.html' : request.url;
  const safePath = path.normalize(path.join(publicDir, pathname));
  if (!safePath.startsWith(publicDir)) return sendJson(response, 403, { error: 'Forbidden' });
  fs.readFile(safePath, (error, data) => {
    if (error) return sendJson(response, 404, { error: 'Not found' });
    response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(safePath)] || 'application/octet-stream' });
    response.end(data);
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Open http://localhost:3000'));
