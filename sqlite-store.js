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
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        occupation TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT '',
        response_format TEXT NOT NULL DEFAULT '',
        constraints_text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_memories (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS task_memories_task_created
        ON task_memories(task_id, created_at);
      CREATE TABLE IF NOT EXISTS invariants (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('conversation', 'task', 'stateMachine', 'global')),
        position INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (owner_id, scope, position)
      );
    `);
    this.ensureInvariantSchema();
    this.migrateLegacy(legacyConversationsPath, legacyMemoryPath);
  }

  ensureInvariantSchema() {
    const columns = this.database.prepare('PRAGMA table_info(invariants)').all().map(column => column.name);
    if (columns.includes('scope') && columns.includes('id')) {
      this.database.exec('CREATE INDEX IF NOT EXISTS invariants_owner_position ON invariants(owner_id, scope, position);');
      return;
    }
    this.database.exec(`
      DROP INDEX IF EXISTS invariants_owner_position;
      ALTER TABLE invariants RENAME TO invariants_legacy;
      CREATE TABLE invariants (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('conversation', 'task', 'stateMachine', 'global')),
        position INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (owner_id, scope, position)
      );
      INSERT INTO invariants (id, owner_id, scope, position, content, created_at, updated_at)
        SELECT lower(hex(randomblob(16))), owner_id,
          CASE WHEN owner_id IN (SELECT id FROM tasks) THEN 'task' ELSE 'conversation' END,
          position, content, created_at, updated_at FROM invariants_legacy;
      DROP TABLE invariants_legacy;
      CREATE INDEX invariants_owner_position ON invariants(owner_id, scope, position);
    `);
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

  listChats() {
    const taskIds = new Set(this.listTasks().map(task => task.id));
    return this.list().filter(conversation => !taskIds.has(conversation.id));
  }

  invariantFromRow(row) {
    return row ? { id: row.id, ownerId: row.owner_id, scope: row.scope, content: row.content,
      createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  listInvariants(ownerId) {
    if (!ownerId) return [];
    return this.database.prepare(`SELECT * FROM invariants
      WHERE scope = 'global' OR owner_id = ?
      ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'stateMachine' THEN 2 ELSE 1 END, created_at, position`)
      .all(ownerId).map(row => this.invariantFromRow(row));
  }

  listGlobalInvariants() {
    return this.database.prepare("SELECT * FROM invariants WHERE scope = 'global' ORDER BY created_at, position")
      .all().map(row => this.invariantFromRow(row));
  }

  getInvariants(ownerId) {
    if (!ownerId) return [];
    return this.database.prepare(`SELECT content FROM invariants
      WHERE (scope = 'global' OR owner_id = ?) AND scope != 'stateMachine'
      ORDER BY CASE scope WHEN 'global' THEN 0 ELSE 1 END, created_at, position`)
      .all(ownerId).map(row => row.content);
  }

  getStateMachineInvariants(taskId) {
    if (!taskId) return [];
    return this.database.prepare("SELECT content FROM invariants WHERE owner_id = ? AND scope = 'stateMachine' ORDER BY created_at, position")
      .all(taskId).map(row => row.content);
  }

  addInvariant(ownerId, scope, content) {
    const normalizedScope = ['conversation', 'task', 'stateMachine', 'global'].includes(scope) ? scope : 'conversation';
    const normalizedOwner = normalizedScope === 'global' ? '__global__' : ownerId;
    const existing = this.database.prepare('SELECT * FROM invariants WHERE owner_id = ? AND scope = ? AND content = ?')
      .get(normalizedOwner, normalizedScope, content);
    if (existing) return this.invariantFromRow(existing);
    const now = Date.now();
    const position = this.database.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM invariants WHERE owner_id = ? AND scope = ?')
      .get(normalizedOwner, normalizedScope).position;
    const id = crypto.randomUUID();
    this.database.prepare('INSERT INTO invariants (id, owner_id, scope, position, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, normalizedOwner, normalizedScope, position, content, now, now);
    return this.invariantFromRow(this.database.prepare('SELECT * FROM invariants WHERE id = ?').get(id));
  }

  getInvariant(id) {
    return this.invariantFromRow(this.database.prepare('SELECT * FROM invariants WHERE id = ?').get(id));
  }

  removeInvariant(id) {
    return Boolean(this.database.prepare('DELETE FROM invariants WHERE id = ?').run(id).changes);
  }

  profileFromRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      occupation: row.occupation,
      language: row.language,
      responseFormat: row.response_format,
      constraints: row.constraints_text,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listProfiles() {
    return this.database.prepare('SELECT * FROM profiles ORDER BY updated_at DESC, rowid DESC').all()
      .map(row => this.profileFromRow(row));
  }

  getProfile(id) {
    if (!id) return null;
    return this.profileFromRow(this.database.prepare('SELECT * FROM profiles WHERE id = ?').get(id));
  }

  createProfile(profile) {
    const now = Date.now();
    const id = crypto.randomUUID();
    this.database.prepare(`INSERT INTO profiles
      (id, name, occupation, language, response_format, constraints_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, profile.name, profile.occupation, profile.language, profile.responseFormat, profile.constraints, now, now);
    return this.getProfile(id);
  }

  updateProfile(id, profile) {
    const result = this.database.prepare(`UPDATE profiles SET
      name = ?, occupation = ?, language = ?, response_format = ?, constraints_text = ?, updated_at = ?
      WHERE id = ?`)
      .run(profile.name, profile.occupation, profile.language, profile.responseFormat, profile.constraints, Date.now(), id);
    return result.changes ? this.getProfile(id) : null;
  }

  deleteProfile(id) {
    return this.transaction(() => {
      const result = this.database.prepare('DELETE FROM profiles WHERE id = ?').run(id);
      if (!result.changes) return false;
      const conversations = this.database.prepare('SELECT id, settings_json FROM conversations').all();
      const update = this.database.prepare('UPDATE conversations SET settings_json = ? WHERE id = ?');
      for (const conversation of conversations) {
        const settings = parseJson(conversation.settings_json, {});
        if (settings.profileId !== id) continue;
        update.run(JSON.stringify({ ...settings, profileId: '' }), conversation.id);
      }
      const tasks = this.database.prepare('SELECT id, state_json FROM tasks').all();
      const updateTask = this.database.prepare('UPDATE tasks SET state_json = ?, updated_at = ? WHERE id = ?');
      for (const row of tasks) {
        const task = parseJson(row.state_json, {});
        if (task.profileId !== id) continue;
        updateTask.run(JSON.stringify({ ...task, profileId: '', updatedAt: Date.now() }), Date.now(), row.id);
      }
      return true;
    });
  }

  taskFromRow(row) {
    if (!row) return null;
    return parseJson(row.state_json, null);
  }

  listTasks() {
    return this.database.prepare('SELECT * FROM tasks ORDER BY updated_at DESC, rowid DESC').all()
      .map(row => this.taskFromRow(row));
  }

  getTask(id) {
    return this.taskFromRow(this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  }

  saveTask(task) {
    this.database.prepare(`INSERT INTO tasks (id, state_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at`)
      .run(task.id, JSON.stringify(task), task.createdAt || Date.now(), task.updatedAt || Date.now());
    return this.getTask(task.id);
  }

  removeTask(id) {
    return this.transaction(() => {
      this.database.prepare('DELETE FROM task_memories WHERE task_id = ?').run(id);
      this.database.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      this.database.prepare('DELETE FROM agent_messages WHERE conversation_id = ?').run(id);
      this.database.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      this.database.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
      this.database.prepare('DELETE FROM memories WHERE conversation_id = ?').run(id);
      this.database.prepare('DELETE FROM invariants WHERE owner_id = ?').run(id);
      return true;
    });
  }

  remove(id) {
    this.transaction(() => {
      this.database.prepare('DELETE FROM agent_messages WHERE conversation_id = ?').run(id);
      this.database.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      this.database.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
      this.database.prepare("DELETE FROM memories WHERE scope = 'working' AND conversation_id = ?").run(id);
      this.database.prepare('DELETE FROM invariants WHERE owner_id = ?').run(id);
    });
  }

  clear() {
    this.transaction(() => {
      this.database.exec('DELETE FROM agent_messages; DELETE FROM conversations; DELETE FROM messages; DELETE FROM memories; DELETE FROM task_memories; DELETE FROM tasks; DELETE FROM invariants;');
    });
  }

  view(conversationId) {
    const shortTerm = this.database.prepare('SELECT role, content, memory_command, memory_type, created_at FROM messages WHERE conversation_id = ? ORDER BY position').all(conversationId)
      .map(item => ({ role: item.role, content: item.content, ...(item.memory_command && { memoryCommand: true }), ...(item.memory_type && { memoryType: item.memory_type }), createdAt: item.created_at }));
    const task = this.getTask(conversationId);
    const memoryRows = this.database.prepare(task
      ? "SELECT id, scope, content, created_at FROM memories WHERE scope = 'working' AND conversation_id = ? ORDER BY created_at, rowid"
      : "SELECT id, scope, content, created_at FROM memories WHERE (scope = 'working' AND conversation_id = ?) OR scope = 'longTerm' ORDER BY created_at, rowid").all(conversationId);
    const map = item => ({ id: item.id, content: item.content, createdAt: item.created_at });
    const taskLongTerm = task ? this.database.prepare('SELECT id, content, created_at FROM task_memories WHERE task_id = ? ORDER BY created_at, rowid').all(conversationId).map(map) : null;
    return {
      shortTerm,
      working: memoryRows.filter(item => item.scope === 'working').map(map),
      longTerm: taskLongTerm || memoryRows.filter(item => item.scope === 'longTerm').map(map)
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
    this.transaction(() => {
      if (type === 'longTerm' && this.getTask(conversationId)) {
        this.database.prepare('INSERT INTO task_memories (id, task_id, content, created_at) VALUES (?, ?, ?, ?)')
          .run(item.id, conversationId, content, item.createdAt);
      } else this.insertMemory(conversationId, type, content, item);
    });
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
