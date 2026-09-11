const fs = require('node:fs');
const path = require('node:path');

class HistoryStore {
  constructor(file) {
    this.file = file;
    try { this.chats = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.chats = {}; }
  }
  write(chats) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(chats, null, 2), 'utf8');
    fs.renameSync(temporary, this.file);
    this.chats = JSON.parse(JSON.stringify(chats));
  }
  save(id, settings, messages) {
    this.write({ ...this.chats, [id]: { id, settings, messages, updatedAt: Date.now() } });
  }
  remove(id) { const next = { ...this.chats }; delete next[id]; this.write(next); }
  clear() { this.write({}); }
  list() { return Object.values(this.chats).sort((a, b) => b.updatedAt - a.updatedAt); }
}
module.exports = { HistoryStore };
