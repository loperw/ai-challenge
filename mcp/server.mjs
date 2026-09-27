import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const server = new McpServer({
  name: 'local-tools-server',
  version: '1.0.0'
});

server.registerTool(
  'echo',
  {
    title: 'Echo',
    description: 'Returns the supplied message unchanged.',
    inputSchema: z.object({
      message: z.string().describe('Message to return')
    })
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: message }]
  })
);

await server.connect(new StdioServerTransport());
