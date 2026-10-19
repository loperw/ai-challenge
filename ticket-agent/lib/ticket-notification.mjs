export function buildTicketNotification(criteria, trains, name, { summary } = {}) {
  const greeting = trains.length
    ? (name ? `Для ${name} найдены билеты:` : 'Найдены билеты:')
    : 'Подходящих билетов сейчас нет. Мониторинг продолжается.';
  let text = `${greeting}\n${criteria.from} → ${criteria.to}, ${criteria.date}`;
  if (summary) text += `\n\nИтог AI: ${summary}`;
  const entities = [];
  let included = 0;

  for (const train of trains.slice(0, 8)) {
    const seats = train.availableSeats.map((seat) =>
      `${seat.type} · мест: ${seat.count} · ${seat.price ?? 'цена не указана'}`
    ).join('\n');
    const details = `\n\n${train.trainNumber}${train.trainName ? ` ${train.trainName}` : ''} · ${train.departureTime}–${train.arrivalTime}\n${seats}`;
    // Leave room for the link and omitted-results note within Telegram's limit.
    if (text.length + details.length > 3900) break;
    text += details;
    included++;
    let source;
    try { source = new URL(train.url); } catch { continue; }
    if (!['https:', 'http:'].includes(source.protocol)) continue;
    text += '\n';
    const label = 'Открыть источник';
    // Telegram entity offsets use UTF-16 code units, just like JS string.length.
    entities.push({ type: 'text_link', offset: text.length, length: label.length, url: source.href });
    text += label;
  }
  if (included < trains.length) text += `\n\nВсего подходящих поездов: ${trains.length}. В сообщении показано: ${included}.`;
  return { text, entities };
}
