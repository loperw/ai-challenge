import './env.mjs';
import { ticketSelectionUrl, telegramSelectionUrl } from './ticket-booking.mjs';

const DEFAULT_RAILWAY_URL = 'https://pass.rw.by';

export async function searchTickets(criteria) {
  if (process.env.RAILWAY_SEARCH_URL) return searchJsonEndpoint(criteria);
  return searchOfficialSchedule(criteria);
}

async function searchJsonEndpoint(criteria) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (process.env.RAILWAY_API_TOKEN) headers.authorization = `Bearer ${process.env.RAILWAY_API_TOKEN}`;
  const response = await fetch(process.env.RAILWAY_SEARCH_URL, {
    method: 'POST', headers, body: JSON.stringify(criteria), signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Источник расписания вернул HTTP ${response.status}.`);
  const payload = await response.json();
  const trains = Array.isArray(payload) ? payload : payload.trains || payload.results || payload.items;
  if (!Array.isArray(trains)) throw new Error('Источник ответил в неизвестном формате: ожидался массив trains/results/items.');
  return trains.map(normalizeTrain).filter(Boolean);
}

async function searchOfficialSchedule(criteria) {
  const { html, baseUrl } = await fetchOfficialSchedule(criteria);
  return parseOfficialSchedule(html, criteria, baseUrl);
}

export function officialScheduleUrl(criteria, baseUrl = process.env.RAILWAY_BASE_URL || DEFAULT_RAILWAY_URL) {
  const url = new URL('/ru/route/', baseUrl);
  url.search = new URLSearchParams({ from: criteria.from, to: criteria.to, date: criteria.date }).toString();
  return url.href;
}

async function fetchOfficialSchedule(criteria) {
  const baseUrl = process.env.RAILWAY_BASE_URL || DEFAULT_RAILWAY_URL;
  const url = officialScheduleUrl(criteria, baseUrl);
  const response = await fetch(url, {
    headers: { accept: 'text/html', 'accept-language': 'ru,en;q=0.7', 'user-agent': 'RailScout/0.1' },
    signal: AbortSignal.timeout(25000)
  });
  if (!response.ok) throw new Error(`pass.rw.by вернул HTTP ${response.status}.`);
  const html = await response.text();
  if (!html.includes('sch-table__row')) throw new Error('Сайт вернул страницу без таблицы расписания. Проверьте названия городов и дату.');
  return { html, baseUrl };
}

function scheduleRows(sourceHtml) {
  const html = sourceHtml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  return extractDivBlocks(html, 'sch-table__row-wrap').map((wrapper) => extractDivBlocks(wrapper, 'sch-table__row')[0] || wrapper);
}

export function parseOfficialSchedule(sourceHtml, criteria, baseUrl = DEFAULT_RAILWAY_URL) {
  return scheduleRows(sourceHtml).map((row) => {
    const trainNumber = elementText(row, 'train-number') || attributeValue(row, 'data-train-number') || '';
    const departureTime = elementText(row, 'train-from-time');
    const arrivalTime = elementText(row, 'train-to-time');
    const from = elementText(row, 'train-from-name');
    const to = elementText(row, 'train-to-name');
    if (!trainNumber || !departureTime) return null;

    const seatsByTariff = new Map();
    let currentType = '';
    for (const item of extractDivBlocks(row, 'sch-table__t-item')) {
      // The site leaves the type blank on additional tariffs of the same type.
      currentType = normalizeSeatType(elementText(item, 'sch-table__t-name')) || currentType;
      const quantity = elementText(item, 'sch-table__t-quant');
      const count = Number.parseInt(quantity.replace(/\D/g, ''), 10) || 0;
      if (!currentType || count <= 0) continue;
      const costBlock = extractDivBlocks(item, 'sch-table__t-cost')[0];
      const costText = costBlock ? textContent(costBlock) : '';
      const price = /\d/.test(costText) ? costText : null;
      const key = JSON.stringify([currentType, price]);
      const existing = seatsByTariff.get(key);
      if (existing) existing.count += count;
      else seatsByTariff.set(key, { type: currentType, count, price });
    }
    const seats = [...seatsByTariff.values()];

    const bookingForm = bookingFormFromRow(row, baseUrl);
    return {
      trainNumber: decodeHtml(trainNumber), trainName: '', from: decodeHtml(from), to: decodeHtml(to),
      date: criteria.date, departureTime, arrivalTime, availableSeats: seats,
      url: bookingForm ? ticketSelectionUrl(criteria, { trainNumber, departureTime }) : officialScheduleUrl(criteria, baseUrl),
      telegramUrl: bookingForm ? telegramSelectionUrl(bookingForm, criteria, { trainNumber, departureTime }) : null
    };
  }).filter(Boolean);
}

export async function getTrainBookingForm(criteria) {
  const { html, baseUrl } = await fetchOfficialSchedule(criteria);
  return parseTrainBookingForm(html, criteria, baseUrl);
}

export function parseTrainBookingForm(html, criteria, baseUrl = DEFAULT_RAILWAY_URL) {
  const row = scheduleRows(html).find((candidate) => {
    const number = elementText(candidate, 'train-number') || decodeHtml(attributeValue(candidate, 'data-train-number'));
    return number === criteria.trainNumber && elementText(candidate, 'train-from-time') === criteria.departureTime;
  });
  if (!row) throw new Error('Рейс больше не найден в расписании на выбранную дату. Выполните поиск заново.');
  const form = bookingFormFromRow(row, baseUrl);
  if (!form) throw new Error('Сайт БЖД сейчас не предлагает выбор мест для этого поезда. Проверьте расписание.');
  return form;
}

function bookingFormFromRow(row, baseUrl) {
  const form = [...row.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].find(([markup]) =>
    attributeValue(markup.match(/^<form\b[^>]*>/i)[0], 'class').split(/\s+/).includes('js-sch-item-form')
  )?.[0];
  if (!form) return null;
  const tag = form.match(/^<form\b[^>]*>/i)[0];
  if (attributeValue(tag, 'method').toLowerCase() !== 'post') return null;
  const action = new URL(decodeHtml(attributeValue(tag, 'action')), baseUrl);
  if (action.origin !== new URL(baseUrl).origin || action.pathname !== '/ru/order/places/' || !['https:', 'http:'].includes(action.protocol)) return null;
  const fields = {};
  for (const [input] of form.matchAll(/<input\b[^>]*>/gi)) {
    const name = attributeValue(input, 'name');
    if (name === 'route' || name === 'url') fields[name] = decodeHtml(attributeValue(input, 'value'));
  }
  return fields.route ? { action: action.href, fields } : null;
}

export function applyInvariants(trains, criteria) {
  const allowedTypes = new Set((criteria.ticketTypes || []).map(normalizeSeatType));
  const excluded = criteria.excludedTimes || [];
  return trains.filter((train) => {
    const time = train.departureTime.slice(0, 5);
    if (criteria.timeFrom && time < criteria.timeFrom) return false;
    if (criteria.timeTo && time > criteria.timeTo) return false;
    if (excluded.some(({ from, to }) => from <= to ? time >= from && time <= to : time >= from || time <= to)) return false;
    const seats = train.availableSeats.filter((seat) => seat.count > 0);
    if (!seats.length) return false;
    if (allowedTypes.size && !seats.some((seat) => allowedTypes.has(normalizeSeatType(seat.type)))) return false;
    train.availableSeats = allowedTypes.size ? seats.filter((seat) => allowedTypes.has(normalizeSeatType(seat.type))) : seats;
    return true;
  });
}

function normalizeTrain(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    trainNumber: String(item.trainNumber ?? item.number ?? item.train ?? '—'),
    trainName: String(item.trainName ?? item.name ?? ''),
    from: String(item.from ?? item.departureStation ?? ''),
    to: String(item.to ?? item.arrivalStation ?? ''),
    date: String(item.date ?? item.departureDate ?? ''),
    departureTime: String(item.departureTime ?? item.departure ?? ''),
    arrivalTime: String(item.arrivalTime ?? item.arrival ?? ''),
    availableSeats: Array.isArray(item.availableSeats ?? item.seats)
      ? (item.availableSeats ?? item.seats).map((seat) => ({
          type: normalizeSeatType(seat.type ?? seat.class ?? ''),
          count: Number(seat.count ?? seat.available ?? 0),
          price: seat.price == null ? null : String(seat.price)
        }))
      : [],
    url: typeof item.url === 'string' ? item.url : ''
  };
}

function normalizeSeatType(value) {
  const type = String(value).trim().toLocaleLowerCase('ru');
  if (type.includes('св') || type === 'lux' || type === 'soft') return 'СВ';
  if (type.includes('плац')) return 'плацкарт';
  if (type.includes('куп')) return 'купе';
  if (type.includes('сид')) return 'сидячий';
  return type;
}

function extractDivBlocks(html, className) {
  const tags = /<div\b[^>]*>|<\/div\s*>/gi;
  const stack = [];
  const blocks = [];
  let match;
  while ((match = tags.exec(html))) {
    if (/^<\/div/i.test(match[0])) {
      const node = stack.pop();
      if (node?.classNames.includes(className)) blocks.push(html.slice(node.start, tags.lastIndex));
      continue;
    }
    const classNames = (match[0].match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1] || '').split(/\s+/);
    stack.push({ start: match.index, classNames });
  }
  return blocks;
}

function elementText(html, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<([a-z][\\w:-]*)\\b(?=[^>]*\\bclass=["'][^"']*\\b${escaped}\\b[^"']*["'])[^>]*>([\\s\\S]*?)<\\/\\1>`, 'i').exec(html);
  return match ? textContent(match[2]) : '';
}

function elementAttribute(html, tag, className, attr) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${tag}\\b(?=[^>]*\\bclass=["'][^"']*\\b${escaped}\\b[^"']*["'])[^>]*\\b${attr}=["']([^"']*)["']`, 'i').exec(html);
  return match ? match[1] : '';
}

function attributeValue(html, attr) {
  const escaped = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}=["']([^"']*)["']`, 'i').exec(html)?.[1] || '';
}

function textContent(html) {
  return decodeHtml(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeHtml(value) {
  return String(value).replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp|mdash|ndash);/gi, (entity, code) => {
    if (code[0] === '#') {
      const number = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
    }
    return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', mdash: '—', ndash: '–' })[code.toLowerCase()] || entity;
  });
}
