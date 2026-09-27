import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

import { getWeather, weatherOutputSchema, weatherText } from './weather.mjs';
import { registerSchedulerTools } from './scheduler-tools.mjs';
import { registerPipelineTools } from './pipeline-tools.mjs';

const server = new McpServer({ name: 'open-meteo-weather', version: '1.0.0' });
const artifacts = new Map();

server.registerTool('get_weather', {
  title: 'Погода Open-Meteo',
  description: 'Получает текущую погоду и прогноз для города через Open-Meteo API. Возвращает исходные данные, полный text и sourceId. Если пользователь просит подвести итог или сделать краткую сводку, передай sourceId инструменту summarize после получения прогноза. Сам инструмент только получает данные, не выполняет суммаризацию.',
  inputSchema: z.object({
    location: z.string().min(2).max(120).describe('Город или населённый пункт, например: Moscow'),
    days: z.number().int().min(1).max(7).default(1).describe('Число дней прогноза от 1 до 7'),
    units: z.enum(['celsius', 'fahrenheit']).default('celsius').describe('Единица температуры')
  }),
  outputSchema: weatherOutputSchema.extend({ sourceId: z.string(), text: z.string() }),
  annotations: { readOnlyHint: true, openWorldHint: true }
}, async input => {
  try {
    const weather = await getWeather(input);
    const sourceId = randomUUID();
    const text = weatherText(weather);
    artifacts.set(sourceId, { text, weather });
    const output = { ...weather, sourceId, text };
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], structuredContent: output };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message || 'Не удалось получить погоду.' }] };
  }
});

registerSchedulerTools(server);
registerPipelineTools(server, { artifacts });
await server.connect(new StdioServerTransport());
