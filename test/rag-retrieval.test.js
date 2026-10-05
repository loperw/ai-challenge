const test = require('node:test');
const assert = require('node:assert/strict');
const { searchBook, retrievalOptions, selectCandidates, rewriteQuery } = require('../document-search');
const { compareRag } = require('../rag-comparison');
const hit = (chunk_id, score, text = chunk_id) => ({ chunk_id, score, text, file: 'book.pdf', section: 'Test', page_start: 1, page_end: 1 });

test('filter includes the boundary, distinguishes threshold rejection and K trimming, and allows empty context', () => {
  const config = retrievalOptions({ candidateK: 4, contextK: 2, similarityThreshold: 0.5 });
  const groups = [{ query: 'original', hits: [hit('a', .9), hit('b', .8), hit('c', .5), hit('d', .49)] }];
  const result = selectCandidates(groups, config);
  assert.deepEqual(result.hits.map(h => h.chunk_id), ['a', 'b']);
  assert.equal(result.rejectedCount, 1); assert.equal(result.contextTrimmedCount, 1);
  assert.equal(result.passedCount, 3);
  assert.equal(selectCandidates(groups, { ...config, similarityThreshold: 1 }).hits.length, 0);
  assert.equal(selectCandidates(groups, { ...config, filter: false }).passedCount, 4);
});
test('original and rewritten results merge by id, fuse ranks, and share one candidate budget', () => {
  const config = retrievalOptions({ candidateK: 2, contextK: 2, similarityThreshold: .7 });
  const result = selectCandidates([{ query: 'original', hits: [hit('a', .6), hit('b', .8)] }, { query: 'rewritten', hits: [hit('a', .9), hit('c', .7)] }], config);
  assert.deepEqual(result.hits.map(h => h.chunk_id), ['a', 'b']);
  assert.deepEqual(result.hits[0].queryScores, { original: .6, rewritten: .9 });
});
test('rank fusion preserves agreement instead of allowing higher rewrite cosine values to crowd out original hits', () => {
  const result = selectCandidates([{ query: 'q', hits: [hit('relevant', .79), hit('other', .77)] },
    { query: 'rewrite', hits: [hit('broad', .95), hit('relevant', .81)] }], retrievalOptions({ contextK: 1 }));
  assert.equal(result.hits[0].chunk_id, 'relevant');
  assert.equal(result.hits[0].score, .81);
});
test('invalid and inconsistent retrieval options are rejected before work begins', () => {
  for (const options of [null, [], { candidateK: 1.5 }, { contextK: 0 }, { candidateK: 2, contextK: 3 }, { similarityThreshold: NaN }, { similarityThreshold: 1.01 }, { filter: 'false' }, { rewrite: 1 }]) {
    assert.throws(() => retrievalOptions(options), error => error.status === 400);
  }
});
test('rewrite failure is visible and original retrieval remains available; retrieval failure is never masked', async () => {
  const deps = { rewrite: async () => { throw new Error('timeout'); }, retrieve: async query => [hit(query, .8)] };
  const result = await searchBook('original', 'structure', {}, deps);
  assert.equal(result.rewrite.status, 'failed'); assert.equal(result.rewrite.error, 'timeout');
  assert.deepEqual(result.queries, ['original']); assert.equal(result.hits.length, 1);
  await assert.rejects(searchBook('original', 'fixed', {}, { ...deps, retrieve: async () => { throw new Error('Ollama unavailable'); } }), error => error.status === 503);
});
test('disabled or unchanged rewrite avoids extra searches', async () => {
  let searches = 0; let rewrites = 0;
  const deps = { retrieve: async () => { searches++; return []; }, rewrite: async query => { rewrites++; return { query }; } };
  await searchBook('q', 'fixed', { rewrite: false }, deps);
  assert.equal(rewrites, 0); assert.equal(searches, 1);
  await searchBook('q', 'fixed', {}, deps);
  assert.equal(rewrites, 1); assert.equal(searches, 2);
});
test('rewrite uses an isolated model with no tools and validates its JSON output', async () => {
  const previous = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'test-key';
  try {
    let request;
    const mock = async (url, init) => {
      request = JSON.parse(init.body);
      return new Response('data: '+JSON.stringify({ choices: [{ delta: { content: '{"query":"Kotlin null safety"}' } }] })+'\n\ndata: [DONE]\n\n');
    };
    assert.equal((await rewriteQuery('null?', {}, mock)).query, 'Kotlin null safety');
    assert.equal(request.tools, undefined); assert.equal(request.temperature, 0);
    assert.equal(request.messages.filter(m => m.role === 'user').length, 1);
  } finally { if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; }
});
test('comparison holds K fixed, shares rewrite and retrieval, and answers in independent contexts', async () => {
  const previous = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'test-key';
  let searches = 0; let rewrites = 0; const requests = [];
  try {
    const result = await compareRag('original', 'fixed', { candidateK: 2, contextK: 1, similarityThreshold: .7 }, {}, {
      retrieve: async query => { searches++; return [hit('a', query === 'original' ? .6 : .9)]; },
      rewrite: async () => { rewrites++; return { query: 'rewritten' }; },
      fetchImpl: async (url, init) => {
        requests.push(JSON.parse(init.body));
        return new Response('data: '+JSON.stringify({ choices: [{ delta: { content: JSON.stringify({status:'unknown',answer:'Не знаю. Уточните вопрос.',sources:[],quotes:[]}) } }] })+'\n\ndata: [DONE]\n\n');
      }
    });
    assert.equal(searches, 2); assert.equal(rewrites, 1); assert.equal(requests.length, 1);
    assert.equal(result.results[0].documentSearch.refusalReason, 'low_relevance');
    assert.deepEqual(result.results.map(r => r.mode), ['baseline', 'improved']);
    assert.deepEqual(result.results.map(r => r.documentSearch.hits.length), [1, 1]);
    assert.ok(requests.every(r => r.messages.filter(m => m.role === 'user').length === 1));
    assert.ok(result.results.every(r => r.documentSearch.options.contextK === 1));
  } finally { if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; }
});
