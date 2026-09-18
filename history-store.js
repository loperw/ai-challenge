const { SQLiteStore } = require('./sqlite-store');

class HistoryStore extends SQLiteStore {}
module.exports = { HistoryStore };
