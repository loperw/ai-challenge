const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, 'public');
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
const deepseekModels = new Set(['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']);
const geminiModels = new Set(['gemini-3.5-flash-lite', 'gemini-3.5-flash']);

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

async function upstreamError(upstream, fallback) {
  try {
    const payload = await upstream.json();
    return payload.error?.message || payload.error?.status || payload.message || fallback;
  } catch {
    return fallback;
  }
}

function startStream(response) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
}

function writeToken(response, token) {
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`);
}

async function streamGemini(upstream, response) {
  startStream(response);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop();
    for (const event of events) {
      const data = event.split(/\r?\n/).find(line => line.startsWith('data:'))?.slice(5).trim();
      if (!data) continue;
      const payload = JSON.parse(data);
      for (const part of payload.candidates?.[0]?.content?.parts || []) {
        if (part.text) writeToken(response, part.text);
      }
    }
  }
  response.end('data: [DONE]\n\n');
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/api/chat') {
    try {
      const { provider, model, messages, jsonMode, temperature, maxTokens, stopSequence } = await readBody(request);
      if (!Array.isArray(messages) || !messages.length) return sendJson(response, 400, { error: 'Добавьте сообщение.' });
      if (!['deepseek', 'openrouter', 'gemini'].includes(provider)) return sendJson(response, 400, { error: 'Неизвестный провайдер модели.' });
      if (typeof model !== 'string' || (provider === 'deepseek' && !deepseekModels.has(model))
        || (provider === 'gemini' && !geminiModels.has(model))
        || (provider === 'openrouter' && model !== 'openrouter/free' && !model.endsWith(':free'))) {
        return sendJson(response, 400, { error: 'Выберите модель из списка.' });
      }

      const parsedMaxTokens = maxTokens === '' || maxTokens === undefined ? undefined : Number(maxTokens);
      if (parsedMaxTokens !== undefined && (!Number.isInteger(parsedMaxTokens) || parsedMaxTokens < 1 || parsedMaxTokens > 384000)) {
        return sendJson(response, 400, { error: 'Количество токенов должно быть целым числом от 1 до 384000.' });
      }
      const parsedTemperature = temperature === '' || temperature === undefined ? 1 : Number(temperature);
      if (!Number.isFinite(parsedTemperature) || parsedTemperature < 0 || parsedTemperature > 2) {
        return sendJson(response, 400, { error: 'Температура должна быть числом от 0 до 2.' });
      }
      const stop = typeof stopSequence === 'string' ? stopSequence.trim() : '';
      const requestMessages = jsonMode
        ? [{ role: 'system', content: 'Формат ответа: строгий JSON. Верни строго один валидный JSON-объект. Не добавляй Markdown, пояснения или текст вне JSON. Никогда не помещай JSON-объект в строковое поле другого JSON-объекта и не экранируй его. Пример JSON-ответа: {"answer":"текст ответа"}.' }, ...messages]
        : messages;
      const requestBody = {
        model: model || 'deepseek-v4-flash',
        messages: requestMessages,
        temperature: parsedTemperature,
        // DeepSeek ignores temperature while thinking is enabled, so always disable it.
        thinking: { type: 'disabled' },
        stream: true,
        ...(parsedMaxTokens !== undefined && { max_tokens: parsedMaxTokens }),
        ...(stop && { stop: [stop] }),
        ...(jsonMode && { response_format: { type: 'json_object' } })
      };

      if (provider === 'gemini') {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) return sendJson(response, 500, { error: 'В локальном файле .env не задан GEMINI_API_KEY.' });
        const systemInstruction = jsonMode
          ? { parts: [{ text: 'Формат ответа: строгий JSON. Верни только один валидный JSON-объект без Markdown и пояснений.' }] }
          : undefined;
        const geminiBody = {
          contents: messages.map(message => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }]
          })),
          ...(systemInstruction && { systemInstruction }),
          generationConfig: {
            temperature: parsedTemperature,
            ...(parsedMaxTokens !== undefined && { maxOutputTokens: parsedMaxTokens }),
            ...(stop && { stopSequences: [stop] }),
            ...(jsonMode && { responseMimeType: 'application/json' })
          }
        };
        const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody)
        });
        if (!upstream.ok) return sendJson(response, upstream.status, { error: await upstreamError(upstream, 'Gemini вернул ошибку.') });
        return streamGemini(upstream, response);
      }
      const apiKey = provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : process.env.OPENROUTER_API_KEY;
      const serviceName = provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENROUTER_API_KEY';
      if (!apiKey) return sendJson(response, 500, { error: `В локальном файле .env не задан ${serviceName}.` });
      const upstream = await fetch(provider === 'deepseek' ? 'https://api.deepseek.com/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(provider === 'deepseek' ? requestBody : {
          ...requestBody,
          thinking: undefined
        })
      });
      if (!upstream.ok) return sendJson(response, upstream.status, { error: await upstreamError(upstream, `${provider === 'deepseek' ? 'DeepSeek' : 'OpenRouter'} вернул ошибку.`) });
      startStream(response);
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
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(safePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    response.end(data);
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Open http://localhost:3000'));
