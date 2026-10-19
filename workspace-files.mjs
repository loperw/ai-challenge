import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const workspaceRoot = process.env.FILE_WORKSPACE_ROOT || fileURLToPath(new URL('.', import.meta.url));
const excluded = /^(?:\..*|node_modules|data|vendor|dist|__pycache__|.*(?:secret|credential).*|.*\.(?:pem|key|sqlite|log))$/i;
const extensions = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.html', '.css', '.py', '.ts', '.tsx', '.jsx']);
export class WorkspaceFiles {
  constructor(root = workspaceRoot) { this.root = path.resolve(root); }
  async resolve(name) {
    if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || path.isAbsolute(name)
      || name.split('/').some(part => !part || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || excluded.test(part)) || !extensions.has(path.extname(name))) throw new Error('Недопустимый путь или тип файла.');
    let current = this.root;
    for (const part of name.split('/')) {
      current = path.join(current, part);
      try { const stat = await fs.lstat(current); if (stat.isSymbolicLink() || stat.nlink > 1 && stat.isFile()) throw new Error('Ссылки запрещены.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return current;
  }
  async read(name) {
    const target = await this.resolve(name);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 200000) throw new Error('Файл слишком большой или не является текстовым файлом.');
    const text = await fs.readFile(target, 'utf8');
    if (text.includes('\0')) throw new Error('Бинарный файл.');
    return text;
  }
  async list() {
    const files = []; let truncated = false;
    const walk = async (dir, prefix = '') => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (excluded.test(entry.name) || entry.isSymbolicLink()) continue;
        if (files.length >= 1000) { truncated = true; return; }
        const name = prefix + entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), name + '/');
        else if (extensions.has(path.extname(name))) files.push(name);
      }
    };
    await walk(this.root); return { files: files.sort(), truncated };
  }
  async search(query) {
    if (!query) throw new Error('Пустой запрос.');
    const inventory = await this.list(), matches = [], skipped = [];
    for (const name of inventory.files) {
      try { (await this.read(name)).split('\n').forEach((text, i) => { if (text.includes(query) && matches.length < 300) matches.push({ path: name, line: i + 1, text }); }); }
      catch { skipped.push(name); }
    }
    return { matches, skipped, truncated: inventory.truncated || matches.length === 300 };
  }
  async propose(changes, purpose = 'file_changes') {
    if (!Array.isArray(changes) || !changes.length || changes.length > 10) throw new Error('Нужно от 1 до 10 изменений.');
    const seen = new Set(), entries = [];
    for (const change of changes) {
      const target = await this.resolve(change.path);
      const key = target.toLowerCase();
      if (seen.has(key) || typeof change.content !== 'string' || Buffer.byteLength(change.content) > 200000) throw new Error('Повтор пути или слишком большой файл.');
      seen.add(key);
      let before = null;
      try { before = await this.read(change.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (before !== change.content) entries.push({ path: change.path, before, after: change.content });
    }
    return { id: randomUUID(), purpose, status: entries.length ? 'pending' : 'unchanged', entries,
      diff: entries.map(({ path: name, before, after }) => {
        const lines = text => text === '' ? [] : text.split('\n').flatMap((line, i, all) => i === all.length - 1 && line === '' ? [] : [line]);
        const old = lines(before ?? ''), next = lines(after);
        return `--- ${before === null ? '/dev/null' : 'a/' + name}\n+++ b/${name}\n@@ -${old.length ? 1 : 0},${old.length} +${next.length ? 1 : 0},${next.length} @@\n`
          + old.map(line => '-' + line + '\n').join('') + (before && !before.endsWith('\n') ? '\\ No newline at end of file\n' : '')
          + next.map(line => '+' + line + '\n').join('') + (after && !after.endsWith('\n') ? '\\ No newline at end of file\n' : '');
      }).join('\n') };
  }
  async decide(proposal, approve) {
    if (typeof approve !== 'boolean') throw new Error('Нужно решение Да или Нет.');
    if (proposal.status !== 'pending') return proposal;
    if (!approve) { proposal.status = 'rejected'; return proposal; }
    proposal.status = 'applying';
    try {
      for (const entry of proposal.entries) {
        let current = null;
        try { current = await this.read(entry.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (current !== entry.before) { proposal.status = 'conflict'; throw new Error(`Файл ${entry.path} изменился. Попросите ассистента подготовить новый diff.`); }
      }
      proposal.applied = [];
      for (const entry of proposal.entries) {
        const target = await this.resolve(entry.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, entry.after, { encoding: 'utf8', flag: entry.before === null ? 'wx' : 'w' });
        proposal.applied.push(entry.path);
      }
      proposal.status = 'applied'; return proposal;
    } catch (error) { if (proposal.status === 'applying') proposal.status = 'failed'; throw error; }
  }
  async createReport(name, content) {
    if (path.extname(name) !== '.md') throw new Error('Отчёт должен быть Markdown-файлом (.md).');
    const proposal = await this.propose([{ path: name, content }]);
    if (proposal.entries.some(entry => entry.before !== null)) throw new Error('Отчёт уже существует и отличается. Используйте propose_changes.');
    if (proposal.status === 'pending') await this.decide(proposal, true);
    return { path: name, status: proposal.status, report: { path: name, text: content } };
  }
}
