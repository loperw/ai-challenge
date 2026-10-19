import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { appDir } from './env.mjs';

export class McpClient {
  constructor() {
    this.child = spawn(process.execPath, [fileURLToPath(new URL('../mcp-server.mjs', import.meta.url))], { cwd: appDir, stdio: ['pipe', 'pipe', 'ignore'] });
    this.nextId = 1;
    this.pending = new Map();
    this.reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.reader.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id == null) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    });
    this.child.on('exit', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('MCP server завершился.'));
      this.pending.clear();
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Истекло время ожидания MCP ${method}.`)); }, 25000);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async initialize() {
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'rail-ticket-web-agent', version: '0.1.0' } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return this;
  }

  async listTools() { return (await this.request('tools/list')).tools || []; }
  async callTool(name, args) { return this.request('tools/call', { name, arguments: args }); }
  close() { this.reader.close(); this.child.kill(); }
}
