import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import fs from 'node:fs';
const server = new McpServer({ name: 'support-demo-crm', version: '1.0.0' });
const read = () => JSON.parse(fs.readFileSync(process.env.SUPPORT_DATA_FILE || new URL('../support/demo.json', import.meta.url), 'utf8'));
function register(name, description, schema, action) {
  server.registerTool(name, { description, inputSchema: z.object(schema), annotations: { readOnlyHint: true, openWorldHint: false } }, async args => {
    try {
      const data = action(read(), args);
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
}
const id = z.string().min(1).max(80);
register('list_users', 'Демонстрационные пользователи поддержки.', {}, db => ({ users: db.users, demo: true }));
register('list_tickets', 'Тикеты выбранного пользователя.', { userId: id }, (db, { userId }) => {
  if (!db.users.some(user => user.id === userId)) throw new Error('Пользователь не найден.');
  return { tickets: db.tickets.filter(ticket => ticket.userId === userId) };
});
register('get_context', 'Профиль пользователя и его тикет с историей. Чужой тикет отклоняется.', { userId: id, ticketId: id.optional() }, (db, { userId, ticketId }) => {
  const user = db.users.find(user => user.id === userId);
  if (!user) throw new Error('Пользователь не найден.');
  const ticket = ticketId ? db.tickets.find(ticket => ticket.id === ticketId && ticket.userId === userId) : null;
  if (ticketId && !ticket) throw new Error('Тикет не найден у выбранного пользователя.');
  return { user, ticket, demo: true };
});
await server.connect(new StdioServerTransport());
