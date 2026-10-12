const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.env.LOCAL_CHAT_VERIFY_CHILD === '1') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    assert.equal(new URL(url).origin, 'http://127.0.0.1:11434', 'Unexpected network destination');
    return originalFetch(url, options);
  };
  require('../server');
  for (const key of ['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY']) delete process.env[key];
} else {
  (async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-chat-'));
    const child = fork(__filename, [], { silent: true, env: {
      ...process.env, LOCAL_CHAT_VERIFY_CHILD: '1', PORT: '0', AGENT_DB_PATH: path.join(directory, 'chat.sqlite')
    } });
    try {
      const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 15000);
        child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
        child.stdout.on('data', data => {
          const match = data.toString().match(/localhost:(\d+)/);
          if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
        });
      });
      const answers = [];
      for (const message of ['Запомни кодовое слово: сапфир. Ответь кратко.', 'Какое кодовое слово я назвал? Ответь одним словом.']) {
        const started = Date.now();
        const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: 'local-verification', provider: 'local', model: 'qwen3.5:2b-q4_K_M',
            temperature: 0, keepMessages: 10, message }), signal: AbortSignal.timeout(300000)
        });
        assert.equal(response.status, 200);
        const stream = await response.text();
        const events = stream.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))
          .map(line => JSON.parse(line.slice(6)));
        assert.ok(!events.some(event => event.error), JSON.stringify(events.filter(event => event.error)));
        const answer = events.map(event => event.choices?.[0]?.delta?.content || '').join('');
        assert.ok(answer.trim());
        answers.push(answer);
        console.log(JSON.stringify({ message, answer, seconds: (Date.now() - started) / 1000 }));
      }
      assert.match(answers[1], /сапфир/i);
      console.log('PASS: HTTP streaming chat and memory with cloud keys removed and non-local fetch blocked.');
    } finally {
      child.kill();
      // Keep the isolated temporary database for inspection; never touch user conversations.
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
