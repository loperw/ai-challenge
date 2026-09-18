const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function readLegacy(file) {
  if (!file || !fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

class SQLiteStore {
  constructor(file, { legacyConversationsPath, legacyMemoryPath } = {}) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.database = new DatabaseSync(file);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        settings_json TEXT NOT NULL,
        token_stats_json TEXT,
        context_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_messages (
        conversation_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (conversation_id, position),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        memory_command INTEGER NOT NULL DEFAULT 0,
        memory_type TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_conversation_position
        ON messages(conversation_id, position);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('working', 'longTerm')),
        conversation_id TEXT,
        memory_key TEXT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_scope_conversation
        ON memories(scope, conversation_id, created_at);
    `);
    this.migrateLegacy(legacyConversationsPath, legacyMemoryPath);
  }

  transaction(action) {
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.database.exec('COMMIT'); return result; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  migrateLegacy(conversationsPath, memoryPath) {
    const migrated = this.database.prepare('SELECT value FROM meta WHERE key = ?').get('legacy_json_migrated');
    if (migrated) return;
    const legacyChats = readLegacy(conversationsPath);
    const legacyMemory = readLegacy(memoryPath);
    this.transaction(() => {
      for (const chat of Object.values(legacyChats)) {
        if (!chat?.id) continue;
        this.upsertConversation(chat.id, chat.settings || {}, chat.messages || [], chat.tokenStats ?? null, chat.context || {}, chat.updatedAt || Date.now());
        const shortTerm = legacyMemory.shortTermByConversation?.[chat.id];
        this.insertShortTerm(chat.id, Array.isArray(shortTerm) ? shortTerm : (chat.messages || []));
      }
      for (const [conversationId, entries] of Object.entries(legacyMemory.workingByConversation || {})) {
        for (const item of entries || []) this.insertMemory(conversationId, 'working', item.content, item);
      }
      for (const item of legacyMemory.longTerm || []) this.insertMemory(null, 'longTerm', item.content, item);
      this.database.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('legacy_json_migrated', String(Date.now()));
    });
  }

  upsertConversation(id, settings, messages, tokenStats, context, updatedAt = Date.now()) {
    this.database.prepare(`INSERT INTO conversations (id, settings_json, token_stats_json, context_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json, token_stats_json=excluded.token_stats_json,
      context_json=excluded.context_json, updated_at=excluded.updated_at`)
      .run(id, JSON.stringify(settings), tokenStats == null ? null : JSON.stringify(tokenStats), JSON.stringify(context || {}), updatedAt);
    this.database.prepare('DELETE FROM agent_messages WHERE conversation_id = ?').run(id);
    const insert = this.database.prepare('INSERT INTO agent_messages (conversation_id, position, payload_json) VALUES (?, ?, ?)');
    messages.forEach((message, position) => insert.run(id, position, JSON.stringify(message)));
  }

  save(id, settings, messages, tokenStats = null, context = {}) {
    this.transaction(() => this.upsertConversation(id, settings, messages, tokenStats, context));
  }

  conversationFromRow(row) {
    const messages = this.database.prepare('SELECT payload_json FROM agent_messages WHERE conversation_id = ? ORDER BY position').all(row.id)
      .map(item => parseJson(item.payload_json, {}));
    return {
      id: row.id,
      settings: parseJson(row.settings_json, {}),
      messages,
      tokenStats: parseJson(row.token_stats_json, null),
      context: parseJson(row.context_json, {}),
      updatedAt: row.updated_at
    };
  }

  get chats() {
    return Object.fromEntries(this.list().map(chat => [chat.id, chat]));
  }

  list() {
    return this.database.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all()
      .map(row => this.conversationFromRow(row));
  }

  remove(id) {
    this.transaction(() => {
      this.database.prepare('DELETE FROM agent_messages WHERE conversation_id = ?').run(id);
      this.database.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      this.database.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
      this.database.prepare("DELETE FROM memories WHERE scope = 'working' AND conversation_id = ?").run(id);
    });
  }

  clear() {
    this.transaction(() => {
      this.database.exec('DELETE FROM agent_messages; DELETE FROM conversations; DELETE FROM messages; DELETE FROM memories;');
    });
  }

  view(conversationId) {
    const shortTerm = this.database.prepare('SELECT role, content, memory_command, memory_type, created_at FROM messages WHERE conversation_id = ? ORDER BY position').all(conversationId)
      .map(item => ({ role: item.role, content: item.content, ...(item.memory_command && { memoryCommand: true }), ...(item.memory_type && { memoryType: item.memory_type }), createdAt: item.created_at }));
    const memoryRows = this.database.prepare("SELECT id, scope, content, created_at FROM memories WHERE (scope = 'working' AND conversation_id = ?) OR scope = 'longTerm' ORDER BY created_at, rowid").all(conversationId);
    const map = item => ({ id: item.id, content: item.content, createdAt: item.created_at });
    return {
      shortTerm,
      working: memoryRows.filter(item => item.scope === 'working').map(map),
      longTerm: memoryRows.filter(item => item.scope === 'longTerm').map(map)
    };
  }

  insertMemory(conversationId, scope, content, source = {}) {
    const now = source.createdAt || Date.now();
    this.database.prepare('INSERT OR REPLACE INTO memories (id, scope, conversation_id, memory_key, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(source.id || crypto.randomUUID(), scope, scope === 'longTerm' ? null : conversationId, source.memoryKey || null, content, now, source.updatedAt || now);
  }

  add(conversationId, type, content) {
    if (!['working', 'longTerm'].includes(type)) throw new Error('Неизвестный тип памяти.');
    const item = { id: crypto.randomUUID(), content, createdAt: Date.now() };
    this.transaction(() => this.insertMemory(conversationId, type, content, item));
    return item;
  }

  insertShortTerm(conversationId, messages) {
    const current = this.database.prepare('SELECT COALESCE(MAX(position), -1) AS position FROM messages WHERE conversation_id = ?').get(conversationId).position;
    const insert = this.database.prepare('INSERT INTO messages (id, conversation_id, position, role, content, memory_command, memory_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    return messages.map((message, offset) => {
      const item = { id: message.id || crypto.randomUUID(), createdAt: message.createdAt || Date.now(), ...message };
      insert.run(item.id, conversationId, current + offset + 1, item.role, item.content, item.memoryCommand ? 1 : 0, item.memoryType || null, item.createdAt);
      return item;
    });
  }

  addShortTerm(conversationId, messages) {
    return this.transaction(() => this.insertShortTerm(conversationId, messages));
  }

  removeConversation(conversationId) {
    this.transaction(() => {
      this.database.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
      this.database.prepare("DELETE FROM memories WHERE scope = 'working' AND conversation_id = ?").run(conversationId);
    });
  }

  close() {
    if (!this.database) return;
    this.database.close();
    this.database = null;
  }
}

module.exports = { SQLiteStore };
