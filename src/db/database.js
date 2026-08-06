/**
 * Database utility — Wrapper around sql.js for synchronous-style access.
 * sql.js runs SQLite in WASM, so no native compilation needed.
 */
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '..', '..', 'incidentiq.db');

let dbInstance = null;
let SQL = null;

/**
 * Initialize sql.js and open/create the database
 */
export async function openDb() {
  if (dbInstance) return dbInstance;

  SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    dbInstance = new SQL.Database(buffer);
  } else {
    // Create new DB with schema
    dbInstance = new SQL.Database();
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    dbInstance.run(schema);
    saveDb();
  }

  return dbInstance;
}

/**
 * Get the current database instance (must call openDb first)
 */
export function getDb() {
  if (!dbInstance) throw new Error('Database not initialized. Call openDb() first.');
  return dbInstance;
}

/**
 * Save database to disk
 */
export function saveDb() {
  if (!dbInstance) return;
  const data = dbInstance.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

/**
 * Auto-save periodically (every 5 seconds)
 */
let saveInterval = null;
export function startAutoSave(intervalMs = 5000) {
  if (saveInterval) return;
  saveInterval = setInterval(() => {
    saveDb();
  }, intervalMs);
}

/**
 * Helper: Execute a query and return all rows as objects
 */
export function queryAll(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);

  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

/**
 * Helper: Execute a query and return the first row as object
 */
export function queryOne(sql, params = []) {
  const results = queryAll(sql, params);
  return results.length > 0 ? results[0] : null;
}

/**
 * Helper: Execute a statement (INSERT/UPDATE/DELETE)
 */
export function execute(sql, params = []) {
  const db = getDb();
  db.run(sql, params);
}

export { DB_PATH };
