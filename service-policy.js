// Opt-in deployment policy; desktop behaviour remains unchanged.
function policy() {
  const enabled = process.env.PRIVATE_LLM === '1';
  return { enabled, model: process.env.LOCAL_MODEL || 'qwen3:0.6b',
    context: 4096, output: 256, parallel: 2, requestsPerMinute: 12, bodyBytes: 65536 };
}
function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }
function applySettings(settings) {
  const p = policy();
  if (!p.enabled) return settings;
  if (settings.provider && settings.provider !== 'local') throw fail('На этом сервере доступны только локальные модели.');
  if (settings.model && settings.model !== p.model) throw fail('Модель не разрешена на этом сервере.');
  if (settings.contextWindow !== undefined && settings.contextWindow !== '' && Number(settings.contextWindow) > p.context)
    throw fail(`Максимальный контекст: ${p.context} токенов.`);
  if (settings.maxTokens !== undefined && settings.maxTokens !== '' && Number(settings.maxTokens) > p.output)
    throw fail(`Максимальный ответ: ${p.output} токенов.`);
  return { ...settings, provider: 'local', model: p.model,
    contextWindow: settings.contextWindow || p.context, maxTokens: settings.maxTokens || p.output };
}
// Holds a slot until the upstream stream ends, including disconnected clients.
function createGate(limit = 2) {
  let active = 0;
  return { get active() { return active; }, acquire() {
    if (active >= limit) throw fail('Обе генерации заняты. Повторите запрос позже.', 429);
    active++;
    let released = false;
    return () => { if (!released) { released = true; active--; } };
  } };
}
function createRateLimiter(limit = 12, now = Date.now) {
  const entries = new Map();
  return key => {
    const time = now();
    for (const [id, entry] of entries) if (time >= entry.until) entries.delete(id);
    const entry = entries.get(key) || { until: time + 60000, count: 0 };
    if (entry.count >= limit) return false;
    entry.count++; entries.set(key, entry); return true;
  };
}
module.exports = { policy, applySettings, createGate, createRateLimiter, fail };
