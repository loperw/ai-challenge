import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultServerPath = fileURLToPath(new URL('./server.mjs', import.meta.url));

function clientConnection({ command = process.execPath, args = [defaultServerPath], cwd = process.cwd(), stderr = 'inherit' } = {}) {
  const client = new Client({ name: 'agent-chat-mcp-client', version: '1.0.0' });
  const transport = new StdioClientTransport({ command, args, cwd, stderr });
  return { client, transport };
}

export async function listMcpTools(options = {}) {
  const { client, transport } = clientConnection(options);
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return { server: client.getServerVersion(), tools };
  } finally { await client.close(); }
}

export function weatherArguments(message, { previousMessages = [] } = {}) {
  const text = typeof message === 'string' ? message.trim() : '';
  const explicitWeatherRequest = /(?:\/weather\b|weather|forecast|temperature|погод|прогноз|температур)/iu.test(text);
  const previousAssistant = [...previousMessages].reverse().find(item => item.role === 'assistant');
  const previousUser = [...previousMessages].reverse().find(item => item.role === 'user' && !item.hidden && !item.actionMessage);
  const previousWeatherRequest = [...previousMessages].reverse().find(item => item.role === 'user'
    && /(?:\/weather\b|weather|forecast|temperature|погод|прогноз|температур)/iu.test(item.content || ''));
  const previousWeatherTurn = /Источник:\s*MCP tool get_weather\b/iu.test(previousAssistant?.content || '')
    || /(?:\/weather\b|weather|forecast|temperature|погод|прогноз|температур)/iu.test(previousUser?.content || '');
  const locationFollowUp = /^(?:а\s+)?(?:в|во|in)\s+[\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?(?:\s+на\s+[1-7]\s+(?:день|дня|дней|days?))?[?.!]*$/iu.test(text)
    && !/\b(?:открой|найди|покажи|расскажи|закажи|посоветуй|предложи|open|find|show|tell|order)\b/iu.test(text);
  if (!explicitWeatherRequest && !(previousWeatherTurn && locationFollowUp)) return null;
  const slash = text.match(/^\/weather\s+(.+)$/iu);
  const afterPreposition = text.match(/(?:\b(?:in|for|at)\b|(?:^|\s)(?:в|во|для))\s+([\p{L}][\p{L} .'-]{1,80})/iu);
  let location = (slash?.[1] || afterPreposition?.[1] || '')
    .replace(/\s+(?:today|tomorrow|now|сегодня|завтра|сейчас|на\s+\d+\s+д\w*)[?.!,\s]*$/iu, '')
    .replace(/\s+на\s*$/iu, '')
    .replace(/[?.!,]+$/u, '').trim();
  if (slash) location = location.replace(/\s+--days\s+\d+.*$/iu, '').trim();
  if (!location) return null;
  const russianLocationAliases = new Map([
    ['москве', 'Москва'], ['минске', 'Минск'], ['санкт-петербурге', 'Санкт-Петербург'], ['петербурге', 'Санкт-Петербург'],
    ['новосибирске', 'Новосибирск'], ['екатеринбурге', 'Екатеринбург'], ['казани', 'Казань'],
    ['нижнем новгороде', 'Нижний Новгород'], ['калининграде', 'Калининград']
  ]);
  location = russianLocationAliases.get(location.toLocaleLowerCase('ru')) || location;
  const daysMatch = text.match(/(?:--days\s+|на\s+)([1-7])(?:\s|д|$)/iu);
  const previousDays = locationFollowUp && previousWeatherRequest
    ? weatherArguments(previousWeatherRequest.content)?.days : null;
  const days = daysMatch ? Number(daysMatch[1]) : /tomorrow|завтра/iu.test(text) ? 2 : previousDays || 1;
  const units = /fahrenheit|фаренгейт/iu.test(text) || locationFollowUp
    && previousWeatherRequest && weatherArguments(previousWeatherRequest.content)?.units === 'fahrenheit'
    ? 'fahrenheit' : 'celsius';
  return { location, days, units };
}

function traceStep(id, title, method, schema, status = 'waiting') {
  return { id, title, method, status, schema };
}

export async function callWeatherForAgent(message, { onTrace = () => {}, connection = {}, previousMessages = [] } = {}) {
  const toolArguments = weatherArguments(message, { previousMessages });
  if (!toolArguments) return null;
  const trace = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, status: 'running', startedAt: new Date().toISOString(),
    server: null, tool: null, arguments: toolArguments, result: null,
    steps: [
      traceStep('connect', 'Подключение и discovery', 'initialize → tools/list', { output: { server: 'Implementation', tools: 'Tool[]' } }, 'running'),
      traceStep('route', 'Выбор инструмента', 'Agent router', { input: { message: 'string', tools: 'Tool[]' }, output: { tool: 'string', arguments: 'object' } }),
      traceStep('validate', 'Валидация аргументов', 'JSON Schema', { pending: 'Схема будет получена из tools/list' }),
      traceStep('call', 'Вызов MCP tool', 'tools/call', { input: { name: 'string', arguments: 'object' }, output: { content: 'Content[]', structuredContent: 'object' } }),
      traceStep('use', 'Использование результата', 'MCP → Agent context → LLM', { input: { tool: 'string', result: 'structuredContent' }, output: { answer: 'string' } })
    ]
  };
  const emit = () => onTrace(structuredClone(trace));
  const fail = error => {
    trace.status = 'error'; trace.error = error.message || String(error);
    const active = trace.steps.find(step => step.status === 'running');
    if (active) { active.status = 'error'; active.error = trace.error; }
    emit();
  };
  emit();
  const { client, transport } = clientConnection(connection);
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    trace.server = client.getServerVersion();
    trace.steps[0].status = 'done'; trace.steps[0].data = { server: trace.server, tools: tools.map(tool => tool.name) };
    trace.steps[1].status = 'running'; emit();

    const tool = tools.find(item => item.name === 'get_weather');
    if (!tool) throw new Error('MCP-сервер не зарегистрировал get_weather.');
    trace.tool = { name: tool.name, title: tool.title, description: tool.description };
    trace.steps[1].status = 'done'; trace.steps[1].data = { tool: tool.name, arguments: toolArguments };
    trace.steps[2].status = 'running'; trace.steps[2].schema = { inputSchema: tool.inputSchema }; emit();

    trace.steps[2].status = 'done'; trace.steps[2].data = toolArguments;
    trace.steps[3].status = 'running'; trace.steps[3].schema = { inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }; emit();
    const result = await client.callTool({ name: tool.name, arguments: toolArguments });
    if (result.isError) throw new Error(result.content?.map(item => item.text || '').filter(Boolean).join('\n') || 'MCP tool вернул ошибку.');
    trace.result = result.structuredContent ?? result.content;
    trace.steps[3].status = 'done'; trace.steps[3].data = trace.result;
    trace.steps[4].status = 'running'; emit();
    return {
      trace,
      context: [`MCP-сервер ${trace.server?.name || 'unknown'} вызвал инструмент ${tool.name}.`,
        `Аргументы: ${JSON.stringify(toolArguments)}.`, `Результат MCP: ${JSON.stringify(trace.result)}.`,
        `Ответь на запрос, опираясь на эти данные. В конце кратко укажи: «Источник: MCP tool ${tool.name} (${trace.result.source || 'API'})».`].join('\n')
    };
  } catch (error) { fail(error); throw error; }
  finally { await client.close(); }
}

export function completeAgentTrace(trace, onTrace = () => {}) {
  if (!trace) return;
  trace.status = 'done'; trace.completedAt = new Date().toISOString();
  const last = trace.steps.at(-1); last.status = 'done'; last.data = { answer: 'Результат MCP добавлен в контекст и использован моделью.' };
  onTrace(structuredClone(trace));
}

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMainModule) {
  try {
    const result = await listMcpTools();
    console.log(`MCP connection established: ${result.server?.name || 'unknown'} v${result.server?.version || '?'}`);
    console.log(JSON.stringify(result.tools, null, 2));
  } catch (error) { console.error(`MCP connection failed: ${error.message}`); process.exitCode = 1; }
}
