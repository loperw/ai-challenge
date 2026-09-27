const assert = require('node:assert/strict');
const test = require('node:test');

test('MCP client connects and receives the registered tools', async () => {
  const { listMcpTools } = await import('../mcp/client.mjs');
  const { server, tools } = await listMcpTools({ stderr: 'pipe' });

  assert.equal(server.name, 'local-tools-server');
  assert.equal(server.version, '1.0.0');
  assert.ok(Array.isArray(tools));

  const echoTool = tools.find(tool => tool.name === 'echo');
  assert.ok(echoTool, 'Expected the echo tool in the MCP tools list');
  assert.equal(echoTool.description, 'Returns the supplied message unchanged.');
  assert.equal(echoTool.inputSchema.type, 'object');
  assert.equal(echoTool.inputSchema.properties.message.type, 'string');
  assert.deepEqual(echoTool.inputSchema.required, ['message']);
});
