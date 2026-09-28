import { openMultiMcpSession } from '../mcp/registry.mjs';
const session = await openMultiMcpSession();
try { console.log(JSON.stringify({ servers: session.servers, tools: session.tools }, null, 2)); }
finally { await session.close(); }
