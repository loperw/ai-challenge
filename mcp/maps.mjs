import { z } from 'zod';
import { randomUUID } from 'node:crypto';

const placeSchema = z.object({ name: z.string(), latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180), admin1: z.string().optional(), country: z.string().optional() });

export function registerMapsTools(server, { fetchImpl = globalThis.fetch } = {}) {
  const places = new Map();
  const get = async (url, label) => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'AI-Challenge-RoutePlanner/1.0' } });
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}. Попробуйте позже.`);
    return response.json();
  };
  const handler = action => async args => {
    try {
      const data = { ...await action(args), sourceId: randomUUID() };
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  };
  server.registerTool('geocode', {
    title: 'Найти город на карте',
    description: 'Ищет ГОРОДА и населённые пункты через Open-Meteo/GeoNames без API-ключа. Не ищет улицы и дома. Возвращает до 3 вариантов с placeId и координатами. Для маршрута сначала найди обе точки и используй их placeId. При неоднозначности уточни регион, не угадывай.',
    inputSchema: z.object({ query: z.string().trim().min(2).max(120), countryCode: z.string().regex(/^[A-Z]{2}$/).optional() }),
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, handler(async ({ query, countryCode }) => {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.search = new URLSearchParams({ name: query, count: '3', language: 'ru', format: 'json', ...(countryCode && { countryCode }) });
    const data = await get(url, 'Геокодер');
    const results = (data.results || []).map(raw => {
      const place = placeSchema.parse(raw);
      const result = { ...place, label: [place.name, place.admin1, place.country].filter(Boolean).join(', '), placeId: randomUUID() };
      places.set(result.placeId, result);
      return result;
    });
    if (!results.length) throw new Error(`Город «${query}» не найден. Уточните название.`);
    return { results, source: 'Open-Meteo / GeoNames', text: results.map(p => `${p.label}: ${p.latitude}, ${p.longitude}`).join('\n') };
  }));
  server.registerTool('route', {
    title: 'Построить автомобильный маршрут',
    description: 'Строит реальный автомобильный маршрут между городами через OSRM/OpenStreetMap без API-ключа. Требует originId и destinationId из предыдущих geocode в этом ходе. Возвращает километры, минуты, основные дороги, ссылку на карту, text и sourceId. Время без пробок. Пеший маршрут, велосипед, общественный транспорт и адреса домов не поддерживаются.',
    inputSchema: z.object({ originId: z.string(), destinationId: z.string(), mode: z.enum(['driving']).default('driving') }),
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, handler(async ({ originId, destinationId }) => {
    const origin = places.get(originId), destination = places.get(destinationId);
    if (!origin || !destination) throw new Error('Неизвестный placeId. Сначала вызови geocode для обеих точек.');
    const url = new URL(`https://router.project-osrm.org/route/v1/driving/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`);
    url.search = new URLSearchParams({ overview: 'false', steps: 'false', alternatives: 'false' });
    const data = await get(url, 'OSRM');
    if (data.code !== 'Ok' || !data.routes?.length) throw new Error(`OSRM: маршрут не найден (${data.code || 'empty'}).`);
    const route = z.object({ distance: z.number().nonnegative(), duration: z.number().nonnegative(),
      legs: z.array(z.object({ summary: z.string() })) }).parse(data.routes[0]);
    const distanceKm = Math.round(route.distance / 100) / 10, durationMinutes = Math.round(route.duration / 60);
    const roads = route.legs.map(leg => leg.summary).filter(Boolean);
    const mapUrl = `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${origin.latitude},${origin.longitude};${destination.latitude},${destination.longitude}`;
    return { origin, destination, distanceKm, durationMinutes, roads, mapUrl, mode: 'driving',
      source: 'OSRM / © OpenStreetMap contributors',
      text: `Автомобильный маршрут: ${origin.label} → ${destination.label}; расстояние ${distanceKm} км; время около ${durationMinutes} мин без пробок. ${roads.length ? `Основные дороги: ${roads.join('; ')}. ` : ''}Карта: ${mapUrl}\nИсточник: OSRM / © OpenStreetMap contributors.` };
  }));
}
