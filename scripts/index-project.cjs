const path = require('node:path');
const { buildProjectIndex, searchProject } = require('../project-help');
(async () => {
  const index = await buildProjectIndex();
  console.log(JSON.stringify({ chunks: index.chunks.length, model: index.model, dimension: index.dimension,
    embeddedCount: index.embeddedCount, fingerprint: index.fingerprint,
    output: path.join(__dirname, '../data/project-vectors.json'),
    ...(process.argv[2] && { hits: await searchProject(process.argv.slice(2).join(' '), index) }) }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
