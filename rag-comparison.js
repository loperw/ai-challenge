const { Agent } = require('./agent');
const { searchBook, modes, retrievalOptions, retrieve, rewriteQuery } = require('./document-search');

async function compareRag(query, strategy, options, settings = {}, dependencies = {}) {
  const config = retrievalOptions(options);
  const cache = new Map();
  let rewritten;
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const shared = {
    settings,
    retrieve: async (text, index, top) => {
      const key = JSON.stringify([text, index, top]);
      if (!cache.has(key)) cache.set(key, await (dependencies.retrieve || retrieve)(text, index, top));
      return cache.get(key);
    },
    rewrite: async text => {
      // Cache the promise, including a failure, so both rewrite modes use the same outcome.
      rewritten ||= (dependencies.rewrite || rewriteQuery)(text, settings, fetchImpl);
      return rewritten;
    }
  };
  const results = [];
  for (const [mode, flags] of Object.entries(modes)) {
    const result = await searchBook(query, strategy, { ...config, filter: flags.filter, rewrite: flags.rewrite }, shared);
    const started = performance.now();
    const agent = new Agent({ provider: settings.provider || 'deepseek', model: settings.model || 'deepseek-flash',
      temperature: 0, keepMessages: 1, systemPrompt: 'Ответь кратко на русском языке, сохрани необходимые пояснения и ссылки на источники.' }, {
      fetchImpl: (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(60000) })
    });
    const answer = await agent.respond(query, { documentSearch: result, ragMode: 'rag', toolsEnabled: false });
    results.push({ mode, label: flags.label, answer, tokenStats: agent.tokenStats,
      answerMs: performance.now() - started, documentSearch: agent.messages.at(-1).documentSearch });
  }
  return { query, strategy, options: config, settings: { provider: settings.provider || 'deepseek', model: settings.model || 'deepseek-flash', temperature: 0 },
    note: 'Независимые ответы без истории и MCP. Поиск и rewrite кешируются между режимами; времена с кешем не характеризуют производительность отдельных режимов.', results };
}
module.exports = { compareRag };
