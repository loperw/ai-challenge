const { defaults } = require('./document-search');

const ANSWER_CONTRACT = 'Верни только JSON-объект {"status":"answered" или "unknown","answer":"краткий ответ с номерами [1] рядом с утверждениями","sources":[1],"quotes":[{"source":1,"text":"короткая цитата из этого фрагмента"}]}. Для содержательного ответа укажи источники и короткие цитаты из найденных фрагментов, подтверждающие основной смысл ответа. Цитаты и список источников размещай только в полях quotes и sources: интерфейс покажет их отдельно. Не добавляй в answer блок «Цитаты и источники». Для unknown верни пустые sources и quotes; скажи «Не знаю» и попроси уточнение. Не отвечай из общих знаний или предыдущих ответов.';

function eligibleSources(result) {
  const threshold = result.options?.similarityThreshold ?? defaults.similarityThreshold;
  return result.hits.flatMap((hit, index) => Number.isFinite(hit.score) && hit.score >= threshold && typeof hit.text === 'string' && hit.text.trim()
    ? [index + 1] : []);
}

function parseAnswer(raw) {
  const payload = JSON.parse(raw);
  if (!payload || Array.isArray(payload) || !['answered', 'unknown'].includes(payload.status)
    || typeof payload.answer !== 'string' || !payload.answer.trim()) throw new Error('Некорректный формат ответа RAG.');
  const sources = Array.isArray(payload.sources) ? [...new Set(payload.sources.filter(number => Number.isInteger(number) && number > 0))] : [];
  const quotes = Array.isArray(payload.quotes) ? payload.quotes.flatMap(quote => Number.isInteger(quote?.source) && quote.source > 0
    && typeof quote.text === 'string' && quote.text.trim() ? [{ source: quote.source, text: quote.text.trim() }] : []) : [];
  return { status: payload.status, answer: payload.answer.trim(), sources, quotes };
}

function unknownAnswer(reason) {
  const detail = reason === 'low_relevance' ? 'Подходящих фрагментов не найдено: релевантность контекста ниже порога.'
    : 'В найденных фрагментах недостаточно сведений для ответа.';
  return { status: 'unknown', answer: `Не знаю. ${detail} Уточните вопрос: укажите тему, термин или нужный фрагмент документа.`, sources: [], quotes: [] };
}

function renderAnswer(payload, result, jsonMode) {
  const sources = payload.sources.map(number => {
    const hit = result.hits[number - 1] || {};
    return { number, file: hit.file, section: hit.section, page_start: hit.page_start, page_end: hit.page_end, chunk_id: hit.chunk_id };
  });
  if (jsonMode) return JSON.stringify({ ...payload, sources });
  return payload.answer;
}

module.exports = { ANSWER_CONTRACT, eligibleSources, parseAnswer, unknownAnswer, renderAnswer };
