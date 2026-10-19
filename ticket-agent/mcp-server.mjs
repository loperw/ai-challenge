import readline from 'node:readline';
import { searchTickets, applyInvariants } from './lib/railway.mjs';
import { sendTelegramNotification } from './lib/telegram.mjs';
import { buildTicketNotification } from './lib/ticket-notification.mjs';
import { monitorSnapshot } from './lib/monitor-summary.mjs';

const tools = [
  {
    name: 'search_tickets',
    description: 'Запрашивает актуальное расписание и наличие билетов в настроенном источнике, затем применяет ограничения времени, исключения и типы мест.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' }, to: { type: 'string' }, date: { type: 'string' },
        timeFrom: { type: 'string' }, timeTo: { type: 'string' },
        ticketTypes: { type: 'array', items: { type: 'string', enum: ['плацкарт', 'купе', 'сидячий', 'СВ'] } },
        excludedTimes: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } }
      },
      required: ['from', 'to', 'date']
    }
  },
  {
    name: 'start_monitoring',
    description: 'Запускает периодическую проверку маршрута и Telegram-уведомления с объяснением DeepSeek при изменении результатов.',
    inputSchema: {
      type: 'object', properties: {
        criteria: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, date: { type: 'string' }, timeFrom: { type: 'string' }, timeTo: { type: 'string' }, ticketTypes: { type: 'array', items: { type: 'string' } }, excludedTimes: { type: 'array', items: { type: 'object' } } }, required: ['from', 'to', 'date'] },
        chatId: { type: 'string' }, name: { type: 'string' }, everySeconds: { type: 'integer', minimum: 30, maximum: 3600 }
      }, required: ['criteria', 'chatId']
    }
  },
  {
    name: 'stop_monitoring', description: 'Останавливает ранее запущенную периодическую проверку.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'list_monitors', description: 'Возвращает статус мониторингов, запущенных в текущем процессе.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'send_telegram_notification',
    description: 'Отправляет уведомление в Telegram о найденных билетах.',
    inputSchema: {
      type: 'object', properties: {
        chatId: { type: 'string' }, text: { type: 'string' },
        entities: { type: 'array', items: {
          type: 'object', properties: {
            type: { type: 'string', enum: ['text_link'] }, offset: { type: 'integer', minimum: 0 },
            length: { type: 'integer', minimum: 1 }, url: { type: 'string' }
          }, required: ['type', 'offset', 'length', 'url']
        } }
      }, required: ['chatId', 'text']
    }
  }
];

const monitors = new Map();

async function checkMonitor(monitor) {
  if (monitor.checking) return;
  monitor.checking = true;
  try {
    const trains = applyInvariants(await searchTickets(monitor.criteria), monitor.criteria);
    if (monitors.get(monitor.id) !== monitor) return;
    monitor.lastChecked = new Date().toISOString();
    monitor.lastCount = trains.length;
    monitor.lastError = null;
    const snapshot = monitorSnapshot(trains);
    const signature = JSON.stringify(snapshot);
    if (signature === monitor.lastSignature || (!trains.length && monitor.lastSnapshot === null)) {
      return;
    }
    await sendTelegramNotification({
      chatId: monitor.chatId,
      ...buildTicketNotification(monitor.criteria, trains, monitor.name)
    });
    if (monitors.get(monitor.id) === monitor) {
      monitor.lastSignature = signature;
      monitor.lastSnapshot = snapshot;
    }
  } catch (error) {
    monitor.lastChecked = new Date().toISOString();
    monitor.lastError = error.message;
  } finally {
    monitor.checking = false;
  }
}

async function callTool(name, args) {
  if (name === 'search_tickets') {
    const trains = applyInvariants(await searchTickets(args), args);
    return { trains, count: trains.length, source: process.env.RAILWAY_SEARCH_URL ? 'configured' : 'unconfigured' };
  }
  if (name === 'start_monitoring') {
    const everySeconds = Math.max(30, Math.min(3600, Number(args.everySeconds) || 300));
    const chatId = String(args.chatId);
    const monitorName = String(args.name || '');
    const existing = [...monitors.values()].find((monitor) =>
      monitor.chatId === chatId && monitor.name === monitorName && monitor.everySeconds === everySeconds &&
      JSON.stringify(monitor.criteria) === JSON.stringify(args.criteria)
    );
    if (existing) return { id: existing.id, everySeconds, status: 'running', alreadyRunning: true };
    const id = crypto.randomUUID();
    const monitor = { id, criteria: args.criteria, chatId, name: monitorName, everySeconds, lastChecked: null, lastCount: 0, lastError: null, lastSignature: '', lastSnapshot: null };
    monitor.timer = setInterval(() => checkMonitor(monitor), everySeconds * 1000);
    monitor.timer.unref?.();
    monitors.set(id, monitor);
    void checkMonitor(monitor);
    return { id, everySeconds, status: 'running' };
  }
  if (name === 'stop_monitoring') {
    const monitor = monitors.get(args.id);
    if (!monitor) throw new Error('Мониторинг не найден.');
    clearInterval(monitor.timer); monitors.delete(args.id);
    return { stopped: true };
  }
  if (name === 'list_monitors') {
    return { monitors: [...monitors.values()].map(({ id, everySeconds, lastChecked, lastCount, lastError }) => ({ id, everySeconds, lastChecked, lastCount, lastError })) };
  }
  if (name === 'send_telegram_notification') return sendTelegramNotification(args);
  throw new Error(`Неизвестный инструмент: ${name}`);
}

function write(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'notifications/initialized') return;
  if (request.method === 'initialize') {
    return write({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'rail-ticket-agent', version: '0.1.0' } } });
  }
  if (request.method === 'ping') return write({ jsonrpc: '2.0', id: request.id, result: {} });
  if (request.method === 'tools/list') return write({ jsonrpc: '2.0', id: request.id, result: { tools } });
  if (request.method === 'tools/call') {
    try {
      const result = await callTool(request.params?.name, request.params?.arguments || {});
      return write({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false } });
    } catch (error) {
      return write({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: error.message }], isError: true } });
    }
  }
  if (request.id !== undefined) write({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } });
});
