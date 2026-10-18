import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
// Trust only this fixed application checkout for this command (no global Git changes).
const git = async args => (await execute('git', ['-c', `safe.directory=${root.replace(/\\/g, '/').replace(/\/$/, '')}`, '-C', root, ...args], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trim();
const server = new McpServer({ name: 'project-context', version: '1.0.0' });
server.registerTool('git_context', {
  description: 'Текущая git-ветка, commit и список отслеживаемых файлов собственного репозитория чат-бота. Только чтение.',
  inputSchema: z.object({}), annotations: { readOnlyHint: true, openWorldHint: false }
}, async () => {
  try {
    const branch = await git(['branch', '--show-current']);
    const commit = await git(['rev-parse', 'HEAD']);
    const files = (await git(['ls-files', '-z'])).split('\0').filter(Boolean);
    const data = { branch: branch || null, detached: !branch, commit, files: files.slice(0, 300), truncated: files.length > 300 };
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: `Не удалось прочитать Git: ${error.message}` }] }; }
});
await server.connect(new StdioServerTransport());
