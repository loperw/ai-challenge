const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MODEL = 'nomic-embed-text';
const ENDPOINT = 'http://127.0.0.1:11434';
const VERSION = 2;
const locks = new Map();
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

function normalize(vector, dimension) {
  if (!Array.isArray(vector) || !vector.length || (dimension && vector.length !== dimension)
    || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Некорректный вектор эмбеддинга.');
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Нулевой или некорректный вектор эмбеддинга.');
  return vector.map(value => value / norm);
}
async function request(route, body, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`${ENDPOINT}${route}`, {
      ...(body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    return data;
  } catch (error) {
    throw Object.assign(new Error(`Эмбеддинги документации недоступны. Запустите Ollama и установите ${MODEL}. ${error.message}`), { status: 503 });
  }
}
async function embed(texts, query, fetchImpl) {
  const data = await request('/api/embed', { model: MODEL, input: texts.map(text => `${query ? 'search_query' : 'search_document'}: ${text}`), truncate: false }, fetchImpl);
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) throw new Error('Неверное количество эмбеддингов от Ollama.');
  return data.embeddings.map(vector => normalize(vector, data.embeddings[0]?.length));
}
function readCache(file, digest) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== VERSION || value.model !== MODEL || value.digest !== digest || !Array.isArray(value.entries)) return null;
    if (value.entries.length && (!Number.isInteger(value.dimension) || value.dimension < 1)) return null;
    for (const entry of value.entries) {
      normalize(entry.vector, value.dimension);
      normalize(entry.titleVector, value.dimension);
    }
    return value;
  } catch { return null; }
}
async function buildVectorIndex(index, { cacheFile, fetchImpl = globalThis.fetch } = {}) {
  if (!cacheFile) throw new Error('Не задан путь векторного индекса.');
  const previous = locks.get(cacheFile) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const tags = await request('/api/tags', null, fetchImpl);
    const model = tags.models?.find(item => [MODEL, `${MODEL}:latest`].includes(item.name || item.model));
    if (!model?.digest) throw Object.assign(new Error(`В Ollama отсутствует ${MODEL}. Выполните ollama pull ${MODEL}.`), { status: 503 });
    const cache = readCache(cacheFile, model.digest);
    const reusable = new Map((cache?.entries || []).map(entry => [entry.id, entry]));
    const entries = index.chunks.map(chunk => {
      const text = `${chunk.file}\n${chunk.section}\n${chunk.text}`;
      const id = hash(text);
      return { id, text, title: chunk.section.split(' / ').at(-1),
        vector: reusable.get(id)?.vector, titleVector: reusable.get(id)?.titleVector };
    });
    const missing = entries.filter(entry => !entry.vector);
    for (let offset = 0; offset < missing.length; offset += 8) {
      const batch = missing.slice(offset, offset + 8);
      const vectors = await embed(batch.flatMap(entry => [entry.text, entry.title]), false, fetchImpl);
      batch.forEach((entry, i) => { entry.vector = vectors[i * 2]; entry.titleVector = vectors[i * 2 + 1]; });
    }
    const dimension = entries[0]?.vector.length || 0;
    for (const entry of entries) { normalize(entry.vector, dimension); normalize(entry.titleVector, dimension); }
    const stored = { version: VERSION, model: MODEL, digest: model.digest, dimension, fingerprint: index.fingerprint,
      entries: entries.map(({ id, vector, titleVector }) => ({ id, vector, titleVector })) };
    if (!cache || cache.fingerprint !== index.fingerprint || missing.length) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const temporary = `${cacheFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try { fs.writeFileSync(temporary, JSON.stringify(stored)); fs.renameSync(temporary, cacheFile); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    return { ...index, model: MODEL, digest: model.digest, dimension, embeddedCount: missing.length,
      chunks: index.chunks.map((chunk, i) => ({ ...chunk, vector: entries[i].vector, titleVector: entries[i].titleVector })) };
  });
  locks.set(cacheFile, current);
  try { return await current; }
  finally { if (locks.get(cacheFile) === current) locks.delete(cacheFile); }
}
async function vectorSearch(query, index, limit = 5, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('Введите поисковый запрос.');
  if (!index.chunks.length) return [];
  const [raw] = await embed([query.trim()], true, fetchImpl);
  const vector = normalize(raw, index.dimension);
  const cosine = document => document.reduce((sum, value, i) => sum + value * vector[i], 0);
  return index.chunks.map(({ vector: document, titleVector, ...chunk }) => ({ ...chunk,
    score: (cosine(document) + cosine(titleVector)) / 2 }))
    .sort((a, b) => b.score - a.score).slice(0, limit);
}
module.exports = { buildVectorIndex, vectorSearch, normalize, MODEL };
