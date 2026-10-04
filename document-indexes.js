const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function describeIndexes(directory) {
  const preparation = readJson(path.join(directory, 'preparation.json'));
  const comparison = readJson(path.join(directory, 'comparison.json'));
  const retrieval = readJson(path.join(directory, 'retrieval-comparison.json'));
  const strategies = {};
  let book = null;
  for (const strategy of ['fixed', 'structure']) {
    const file = path.join(directory, `${strategy}.sqlite`);
    if (!fs.existsSync(file)) { strategies[strategy] = { available: false }; continue; }
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const metadata = Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(row => [row.key, JSON.parse(row.value)]));
      const rows = db.prepare('SELECT text,metadata_json FROM chunks ORDER BY rowid LIMIT 3').all();
      const chunks = db.prepare('SELECT COUNT(*) AS count FROM chunks').get().count;
      const matches = preparation.sha256 === metadata.source_sha256;
      const measurements = comparison.model_digest === metadata.model_digest && comparison.source === metadata.source ? comparison.strategies?.[strategy] : null;
      if (!book) book = { file: path.basename(metadata.source), source: metadata.source,
        pages: matches ? preparation.pages : null, sections: matches ? preparation.sections : null };
      strategies[strategy] = { available: true, chunks, bytes: fs.statSync(file).size,
        model: metadata.model, dimensions: metadata.dimensions, size: metadata.size_chars,
        overlap: metadata.overlap_chars, createdAt: metadata.created_at,
        seconds: measurements?.total_seconds ?? null,
        crossSections: measurements?.cross_section_chunks ?? null,
        hitAt5: retrieval.k === 5 && measurements ? retrieval.strategies?.[strategy]?.hit_at_k ?? null : null,
        queryCount: retrieval.strategies?.[strategy]?.cases?.length ?? 0,
        samples: rows.map(row => ({ ...JSON.parse(row.metadata_json), text: row.text })) };
    } catch { strategies[strategy] = { available: false, error: 'Индекс не удалось прочитать.' }; }
    finally { db?.close(); }
  }
  return { book, strategies };
}
module.exports = { describeIndexes };
