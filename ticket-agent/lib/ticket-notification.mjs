export function buildTicketNotification(criteria, trains, name) {
  const greeting = trains.length
    ? (name ? `Для ${name} найдены билеты:` : 'Найдены билеты:')
    : 'Подходящих билетов сейчас нет. Мониторинг продолжается.';
  let text = `${greeting}\n${criteria.from} → ${criteria.to}, ${criteria.date}`;
  const inlineKeyboard = [];
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
    try { source = new URL(train.telegramUrl || train.url); } catch { continue; }
    if (!['https:', 'http:'].includes(source.protocol)) continue;
    inlineKeyboard.push([{ text: 'Открыть источник', url: source.href }]);
  }
  if (included < trains.length) text += `\n\nВсего подходящих поездов: ${trains.length}. В сообщении показано: ${included}.`;
  return {
    text,
    ...(inlineKeyboard.length ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {})
  };
}
