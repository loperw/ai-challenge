import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOfficialSchedule, applyInvariants } from '../lib/railway.mjs';
import { buildTicketNotification } from '../lib/ticket-notification.mjs';
import { sendTelegramNotification } from '../lib/telegram.mjs';

const criteria = { from: 'Минск', to: 'Брест', date: '2026-11-10' };
const html = `<div class="sch-table__row-wrap"><div class="sch-table__row">
  <span class="train-number">007М</span><span class="train-from-time">06:54</span>
  <span class="train-to-time">10:58</span>
  <a class="sch-table__route" href="/ru/train/?train=007М&amp;date=2026-11-10">Маршрут</a>
  <div class="sch-table__t-item">
    <div class="sch-table__t-name">Плацкартный</div><a class="sch-table__t-quant"><span>34</span></a>
    <div class="sch-table__t-cost"><div class="ticket-wrap"><span class="js-price"><span class="ticket-cost">29,44</span> <span class="ticket-currency">BYN</span></span></div></div>
  </div>
  <div class="sch-table__t-item">
    <div class="sch-table__t-name"></div><a class="sch-table__t-quant"><span>39</span></a>
    <div class="sch-table__t-cost"><div class="ticket-wrap">29,44&nbsp;BYN</div></div>
  </div>
  <div class="sch-table__t-item">
    <div class="sch-table__t-name">Купейный</div><a class="sch-table__t-quant"><span>41</span></a>
    <div class="sch-table__t-cost"><div class="ticket-wrap">48,48 BYN</div></div>
  </div>
  <div class="sch-table__t-item">
    <div class="sch-table__t-name"></div><a class="sch-table__t-quant"><span>2</span></a>
    <div class="sch-table__t-cost"><div class="ticket-wrap">от <span class="ticket-cost">61,98</span> BYN</div></div>
  </div>
  <div class="sch-table__t-item">
    <div class="sch-table__t-name">СВ</div><a class="sch-table__t-quant"><span>1</span></a>
  </div>
  <div class="sch-table__t-item">
    <div class="sch-table__t-name">Сидячий</div><a class="sch-table__t-quant"><span>0</span></a>
    <div class="sch-table__t-cost"><div class="ticket-wrap">15,00 BYN</div></div>
  </div>
</div></div>`;

test('prices stay paired with their seat type and tariff, including unnamed continuation rows', () => {
  const [train] = parseOfficialSchedule(html, criteria);
  assert.deepEqual(train.availableSeats, [
    { type: 'плацкарт', count: 73, price: '29,44 BYN' },
    { type: 'купе', count: 41, price: '48,48 BYN' },
    { type: 'купе', count: 2, price: 'от 61,98 BYN' },
    { type: 'СВ', count: 1, price: null }
  ]);
  const [filtered] = applyInvariants([train], { ...criteria, ticketTypes: ['купе'] });
  assert.deepEqual(filtered.availableSeats.map(({ price }) => price), ['48,48 BYN', 'от 61,98 BYN']);
});

test('Telegram shows prices and compact source buttons after emoji and special characters', () => {
  const [train] = parseOfficialSchedule(html, criteria);
  const trains = [train, { ...train, trainNumber: '123Б', url: 'https://pass.rw.by/ru/train/?train=123Б' }];
  const message = buildTicketNotification(criteria, trains, 'Артём 🚆 <&>');
  assert.ok(message.text.includes('Для Артём 🚆 <&> найдены билеты:'));
  assert.ok(message.text.includes('плацкарт · мест: 73 · 29,44 BYN'));
  assert.ok(message.text.includes('купе · мест: 2 · от 61,98 BYN'));
  assert.ok(message.text.includes('СВ · мест: 1 · цена не указана'));
  assert.ok(!message.text.includes('https://'));
  assert.equal(message.reply_markup.inline_keyboard.length, 2);
  for (const [index, [button]] of message.reply_markup.inline_keyboard.entries()) {
    assert.equal(button.text, 'Открыть источник');
    assert.equal(button.url, new URL(trains[index].telegramUrl || trains[index].url).href);
  }
  const unsafe = buildTicketNotification(criteria, [{ ...train, url: 'javascript:alert(1)', telegramUrl: null }]);
  assert.equal(unsafe.reply_markup, undefined);
});

test('Telegram transport preserves source buttons and still accepts plain test notifications', async (t) => {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  });
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'test-only-token';
  t.after(() => {
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  });
  const message = buildTicketNotification(criteria, parseOfficialSchedule(html, criteria));
  await sendTelegramNotification({ chatId: 'test-only-chat', ...message });
  await sendTelegramNotification({ chatId: 'test-only-chat', text: 'Тест' });
  assert.deepEqual(bodies[0].reply_markup, message.reply_markup);
  assert.equal(bodies[0].text, message.text);
  assert.equal(bodies[0].disable_web_page_preview, true);
  assert.equal(bodies[1].text, 'Тест');
  assert.ok(!Object.hasOwn(bodies[1], 'reply_markup'));
});
