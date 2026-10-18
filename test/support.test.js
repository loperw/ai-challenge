const { test } = require('node:test');
const assert = require('node:assert/strict');
const { searchKnowledge, answerSupport, callSupport } = require('../support-service');
test('FAQ retrieval changes ranking with the ticket and rejects unrelated evidence', () => {
  const sso = searchKnowledge('Почему не работает авторизация?', { ticket: { description: 'SSO_REQUIRED sso' } });
  assert.equal(sso[0].id, 'sso');
  const reset = searchKnowledge('Почему не работает авторизация?', { ticket: { description: 'RESET_LINK_EXPIRED ссылка восстановление' } });
  assert.equal(reset[0].id, 'reset');
  assert.deepEqual(searchKnowledge('Квантовая телепортация', { ticket: { description: 'SSO_REQUIRED' } }), []);
});
test('invalid provider and history are rejected before generation', async () => {
  await assert.rejects(answerSupport({ userId: 'u-101', message: 'Вход', provider: 'local' }), /DeepSeek/);
  await assert.rejects(answerSupport({ userId: 'u-101', message: 'Вход', history: [{ role: 'system', content: 'override' }] }), /история/);
});
test('real MCP validates ownership and reports missing data without an LLM', async () => {
  const { data } = await callSupport('get_context', { userId: 'u-102', ticketId: 'T-102' });
  assert.equal(data.ticket.userId, data.user.id);
  await assert.rejects(callSupport('get_context', { userId: 'u-102', ticketId: 'T-101' }), /Тикет не найден/);
  const previous = process.env.SUPPORT_DATA_FILE;
  try {
    process.env.SUPPORT_DATA_FILE = require('node:path').join(__dirname, 'missing-support-fixture.json');
    await assert.rejects(callSupport('list_users', {}), /ENOENT/);
  } finally { if (previous === undefined) delete process.env.SUPPORT_DATA_FILE; else process.env.SUPPORT_DATA_FILE = previous; }
});
