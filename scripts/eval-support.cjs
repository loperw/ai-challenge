// Real DeepSeek end-to-end evaluation. No local model or embedding calls allowed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
if (process.env.SUPPORT_EVAL_CHILD === '1') {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const host = new URL(url).hostname;
    if (host !== 'api.deepseek.com') throw new Error(`Evaluation forbids upstream: ${host}`);
    const body = JSON.parse(options?.body || '{}');
    const response = await original(url, options);
    process.send?.({ upstream: { host, model: body.model, status: response.status } });
    return response;
  };
  require('../server');
} else {
  (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'support-eval-'));
    const child = fork(__filename, [], { silent: true, env: { ...process.env, SUPPORT_EVAL_CHILD: '1', PRIVATE_LLM: '0',
      PORT: '0', HOST: '127.0.0.1', AGENT_DB_PATH: path.join(dir, 'chat.sqlite'), SCHEDULE_DB_PATH: path.join(dir, 'schedules.sqlite') } });
    const upstream = []; child.on('message', event => { if (event.upstream) upstream.push(event.upstream); });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const report = { date: new Date().toISOString(), provider: 'deepseek', cases: [], upstream };
    try {
      const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Startup timeout: ${stderr}`)), 15000);
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Exit ${code}: ${stderr}`)); });
        child.stdout.on('data', chunk => { const match = chunk.toString().match(/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
      });
      const base = `http://127.0.0.1:${port}`;
      const users = await (await fetch(`${base}/api/support/users`)).json(); assert.equal(users.users.length, 3);
      const tickets = await (await fetch(`${base}/api/support/tickets?userId=u-101`)).json(); assert.equal(tickets.tickets.length, 2);
      let ssoAnswer = '';
      const cases = [
        { id: 'sso', userId: 'u-101', ticketId: 'T-101', expected: /SSO/, source: 'sso' },
        { id: 'reset', userId: 'u-102', ticketId: 'T-102', expected: /30|ист[её]к|новую ссыл/, source: 'reset' },
        { id: 'lock', userId: 'u-103', ticketId: 'T-103', expected: /15/, source: 'lock' },
        { id: 'followup', userId: 'u-101', ticketId: 'T-101', message: 'А смена пароля поможет?', expected: /не|нет/i, source: 'sso' },
        { id: 'export', userId: 'u-101', ticketId: 'T-104', message: 'Как выгрузить обращения в CSV?', expected: /CSV/, source: 'export' },
        { id: 'unknown', userId: 'u-101', ticketId: 'T-101', message: 'Какой SLA гарантирован договором?', expected: /не (?:определ|указ|зна|содерж)|нет|отсутств|недостат/i },
        { id: 'general', userId: 'u-102', message: 'Как восстановить пароль?', expected: /ссыл|Забыли пароль/, source: 'reset' },
        { id: 'foreign-ticket', userId: 'u-102', ticketId: 'T-101', status: 502 },
        { id: 'missing-ticket', userId: 'u-101', ticketId: 'T-999', status: 502 },
        { id: 'reject-local', userId: 'u-101', provider: 'local', status: 400 }
      ];
      for (const item of cases) {
        console.log(`RUN ${item.id}`);
        const offset = upstream.length;
        const record = { id: item.id };
        try {
          const body = { userId: item.userId, ticketId: item.ticketId, provider: item.provider, message: item.message || 'Почему не работает авторизация?',
            ...(item.id === 'followup' && { history: [{ role: 'user', content: 'Почему не работает авторизация?' }, { role: 'assistant', content: ssoAnswer }] }) };
          const response = await fetch(`${base}/api/support/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
          const data = await response.json(); record.answer = data.answer; record.errorResponse = data.error;
          assert.equal(response.status, item.status || 200, JSON.stringify(data));
          if (item.status) assert.equal(upstream.length, offset, 'Invalid request called LLM');
          else {
            assert.match(data.answer, item.expected);
            assert.equal(data.provider, 'deepseek');
            assert.equal(data.context.user.id, item.userId);
            assert.equal(data.context.ticket?.id, item.ticketId);
            assert.ok(upstream.slice(offset).some(call => call.model === 'deepseek-flash' && call.status === 200));
            if (item.source) { assert.ok(data.sources.some(source => source.id === item.source)); assert.ok(data.answer.includes(`[${item.source}]`), 'Missing FAQ citation'); }
            if (['sso', 'reset', 'lock'].includes(item.id)) assert.ok(data.answer.includes(`[MCP: ${item.ticketId}]`), 'Missing ticket grounding');
            if (item.id === 'reset') assert.doesNotMatch(data.answer, /какой код ошибки|SSO_REQUIRED|ACCOUNT_TEMPORARILY_LOCKED/i, 'Ignored known ticket cause');
            if (item.id === 'sso') ssoAnswer = data.answer;
            record.sources = data.sources.map(source => source.id);
          }
          record.passed = true;
        } catch (error) { record.passed = false; record.failure = error.message; }
        report.cases.push(record); console.log(JSON.stringify(record));
      }
      report.passed = report.cases.every(item => item.passed);
      fs.mkdirSync(path.join(__dirname, '../data'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, '../data/support-evaluation.json'), JSON.stringify(report, null, 2));
      if (!report.passed) process.exitCode = 1;
    } finally { child.kill(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
