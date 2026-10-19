import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultServerPath = fileURLToPath(new URL('./server.mjs', import.meta.url));

function clientConnection({ command = process.execPath, args = [defaultServerPath], cwd = process.cwd(), stderr = 'inherit', env = {} } = {}) {
  const client = new Client({ name: 'agent-chat-mcp-client', version: '1.0.0' });
  const transport = new StdioClientTransport({ command, args, cwd, stderr,
    env: { ...Object.fromEntries(['FILE_WORKSPACE_ROOT', 'SCHEDULE_DB_PATH', 'PIPELINE_SEARCH_FILE', 'PIPELINE_OUTPUT_DIR']
      .filter(key => process.env[key]).map(key => [key, process.env[key]])), ...env } });
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

// Keep one server alive across all LLM rounds so sourceId artifacts remain valid.
export async function openMcpSession(options = {}) {
  const { client, transport } = clientConnection(options);
  try {
    await client.connect(transport);
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools); cursor = page.nextCursor;
    } while (cursor);
    return { tools, server: client.getServerVersion(),
      callTool: (name, args) => client.callTool({ name, arguments: args }),
      close: () => client.close() };
  } catch (error) { await client.close(); throw error; }
}

function traceStep(id, title, method, schema, status = 'waiting') {
  return { id, title, method, status, schema };
}

export async function callToolForAgent(toolName, toolArguments, { onTrace = () => {}, connection = {} } = {}) {
  if (!toolArguments) return null;
  const trace = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, status: 'running', startedAt: new Date().toISOString(),
    server: null, tool: null, arguments: toolArguments, result: null,
    steps: [
      traceStep('connect', 'Подключение и discovery', 'initialize → tools/list', { output: { server: 'Implementation', tools: 'Tool[]' } }, 'running'),
      traceStep('route', 'Запрошенный инструмент', 'Direct API call', { input: { message: 'string', tools: 'Tool[]' }, output: { tool: 'string', arguments: 'object' } }),
      traceStep('validate', 'Валидация аргументов', 'JSON Schema', { pending: 'Схема будет получена из tools/list' }),
      traceStep('call', 'Вызов MCP tool', 'tools/call', { input: { name: 'string', arguments: 'object' }, output: { content: 'Content[]', structuredContent: 'object' } }),
      traceStep('use', 'Использование результата', 'MCP → Agent → ответ', { input: { tool: 'string', result: 'structuredContent' }, output: { answer: 'string' } })
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

    const tool = tools.find(item => item.name === toolName);
    if (!tool) throw new Error(`MCP-сервер не зарегистрировал ${toolName}.`);
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
  const last = trace.steps.at(-1); last.status = 'done'; last.data = { answer: 'Результат MCP использован в ответе агента.' };
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
