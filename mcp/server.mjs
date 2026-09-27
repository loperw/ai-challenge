import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { getWeather, weatherOutputSchema } from './weather.mjs';
import { registerSchedulerTools } from './scheduler-tools.mjs';

const server = new McpServer({ name: 'open-meteo-weather', version: '1.0.0' });

server.registerTool('get_weather', {
  title: 'Погода Open-Meteo',
  description: 'Получает текущую погоду и прогноз для города через Open-Meteo API.',
  inputSchema: z.object({
    location: z.string().min(2).max(120).describe('Город или населённый пункт, например: Moscow'),
    days: z.number().int().min(1).max(7).default(1).describe('Число дней прогноза от 1 до 7'),
    units: z.enum(['celsius', 'fahrenheit']).default('celsius').describe('Единица температуры')
  }),
  outputSchema: weatherOutputSchema,
  annotations: { readOnlyHint: true, openWorldHint: true }
}, async input => {
  try {
    const output = await getWeather(input);
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], structuredContent: output };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message || 'Не удалось получить погоду.' }] };
  }
});

registerSchedulerTools(server);
await server.connect(new StdioServerTransport());
