/*
 * Storage for the fingerprint PoC.
 *
 * SQLite through Bun's built-in driver (bun:sqlite), no dependencies.
 * The schema: append-only observations, one row per known device, counters per
 * attribute value.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at   INTEGER NOT NULL,
  visitor_id    TEXT,
  payload_hash  TEXT NOT NULL,
  platform      TEXT NOT NULL,
  ua_family     TEXT NOT NULL,
  ua_major      INTEGER NOT NULL,
  screen_bucket TEXT NOT NULL,
  gpu_family    TEXT NOT NULL,
  ip_hash       TEXT,
  attrs         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_hash    ON observations(payload_hash);
CREATE INDEX IF NOT EXISTS idx_obs_visitor ON observations(visitor_id);
CREATE INDEX IF NOT EXISTS idx_obs_time    ON observations(received_at);
CREATE INDEX IF NOT EXISTS idx_obs_block   ON observations(platform, screen_bucket, received_at);

CREATE TABLE IF NOT EXISTS devices (
  visitor_id        TEXT PRIMARY KEY,
  first_seen        INTEGER NOT NULL,
  last_seen         INTEGER NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 0,
  confidence        REAL NOT NULL DEFAULT 1.0,
  canonical         TEXT NOT NULL,
  platform          TEXT NOT NULL,
  ua_family         TEXT NOT NULL,
  screen_bucket     TEXT NOT NULL,
  gpu_family        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_block ON devices(platform, last_seen);

CREATE TABLE IF NOT EXISTS attribute_stats (
  attr       TEXT NOT NULL,
  value_hash TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (attr, value_hash)
);

CREATE TABLE IF NOT EXISTS links (
  observation_id INTEGER NOT NULL,
  visitor_id     TEXT NOT NULL,
  score          REAL NOT NULL,
  method         TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_visitor ON links(visitor_id);
`;

export function openDb(path = ':memory:'): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}
