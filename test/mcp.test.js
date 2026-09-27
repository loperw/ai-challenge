const assert = require('node:assert/strict');
const test = require('node:test');

test('MCP client connects and receives the registered weather tool schemas', async () => {
  const { listMcpTools } = await import('../mcp/client.mjs');
  const { server, tools } = await listMcpTools({ stderr: 'pipe' });

  assert.equal(server.name, 'open-meteo-weather');
  assert.equal(server.version, '1.0.0');
  assert.ok(Array.isArray(tools));

  const weatherTool = tools.find(tool => tool.name === 'get_weather');
  assert.ok(weatherTool, 'Expected get_weather in the MCP tools list');
  assert.match(weatherTool.description, /Open-Meteo API/);
  assert.equal(weatherTool.inputSchema.type, 'object');
  assert.equal(weatherTool.inputSchema.properties.location.type, 'string');
  assert.deepEqual(weatherTool.inputSchema.required, ['location']);
  assert.equal(weatherTool.outputSchema.properties.current.type, 'object');
  assert.equal(weatherTool.outputSchema.properties.forecast.type, 'array');
});
