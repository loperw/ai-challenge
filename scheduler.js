const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const defaultSchedulePath = path.join(__dirname, 'data', 'schedules.sqlite');
const MAX_HISTORY = 1000;
const LEASE_MS = 60_000;

class ScheduleStore {
  constructor(file = process.env.SCHEDULE_DB_PATH || defaultSchedulePath) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL,
        payload TEXT NOT NULL, interval_ms INTEGER, next_run INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL,
        lease_token TEXT, lease_until INTEGER, successes INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL, finished_at INTEGER NOT NULL,
        result TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS schedule_runs_job ON schedule_runs(job_id, id DESC);
    `);
  }

  create({ kind, title, location, message, intervalSeconds, delaySeconds }, now = Date.now()) {
    if (!['weather', 'reminder'].includes(kind)) throw new Error('Тип: weather или reminder.');
    if (intervalSeconds != null && (!Number.isInteger(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 2_592_000)) {
      throw new Error('Интервал должен быть от 30 до 2592000 секунд.');
    }
    if (delaySeconds != null && (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 31_536_000)) {
      throw new Error('Задержка должна быть от 0 до 31536000 секунд.');
    }
    if (intervalSeconds == null && delaySeconds == null) throw new Error('Укажите интервал или задержку.');
    const content = kind === 'weather' ? location : message;
    if (typeof content !== 'string' || !content.trim() || content.length > (kind === 'weather' ? 120 : 2000)) {
      throw new Error(kind === 'weather' ? 'Укажите город (до 120 символов).' : 'Укажите текст напоминания (до 2000 символов).');
    }
    if (title != null && (typeof title !== 'string' || title.length > 160)) throw new Error('Название: до 160 символов.');
    const id = randomUUID();
    const payload = kind === 'weather' ? { location: content.trim(), days: 1, units: 'celsius' } : { message: content.trim() };
    this.db.prepare(`INSERT INTO schedules (id, title, kind, payload, interval_ms, next_run, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, title?.trim() || (kind === 'weather' ? `Погода: ${content}` : content).slice(0, 160),
      kind, JSON.stringify(payload), intervalSeconds == null ? null : intervalSeconds * 1000, now + (delaySeconds || 0) * 1000, now);
    return this.get(id);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
    if (!row) throw new Error('Расписание не найдено.');
    return { id: row.id, title: row.title, kind: row.kind, payload: JSON.parse(row.payload),
      intervalSeconds: row.interval_ms == null ? null : row.interval_ms / 1000,
      nextRunAt: row.status === 'active' ? new Date(row.next_run).toISOString() : null,
      status: row.status, createdAt: new Date(row.created_at).toISOString(),
      successes: row.successes, failures: row.failures, running: Boolean(row.lease_token) };
  }

  list() { return this.db.prepare('SELECT id FROM schedules ORDER BY created_at DESC').all().map(row => this.get(row.id)); }

  setStatus(id, status, now = Date.now()) {
    if (!['active', 'paused', 'cancelled'].includes(status)) throw new Error('Неизвестный статус.');
    const job = this.get(id);
    if (['completed', 'cancelled'].includes(job.status)) throw new Error('Расписание уже завершено.');
    // Invalidate an in-flight result when pausing or cancelling.
    this.db.prepare(`UPDATE schedules SET status = ?, next_run = ?, lease_token = NULL, lease_until = NULL WHERE id = ?`)
      .run(status, now, id);
    return this.get(id);
  }

  claim(now = Date.now()) {
    const token = randomUUID();
    // One atomic statement protects against overlapping ticks and multiple workers.
    const row = this.db.prepare(`UPDATE schedules SET lease_token = ?, lease_until = ?
      WHERE id = (SELECT id FROM schedules WHERE status = 'active' AND next_run <= ?
        AND (lease_until IS NULL OR lease_until <= ?) ORDER BY next_run LIMIT 1)
      RETURNING *`).get(token, now + LEASE_MS, now, now);
    return row ? { ...row, payload: JSON.parse(row.payload), token } : null;
  }

  finish(job, result, error, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const next = job.interval_ms == null ? job.next_run
        : job.next_run + (Math.floor(Math.max(0, now - job.next_run) / job.interval_ms) + 1) * job.interval_ms;
      const changed = this.db.prepare(`UPDATE schedules SET lease_token = NULL, lease_until = NULL,
        next_run = ?, status = ?, successes = successes + ?, failures = failures + ?
        WHERE id = ? AND lease_token = ? AND status = 'active'`)
        .run(next, job.interval_ms == null ? 'completed' : 'active', error ? 0 : 1, error ? 1 : 0, job.id, job.token);
      if (changed.changes) {
        this.db.prepare('INSERT INTO schedule_runs (job_id, scheduled_at, finished_at, result, error) VALUES (?, ?, ?, ?, ?)')
          .run(job.id, job.next_run, now, result == null ? null : JSON.stringify(result), error || null);
        this.db.prepare(`DELETE FROM schedule_runs WHERE job_id = ? AND id NOT IN
          (SELECT id FROM schedule_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?)`)
          .run(job.id, job.id, MAX_HISTORY);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  results(id, limit = 30) {
    const job = this.get(id);
    const rows = this.db.prepare('SELECT * FROM schedule_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?').all(id, MAX_HISTORY);
    const temperatures = rows.filter(row => !row.error).map(row => JSON.parse(row.result)?.current?.temperature).filter(Number.isFinite);
    const summary = { retainedRuns: rows.length, totalRuns: job.successes + job.failures,
      successes: job.successes, failures: job.failures,
      from: rows.length ? new Date(rows.at(-1).finished_at).toISOString() : null,
      to: rows.length ? new Date(rows[0].finished_at).toISOString() : null,
      temperature: temperatures.length ? { samples: temperatures.length, unit: '°C',
        min: Math.min(...temperatures), max: Math.max(...temperatures),
        average: Math.round(temperatures.reduce((sum, value) => sum + value, 0) / temperatures.length * 10) / 10 } : null };
    const runs = rows.slice(0, Math.min(100, Math.max(1, Math.floor(limit) || 30))).map(row => ({
      id: row.id, scheduledAt: new Date(row.scheduled_at).toISOString(), finishedAt: new Date(row.finished_at).toISOString(),
      result: row.result ? JSON.parse(row.result) : null, error: row.error
    }));
    return { job, summary, runs };
  }

  remove(id) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM schedule_runs WHERE job_id = ?').run(id);
      this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      return { ok: true, id };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  clear() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM schedule_runs; DELETE FROM schedules;');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  close() { this.db.close(); }
}

function startScheduler(store, { weather, intervalMs = 1000, now = Date.now, onError = console.error } = {}) {
  let busy = false;
  let stopped = false;
  let pending = Promise.resolve();
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      // Bounded batch: one slow job must not block every other due schedule.
      const jobs = [];
      for (let i = 0; i < 8; i++) { const job = store.claim(now()); if (!job) break; jobs.push(job); }
      await Promise.all(jobs.map(async job => {
        let result = null;
        let failure = null;
        try { result = job.kind === 'weather' ? await weather(job.payload) : { message: job.payload.message }; }
        catch (error) { failure = error.message || String(error); }
        store.finish(job, result, failure, now());
      }));
    } catch (error) { onError(error); }
    finally { busy = false; }
  }
  const run = () => { if (!busy && !stopped) pending = tick(); return pending; };
  const timer = setInterval(run, intervalMs);
  run();
  return { tick: run, async stop() { stopped = true; clearInterval(timer); await pending; } };
}

module.exports = { ScheduleStore, startScheduler, defaultSchedulePath };
