import fs from 'node:fs';
import path from 'node:path';
import { appDir } from './env.mjs';

const corpusPath = path.join(appDir, 'knowledge', 'rail-rules.md');
const words = (text) => new Set(String(text).toLocaleLowerCase('ru').match(/[\p{L}\p{N}]+/gu) || []);

export function retrieveRailKnowledge(query, limit = 3) {
  const text = fs.readFileSync(corpusPath, 'utf8');
  const chunks = text.split(/(?=^## )/m).filter(Boolean);
  const queryWords = words(query);
  return chunks
    .map((chunk) => {
      const chunkWords = words(chunk);
      const score = [...queryWords].reduce((sum, word) => sum + Number(chunkWords.has(word)), 0);
      return { chunk: chunk.trim(), score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ chunk, score }) => ({ text: chunk, score }));
}
