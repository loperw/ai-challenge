import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOfficialSchedule, parseTrainBookingForm } from '../lib/railway.mjs';
import { ticketSelectionUrl, renderTicketTransfer } from '../lib/ticket-booking.mjs';
import { buildTicketNotification } from '../lib/ticket-notification.mjs';

const criteria = { from: 'Минск', to: 'Витебск', date: '2026-10-23', trainNumber: '704Б', departureTime: '07:00' };
const row = (time, route, action = '/ru/order/places/') => `<div class="sch-table__row-wrap"><div class="sch-table__row">
  <span class="train-number">704Б</span><span class="train-from-time">${time}</span>
  <a class="sch-table__route" href="/ru/train/?train=704Б">Информация</a>
  <form class="js-sch-item-form" method="post" action="${action}">
    <input type="hidden" name="route" class="js-sch-item-route" value="${route}">
    <input type="hidden" name="url" value="/ru/route/?from=Минск&amp;to=Витебск">
  </form>
</div></div>`;

test('result and Telegram links retain train, route, date and departure without embedding the POST payload', () => {
  const [train] = parseOfficialSchedule(row('07:00', 'route-payload'), criteria);
  const url = new URL(train.url);
  assert.equal(url.pathname, '/open-ticket');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    from: 'Минск', to: 'Витебск', date: '2026-10-23', train: '704Б', departure: '07:00'
  });
  assert.ok(!train.url.includes('route-payload'));
  assert.equal(buildTicketNotification(criteria, [train]).entities[0].url, train.url);
});

test('selection uses the current form of exactly the requested departure and preserves encoded fields', () => {
  const html = row('07:00', 'a:1:{s:5:&quot;train&quot;;s:5:&quot;704Б&quot;;}') + row('19:00', 'another-departure');
  const form = parseTrainBookingForm(html, criteria);
  assert.equal(form.action, 'https://pass.rw.by/ru/order/places/');
  assert.deepEqual(form.fields, {
    route: 'a:1:{s:5:"train";s:5:"704Б";}', url: '/ru/route/?from=Минск&to=Витебск'
  });
  assert.equal(parseTrainBookingForm(row('07:00', 'refreshed-payload'), criteria).fields.route, 'refreshed-payload');
  assert.throws(() => parseTrainBookingForm(html, { ...criteria, departureTime: '08:00' }), /больше не найден/);
  assert.throws(() => parseTrainBookingForm(row('07:00', 'payload', 'https://example.org/ru/order/places/'), criteria), /не предлагает/);
});

test('handoff page submits the official POST form and escapes route values and visible labels', () => {
  const html = renderTicketTransfer({ action: 'https://pass.rw.by/ru/order/places/', fields: { route: '"><script>alert(1)</script>', url: '/ru/route/?from=A&to=B' } }, criteria);
  assert.ok(html.includes('action="https://pass.rw.by/ru/order/places/" method="post"'));
  assert.ok(html.includes('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'));
  assert.ok(html.includes("document.getElementById('booking-form').submit()"));
  assert.ok(html.includes('Поезд 704Б'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
});

test('public app URL can be configured for Telegram links opened on another device', (t) => {
  const original = process.env.TICKET_AGENT_PUBLIC_URL;
  process.env.TICKET_AGENT_PUBLIC_URL = 'https://tickets.example.org';
  t.after(() => {
    if (original === undefined) delete process.env.TICKET_AGENT_PUBLIC_URL;
    else process.env.TICKET_AGENT_PUBLIC_URL = original;
  });
  assert.equal(new URL(ticketSelectionUrl(criteria, criteria)).origin, 'https://tickets.example.org');
});
