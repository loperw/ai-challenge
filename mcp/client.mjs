import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultServerPath = fileURLToPath(new URL('./server.mjs', import.meta.url));

export async function listMcpTools({
  command = process.execPath,
  args = [defaultServerPath],
  cwd = process.cwd(),
  stderr = 'inherit'
} = {}) {
  const client = new Client({ name: 'tools-list-client', version: '1.0.0' });
  const transport = new StdioClientTransport({ command, args, cwd, stderr });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();

    return {
      server: client.getServerVersion(),
      tools
    };
  } finally {
    await client.close();
  }
}

const isMainModule = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  try {
    const result = await listMcpTools();
    const serverLabel = result.server
      ? `${result.server.name} v${result.server.version}`
      : 'unknown server';

    console.log(`MCP connection established: ${serverLabel}`);
    console.log(JSON.stringify(result.tools, null, 2));
  } catch (error) {
    console.error(`MCP connection failed: ${error.message}`);
    process.exitCode = 1;
  }
}
