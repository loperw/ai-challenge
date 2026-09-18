const { SQLiteStore } = require('./sqlite-store');

class MemoryStore extends SQLiteStore {}

module.exports = { MemoryStore };
