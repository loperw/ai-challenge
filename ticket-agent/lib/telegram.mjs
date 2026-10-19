import './env.mjs';

export async function sendTelegramNotification({ chatId, text, entities }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в локальном .env.');
  if (!chatId) throw new Error('Не задан Telegram chat ID.');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, entities, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(12000)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || 'Telegram не принял уведомление.');
  return { sent: true, messageId: result.result?.message_id };
}
