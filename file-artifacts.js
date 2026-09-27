const path = require('node:path');
const fs = require('node:fs/promises');

function validFilename(name) {
  return typeof name === 'string' && name.length <= 120
    && /^[\p{L}\p{N}_-][\p{L}\p{N}_. -]*\.(?:txt|md)$/u.test(name)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}
function fileArtifact(filename, bytes) {
  if (!validFilename(filename)) throw new Error('Недопустимое имя файла.');
  const url = `/api/files/${encodeURIComponent(filename)}`;
  return { name: filename, bytes, previewUrl: url, downloadUrl: `${url}?download=1` };
}

// Upgrade old replies that linked a real exported file before cards existed.
async function restoreLegacyFileCards(messages, outputDir = process.env.PIPELINE_OUTPUT_DIR || path.resolve('data/exports')) {
  return Promise.all(messages.map(async message => {
    if (message.role !== 'assistant' || message.files?.length) return message;
    const files = [];
    let content = message.content;
    for (const match of content.matchAll(/^(?:Сохранено|Файл сохран[её]н):[ \t]*`?([^`\r\n]+)`?[ \t]*$/gmi)) {
      const target = path.resolve(match[1].trim());
      if (path.dirname(target) !== path.resolve(outputDir) || !validFilename(path.basename(target))) continue;
      try {
        const stat = await fs.stat(target);
        if (!stat.isFile()) continue;
        files.push(fileArtifact(path.basename(target), stat.size));
        content = content.replace(match[0], '').trim();
      } catch { /* Keep old text if the file no longer exists. */ }
    }
    return files.length ? { ...message, content: content || 'Готово.', files } : message;
  }));
}

async function serveFileArtifact(request, response, outputDir = process.env.PIPELINE_OUTPUT_DIR || path.resolve('data/exports')) {
  const rawName = request.url.slice('/api/files/'.length).split('?')[0];
  try {
    const name = decodeURIComponent(rawName);
    if (!validFilename(name)) throw new Error('invalid');
    const root = await fs.realpath(outputDir);
    const target = await fs.realpath(path.join(root, name));
    if (path.dirname(target) !== root) throw new Error('invalid');
    const contents = await fs.readFile(target);
    const download = new URL(request.url, 'http://localhost').searchParams.get('download') === '1';
    response.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': contents.length,
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="file.${path.extname(name).slice(1)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    });
    response.end(contents);
  } catch {
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'Файл недоступен или был удалён.' }));
  }
}

module.exports = { validFilename, fileArtifact, serveFileArtifact, restoreLegacyFileCards };
