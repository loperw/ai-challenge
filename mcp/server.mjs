import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const weatherDescriptions = {
  0: 'ясно', 1: 'преимущественно ясно', 2: 'переменная облачность', 3: 'пасмурно',
  45: 'туман', 48: 'изморозевый туман', 51: 'слабая морось', 53: 'морось', 55: 'сильная морось',
  61: 'слабый дождь', 63: 'дождь', 65: 'сильный дождь', 71: 'слабый снег', 73: 'снег', 75: 'сильный снег',
  80: 'слабые ливни', 81: 'ливни', 82: 'сильные ливни', 85: 'снежные заряды', 86: 'сильные снежные заряды',
  95: 'гроза', 96: 'гроза с градом', 99: 'сильная гроза с градом'
};

const weatherOutputSchema = z.object({
  source: z.string().describe('Источник погодных данных'),
  location: z.string().describe('Найденное название места'),
  coordinates: z.object({ latitude: z.number(), longitude: z.number() }),
  timezone: z.string(),
  units: z.object({ temperature: z.string(), windSpeed: z.string() }),
  current: z.object({
    observedAt: z.string(), temperature: z.number(), apparentTemperature: z.number(),
    humidity: z.number(), windSpeed: z.number(), weatherCode: z.number(), conditions: z.string()
  }),
  forecast: z.array(z.object({
    date: z.string(), minTemperature: z.number(), maxTemperature: z.number(),
    precipitationProbability: z.number(), weatherCode: z.number(), conditions: z.string()
  }))
});

async function fetchJson(url, label) {
  const response = await fetch(url, { headers: { 'User-Agent': 'agent-mcp-weather/1.0' }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${label} вернул ${response.status}.`);
  return response.json();
}

async function getWeather({ location, days, units }) {
  const geocoding = new URL('https://geocoding-api.open-meteo.com/v1/search');
  geocoding.search = new URLSearchParams({ name: location, count: '1', language: 'ru', format: 'json' });
  const placeData = await fetchJson(geocoding, 'Геокодер Open-Meteo');
  const place = placeData.results?.[0];
  if (!place) throw new Error(`Место «${location}» не найдено.`);

  const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
  forecastUrl.search = new URLSearchParams({
    latitude: String(place.latitude), longitude: String(place.longitude), timezone: 'auto', forecast_days: String(days),
    temperature_unit: units, wind_speed_unit: units === 'fahrenheit' ? 'mph' : 'kmh',
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
  });
  const data = await fetchJson(forecastUrl, 'Прогноз Open-Meteo');
  const locationLabel = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
  const result = {
    source: 'Open-Meteo', location: locationLabel,
    coordinates: { latitude: place.latitude, longitude: place.longitude }, timezone: data.timezone,
    units: { temperature: data.current_units.temperature_2m, windSpeed: data.current_units.wind_speed_10m },
    current: {
      observedAt: data.current.time, temperature: data.current.temperature_2m,
      apparentTemperature: data.current.apparent_temperature, humidity: data.current.relative_humidity_2m,
      windSpeed: data.current.wind_speed_10m, weatherCode: data.current.weather_code,
      conditions: weatherDescriptions[data.current.weather_code] || 'неизвестные условия'
    },
    forecast: data.daily.time.map((date, index) => ({
      date, minTemperature: data.daily.temperature_2m_min[index], maxTemperature: data.daily.temperature_2m_max[index],
      precipitationProbability: data.daily.precipitation_probability_max[index], weatherCode: data.daily.weather_code[index],
      conditions: weatherDescriptions[data.daily.weather_code[index]] || 'неизвестные условия'
    }))
  };
  return result;
}

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

await server.connect(new StdioServerTransport());
