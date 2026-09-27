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

test('agent weather router builds MCP arguments from chat text', async () => {
  const { weatherArguments } = await import('../mcp/client.mjs');
  assert.deepEqual(weatherArguments('Какая погода в Moscow на 3 дня?'), { location: 'Moscow', days: 3, units: 'celsius' });
  assert.deepEqual(weatherArguments('Какая погода в Москве?'), { location: 'Москва', days: 1, units: 'celsius' });
  assert.deepEqual(weatherArguments('/weather Berlin --days 2'), { location: 'Berlin', days: 2, units: 'celsius' });
  assert.equal(weatherArguments('Объясни MCP одним абзацем'), null);
  const previousMessages = [
    { role: 'user', content: 'Какая погода в Москве?' },
    { role: 'assistant', content: 'Пасмурно. Источник: MCP tool get_weather (Open-Meteo)' }
  ];
  assert.deepEqual(weatherArguments('а в минске', { previousMessages }), { location: 'Минск', days: 1, units: 'celsius' });
  assert.deepEqual(weatherArguments('а в минске', { previousMessages: [
    { role: 'user', content: 'Какая погода в Москве на 3 дня?' },
    { role: 'assistant', content: 'Источник: MCP tool get_weather (Open-Meteo)' }
  ] }), { location: 'Минск', days: 3, units: 'celsius' });
  assert.equal(weatherArguments('а в минске'), null);
  assert.equal(weatherArguments('а в минске открой ресторан', { previousMessages }), null);
});
