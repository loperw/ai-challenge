import './lib/env.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from './lib/mcp-client.mjs';
import { retrieveRailKnowledge } from './lib/rag.mjs';
import { buildTicketNotification } from './lib/ticket-notification.mjs';
import { getTrainBookingForm, officialScheduleUrl } from './lib/railway.mjs';
import { renderTicketTransfer, renderTicketError } from './lib/ticket-booking.mjs';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(appDir, 'public');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
let mcpPromise;
const mcp = () => mcpPromise ||= new McpClient().initialize();

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function bodyJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 64_000) throw new Error('Запрос слишком большой.');
  }
  return JSON.parse(data || '{}');
}

function criteriaFrom(input) {
  const criteria = {
    from: String(input.from || '').trim(), to: String(input.to || '').trim(), date: String(input.date || ''),
    timeFrom: String(input.timeFrom || '00:00'), timeTo: String(input.timeTo || '23:59'),
    ticketTypes: Array.isArray(input.ticketTypes) ? input.ticketTypes : [],
    excludedTimes: Array.isArray(input.excludedTimes) ? input.excludedTimes : []
  };
  if (!criteria.from || !criteria.to || !/^\d{4}-\d{2}-\d{2}$/.test(criteria.date)) throw new Error('Заполните города и дату поездки.');
  if (criteria.timeFrom > criteria.timeTo) throw new Error('Начало диапазона должно быть раньше окончания.');
  return criteria;
}

async function runAgentSearch(input) {
  const criteria = criteriaFrom(input);
  const toolsClient = await mcp();
  const mcpTools = await toolsClient.listTools();
  const aiTools = mcpTools.filter((tool) => tool.name === 'search_tickets').map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
  const knowledge = retrieveRailKnowledge(`${criteria.from} ${criteria.to} ${criteria.ticketTypes.join(' ')} поиск места время`, 3);
  const messages = [
    { role: 'system', content: `Ты агент поиска билетов. Условия уже проверены сервером. Обязательно вызови search_tickets ровно один раз, передав условия без изменения. Не отправляй Telegram: это делает сервер после проверки результата. Не утверждай, что билеты есть, пока инструмент не вернул результат. Итоговое описание — краткий абзац по-русски без списков и Markdown. Начни с «По данным источника билетов» и укажи дату, маршрут, количество найденных вариантов и соблюдение условий поиска. Не перечисляй отдельные поезда, их номера, расписание, количество мест, тарифы, цены и ссылки: эти подробности уже показаны в карточках интерфейса. Заверши предложением: «Наличие и цены указаны по ответу источника; окончательная доступность подтверждается при открытии ссылки на билет.»\n\nСправка RAG:\n${knowledge.map((chunk) => chunk.text).join('\n\n')}` },
    { role: 'user', content: `Проверь реальные билеты по условиям: ${JSON.stringify(criteria)}` }
  ];
  const apiKey = process.env.DEEPSEEK_API_KEY;
  let toolResult;
  if (!apiKey) throw new Error('Не задан DEEPSEEK_API_KEY в локальном .env.');
  for (let step = 0; step < 4; step++) {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || 'deepseek-flash', messages, tools: aiTools, tool_choice: toolResult ? 'none' : 'required', thinking: { type: 'disabled' }, temperature: 0.1 }),
      signal: AbortSignal.timeout(35000)
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || `DeepSeek вернул HTTP ${response.status}.`);
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error('DeepSeek вернул пустой ответ.');
    messages.push(message);
    const calls = message.tool_calls || [];
    if (!calls.length) return { criteria, trains: toolResult?.structuredContent?.trains || [], answer: message.content || 'Поиск завершён.', knowledge: knowledge.map((chunk) => chunk.text) };
    for (const call of calls) {
      const args = JSON.parse(call.function.arguments || '{}');
      if (call.function.name !== 'search_tickets') throw new Error('Агент запросил неподдерживаемый инструмент.');
      toolResult = await toolsClient.callTool('search_tickets', { ...args, ...criteria });
      if (toolResult.isError) throw new Error(toolResult.content?.[0]?.text || 'Поиск билетов завершился ошибкой.');
      const searchResult = toolResult.structuredContent ?? JSON.parse(toolResult.content?.[0]?.text || '{}');
      // The model only needs the summary; full train details remain in the UI cards.
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ count: searchResult.trains?.length ?? searchResult.count ?? 0, criteria, filtersApplied: true }) });
    }
  }
  return { criteria, trains: toolResult?.structuredContent?.trains || [], answer: 'Поиск завершён.', knowledge: knowledge.map((chunk) => chunk.text) };
}

async function doSearch(input, notify = true) {
  const result = await runAgentSearch(input);
  const trains = result.trains || [];
  let notification = null;
  if (notify && trains.length && input.chatId) {
    const sent = await (await mcp()).callTool('send_telegram_notification', { chatId: input.chatId, ...buildTicketNotification(result.criteria, trains, input.name) });
    if (sent.isError) notification = { sent: false, error: sent.content?.[0]?.text || 'Не удалось отправить сообщение.' };
    else notification = { sent: true };
  }
  return { ...result, notification, checkedAt: new Date().toISOString() };
}

function mcpData(result) {
  if (result.isError) throw new Error(result.content?.[0]?.text || 'MCP-инструмент завершился ошибкой.');
  return result.structuredContent ?? JSON.parse(result.content?.[0]?.text || '{}');
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/status') {
      const client = await mcp();
      const active = mcpData(await client.callTool('list_monitors', {}));
      return sendJson(res, 200, { deepseekConfigured: Boolean(process.env.DEEPSEEK_API_KEY), telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN), railSourceConfigured: true, railSource: process.env.RAILWAY_SEARCH_URL ? 'custom JSON' : (process.env.RAILWAY_BASE_URL || 'pass.rw.by'), monitors: active.monitors });
    }
    if (req.method === 'POST' && req.url === '/api/search') {
      const input = await bodyJson(req);
      return sendJson(res, 200, await doSearch(input));
    }
    if (req.method === 'POST' && req.url === '/api/monitor/start') {
      const input = await bodyJson(req); criteriaFrom(input);
      if (!input.chatId) throw new Error('Введите Telegram ID для уведомлений.');
      const result = mcpData(await (await mcp()).callTool('start_monitoring', { criteria: criteriaFrom(input), chatId: input.chatId, name: input.name || '', everySeconds: input.everySeconds }));
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && req.url === '/api/monitor/stop') {
      const { id } = await bodyJson(req);
      return sendJson(res, 200, mcpData(await (await mcp()).callTool('stop_monitoring', { id })));
    }
    if (req.method === 'POST' && req.url === '/api/telegram/test') {
      const { chatId } = await bodyJson(req);
      const result = await (await mcp()).callTool('send_telegram_notification', { chatId, text: 'Тестовое уведомление от вашего агента поиска билетов.' });
      if (result.isError) throw new Error(result.content?.[0]?.text || 'Ошибка Telegram.');
      return sendJson(res, 200, { sent: true });
    }
    if (req.method !== 'GET') return sendJson(res, 404, { error: 'Маршрут не найден.' });
    const requestUrl = new URL(req.url, 'http://localhost');
    const pathname = requestUrl.pathname;
    if (pathname === '/open-ticket') {
      const criteria = {
        from: requestUrl.searchParams.get('from') || '', to: requestUrl.searchParams.get('to') || '',
        date: requestUrl.searchParams.get('date') || '', trainNumber: requestUrl.searchParams.get('train') || '',
        departureTime: requestUrl.searchParams.get('departure') || ''
      };
      let html;
      let status = 200;
      try {
        criteriaFrom(criteria);
        if (!criteria.trainNumber || !/^\d{2}:\d{2}$/.test(criteria.departureTime)) throw new Error('В ссылке не указан поезд или время отправления. Выполните поиск заново.');
        html = renderTicketTransfer(await getTrainBookingForm(criteria), criteria);
      } catch (error) {
        status = 400;
        html = renderTicketError(criteria, error.message, officialScheduleUrl(criteria));
      }
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      return res.end(html);
    }
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const filePath = path.resolve(publicDir, relative);
    if (!filePath.startsWith(`${publicDir}${path.sep}`) && filePath !== publicDir) return sendJson(res, 403, { error: 'Forbidden' });
    fs.readFile(filePath, (error, data) => {
      if (error) return sendJson(res, 404, { error: 'Файл не найден.' });
      res.writeHead(200, { 'content-type': mime[path.extname(filePath)] || 'application/octet-stream' }); res.end(data);
    });
  } catch (error) { sendJson(res, 400, { error: error.message || 'Не удалось выполнить запрос.' }); }
});

server.listen(Number(process.env.TICKET_AGENT_PORT) || 3035, '127.0.0.1', () => console.log(`Ticket agent available at http://127.0.0.1:${server.address().port}`));
server.on('close', () => { mcpPromise?.then((client) => client.close()).catch(() => {}); });
