import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validFilename, fileArtifact } from '../file-artifacts.js';
import { summarizeWeather } from './weather.mjs';

const defaultCorpus = fileURLToPath(new URL('./knowledge.json', import.meta.url));
const words = text => text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
const inputData = {
  sourceId: z.string().optional().describe('Точный sourceId успешного предыдущего вызова в этом ходе. Не придумывай ID.'),
  text: z.string().trim().min(1).max(100000).optional().describe('Готовый текст пользователя, если sourceId отсутствует. Укажи ровно одно: sourceId или text.')
};

export function registerPipelineTools(server, {
  corpusPath = process.env.PIPELINE_SEARCH_FILE || defaultCorpus,
  outputDir = process.env.PIPELINE_OUTPUT_DIR || path.resolve('data/exports'),
  artifacts = new Map(), allowImport = false
} = {}) {
  // Artifacts live for one MCP connection / user turn. IDs preserve exact data flow.
  const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
  const handler = action => async input => {
    try { return result(await action(input)); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  };
  const remember = data => {
    const sourceId = randomUUID();
    artifacts.set(sourceId, data);
    return { sourceId, ...data };
  };
  const resolveData = ({ sourceId, text }) => {
    if (Boolean(sourceId) === Boolean(text)) throw new Error('Укажи ровно одно: sourceId предыдущего результата или готовый text.');
    if (!sourceId) return text;
    const data = artifacts.get(sourceId);
    if (!data) throw new Error('sourceId не найден в этом ходе. Сначала получи нужные данные и используй возвращённый ID.');
    if (!data.text) throw new Error('Источник пуст. Нельзя обрабатывать или сохранять пустой результат поиска.');
    return data.text;
  };

  if (allowImport) {
    // Private broker transport; omitted from the LLM catalog.
    server.registerTool('_import_source', {
      description: 'Internal session broker: import exact data from another MCP server.',
      inputSchema: z.object({ sourceId: z.string(), text: z.string().max(100000), weather: z.unknown().optional() })
    }, handler(({ sourceId, text, weather }) => {
      if (artifacts.has(sourceId)) throw new Error('Source already exists.');
      artifacts.set(sourceId, { text, weather });
      return { imported: true, sourceId };
    }));
    server.registerTool('combine_sources', {
      description: 'Объединяет точные тексты нескольких успешных результатов (например маршрут и погоду) в один документ. Передай sourceIds полученных результатов в нужном порядке. Возвращает новый sourceId для summarize или saveToFile. Не переписывай данные самостоятельно.',
      inputSchema: z.object({ sourceIds: z.array(z.string()).min(2).max(10) }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    }, handler(({ sourceIds }) => remember({
      text: sourceIds.map(sourceId => resolveData({ sourceId })).join('\n\n'), inputSourceIds: sourceIds,
      components: sourceIds.map(sourceId => artifacts.get(sourceId))
    })));
  }

  server.registerTool('search', {
    title: 'Поиск по базе знаний',
    description: 'Ищет сведения в локальной базе знаний проекта (не в интернете). Используй, когда нужны исходные данные; не вызывай, если нужный текст уже дан. Возвращает results, text и sourceId для дальнейшей обработки или сохранения.',
    inputSchema: z.object({ query: z.string().trim().min(2).max(500), limit: z.number().int().min(1).max(10).default(5) }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, handler(async ({ query, limit }) => {
    const documents = JSON.parse(await readFile(corpusPath, 'utf8'));
    const terms = [...new Set(words(query))];
    const results = documents.map(doc => {
      const tokens = words(`${doc.title} ${doc.text}`);
      return { ...doc, score: terms.reduce((sum, term) => sum + tokens.filter(token => token.startsWith(term) || term.startsWith(token)).length, 0) };
    }).filter(doc => doc.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
      .map(({ title, text, source }) => ({ title, text, source }));
    return remember({ query, results, text: results.map(doc => `${doc.title}\n${doc.text}\nИсточник: ${doc.source}`).join('\n\n') });
  }));

  server.registerTool('summarize', {
    title: 'Краткая выжимка',
    description: 'Выполняет явную просьбу «кратко подведи итог», «сделай сводку», «сократи», «суммируй» для текста или результатов инструментов, включая прогноз погоды. При таком запросе вызови этот инструмент, а не составляй выжимку самостоятельно. Для результата get_weather или search передай его sourceId; для исходного текста пользователя передай text. Погодные данные агрегирует за весь период; из текста выбирает значимые предложения. Возвращает text и новый sourceId для сохранения. Если итог не запрошен, не вызывай.',
    inputSchema: z.object({ ...inputData, maxSentences: z.number().int().min(1).max(10).default(3) }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, handler(({ sourceId, text, maxSentences }) => {
    const input = resolveData({ sourceId, text });
    const components = sourceId && artifacts.get(sourceId)?.components;
    if (components) {
      // Keep one fact from each source before adding details from any one source.
      const segments = components.map(component => component.weather
        ? [summarizeWeather(component.weather, 1).text]
        : [...new Intl.Segmenter('ru', { granularity: 'sentence' }).segment(component.text)].map(item => item.segment.trim()).filter(Boolean));
      const sentences = [];
      for (let index = 0; sentences.length < maxSentences && segments.some(items => items[index]); index++) {
        for (const items of segments) if (items[index] && sentences.length < maxSentences) sentences.push(items[index]);
      }
      return remember({ text: sentences.join(' '), inputSourceId: sourceId, inputCharacters: input.length, method: 'multi-source-extractive' });
    }
    const weather = sourceId && artifacts.get(sourceId)?.weather;
    if (weather) return remember({ ...summarizeWeather(weather, maxSentences),
      inputSourceId: sourceId, inputCharacters: input.length, method: 'weather-aggregate' });
    const sentences = [...new Intl.Segmenter('ru', { granularity: 'sentence' }).segment(input)]
      .map(item => item.segment.trim()).filter(Boolean);
    const frequencies = new Map();
    for (const word of words(input)) if (word.length > 3) frequencies.set(word, (frequencies.get(word) || 0) + 1);
    const selected = sentences.map((sentence, index) => ({ sentence, index,
      score: words(sentence).reduce((sum, word) => sum + (frequencies.get(word) || 0), 0) / Math.max(1, words(sentence).length) }))
      .sort((a, b) => b.score - a.score).slice(0, maxSentences).sort((a, b) => a.index - b.index);
    return remember({ text: selected.map(item => item.sentence).join(' '), inputSourceId: sourceId || null,
      inputCharacters: input.length, method: 'extractive' });
  }));

  server.registerTool('saveToFile', {
    title: 'Сохранить в файл',
    description: 'Создаёт UTF-8 файл и прикрепляет карточку с предпросмотром и скачиванием к ответу. Вызывай только при запросе сохранить. Для готового результата передай его sourceId без переписывания текста; если пользователь дал точный текст, передай text. Не требует search или summarize, если они не нужны запросу. Имя только .txt или .md, без каталогов. Существующий файл не перезаписывается.',
    inputSchema: z.object({ ...inputData, filename: z.string().min(1).max(120) }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, handler(async ({ sourceId, text, filename }) => {
    const content = resolveData({ sourceId, text });
    if (!validFilename(filename)) {
      throw new Error('Имя файла должно быть простым именем .txt или .md без пути и системных имён.');
    }
    await mkdir(outputDir, { recursive: true });
    const filePath = path.resolve(outputDir, filename);
    const file = await open(filePath, 'wx');
    try { await file.writeFile(content, 'utf8'); } finally { await file.close(); }
    return { saved: true, file: fileArtifact(filename, Buffer.byteLength(content)), filename, sourceId: sourceId || null,
      bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') };
  }));
}
