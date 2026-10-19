import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openMcpSession } from './client.mjs';

const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url));
const configPath = fileURLToPath(new URL('./servers.json', import.meta.url));
let mapsQueue = Promise.resolve();
let nextMapCall = 0;
function throttleMaps(action) {
  const run = mapsQueue.then(async () => {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, nextMapCall - Date.now())));
    try { return await action(); } finally { nextMapCall = Date.now() + 1100; }
  });
  mapsQueue = run.catch(() => {});
  return run;
}

export async function openMultiMcpSession({ registry, env = {}, stderr = 'inherit', connect = openMcpSession } = {}) {
  const entries = registry ?? JSON.parse(await readFile(process.env.MCP_SERVERS_FILE || configPath, 'utf8')).servers;
  if (!Array.isArray(entries)) throw new Error('MCP registry must contain a servers array.');
  const ids = new Set();
  for (const entry of entries) {
    if (!/^[a-z][a-z0-9_]{0,19}$/.test(entry.id) || ids.has(entry.id)) throw new Error('Invalid or duplicate MCP server id.');
    if (!['maps', 'weather', 'documents', 'schedules', 'workspace'].includes(entry.role)) throw new Error(`Unknown MCP role: ${entry.role}`);
    ids.add(entry.id);
  }
  const sessions = new Map(), routes = new Map(), sources = new Map(), imported = new Set();
  const tools = [], servers = [], transfers = [];
  const close = async () => { await Promise.allSettled([...sessions.values()].map(session => session.close())); sessions.clear(); sources.clear(); };
  try {
    for (const entry of entries.filter(entry => entry.enabled !== false)) {
      let session;
      try {
        session = await connect({ args: [serverPath, entry.role], stderr, env });
        sessions.set(entry.id, session);
        for (const tool of session.tools.filter(tool => !tool.name.startsWith('_'))) {
          const name = `${entry.id}__${tool.name}`;
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || routes.has(name)) throw new Error(`Invalid tool name: ${name}`);
          routes.set(name, { serverId: entry.id, role: entry.role, toolName: tool.name });
          tools.push({ ...tool, name, serverId: entry.id, toolName: tool.name,
            description: `[MCP server: ${entry.id}] ${tool.description || tool.name}` });
        }
        servers.push({ id: entry.id, ...session.server, status: 'connected' });
      } catch (error) {
        if (session) throw error;
        servers.push({ id: entry.id, status: 'unavailable', error: error.message });
      }
    }
    if (!sessions.size) throw new Error(`Нет доступных MCP-серверов: ${servers.map(s => `${s.id}: ${s.error}`).join('; ')}`);
    return { tools, servers, transfers, close,
      routeFor: name => routes.get(name),
      async callTool(name, args) {
        const route = routes.get(name);
        if (!route) throw new Error(`Unknown MCP tool: ${name}`);
        const session = sessions.get(route.serverId);
        if (!session) throw new Error('MCP session is closed.');
        if (route.role === 'documents' && ['summarize', 'saveToFile', 'combine_sources'].includes(route.toolName)) {
          const refs = route.toolName === 'combine_sources' ? args.sourceIds : (args.sourceId ? [args.sourceId] : []);
          if (!Array.isArray(refs) || refs.some(id => typeof id !== 'string' || !sources.has(id))) throw new Error('sourceId не найден в этом ходе. Используйте только ID успешных результатов.');
          for (const id of refs) {
            const source = sources.get(id), key = `${route.serverId}:${id}`;
            if (source.serverId === route.serverId || imported.has(key)) continue;
            const result = await session.callTool('_import_source', { sourceId: id, text: source.data.text,
              ...(source.role === 'weather' && { weather: source.data }) });
            transfers.push({ sourceId: id, from: source.serverId, to: route.serverId, tool: '_import_source', status: result.isError ? 'error' : 'done' });
            if (result.isError) return result;
            imported.add(key);
          }
        }
        const action = () => session.callTool(route.toolName, args);
        const result = await (route.role === 'maps' ? throttleMaps(action) : action());
        const data = result.structuredContent;
        if (!result.isError && typeof data?.sourceId === 'string' && typeof data.text === 'string') {
          if (sources.has(data.sourceId)) throw new Error('Duplicate sourceId returned by MCP server.');
          sources.set(data.sourceId, { data: structuredClone(data), serverId: route.serverId, role: route.role });
        }
        return result;
      }
    };
  } catch (error) { await close(); throw error; }
}
