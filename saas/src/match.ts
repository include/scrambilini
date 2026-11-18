/*
 * Matching: does this observation belong to a device we already know?
 *
 * Three steps:
 *   1. exact payload hash
 *   2. blocking: candidates from the same platform, recent
 *   3. weighted similarity score, with a decision threshold
 */
import type { Database } from 'bun:sqlite';
import { WEIGHTS, payloadHash, sha256, type AttrValue, type Canonical } from './normalize';

export const SAME_DEVICE = 0.85;
export const AMBIGUOUS = 0.6;
export const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
// A real system replaces this with an approximate index (see the tech doc).
// Scanning more candidates is accurate but grows linearly with the device count.
const MAX_CANDIDATES = Number(Bun.env.MAX_CANDIDATES ?? 2000);

export interface Observation extends Canonical {
  hash: string;
  receivedAt: number;
  ipHash?: string;
}

export interface MatchResult {
  visitorId: string;
  score: number;
  method: 'exact' | 'similarity' | 'new';
  isNew: boolean;
  /** Best candidate score, even when it was below the threshold. */
  bestScore: number;
}

function jaccard(a: Scalar[], b: Scalar[]): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const left = new Set(a.map(String));
  const right = new Set(b.map(String));
  let shared = 0;
  for (const value of left) if (right.has(value)) shared += 1;
  return shared / (left.size + right.size - shared);
}

type Scalar = string | number | boolean;

function similarity(key: string, a: AttrValue, b: AttrValue): number {
  const aEmpty = a === '' || (Array.isArray(a) && a.length === 0);
  const bEmpty = b === '' || (Array.isArray(b) && b.length === 0);
  if (aEmpty && bEmpty) return 1;
  if (aEmpty || bEmpty) return 0;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return 0;
    return jaccard(a, b);
  }
  if (typeof a === 'number' && typeof b === 'number') {
    if (key === 'uaMajor') return 1 - Math.min(1, Math.abs(a - b) / 10);
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    return 1 - Math.min(1, Math.abs(a - b) / scale);
  }
  return String(a) === String(b) ? 1 : 0;
}

/** Weighted similarity of two attribute sets, in [0, 1]. */
export function scorePair(a: Record<string, AttrValue>, b: Record<string, AttrValue>): number {
  // Hard rules: an OS or a browser engine does not change under the same
  // install. These two can never be the same device, whatever else matches.
  if (String(a.platform) !== String(b.platform)) return 0;
  if (String(a.uaFamily) !== String(b.uaFamily)) return 0;

  let total = 0;
  let sum = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const sim = similarity(key, a[key] ?? '', b[key] ?? '');
    total += weight;
    sum += weight * sim;
  }
  return total === 0 ? 0 : sum / total;
}

function newVisitorId(): string {
  return `v_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function exactMatch(db: Database, hash: string, now: number): string | null {
  const row = db
    .query(
      `SELECT visitor_id FROM observations
       WHERE payload_hash = ? AND visitor_id IS NOT NULL AND received_at > ?
       ORDER BY received_at DESC LIMIT 1`,
    )
    .get(hash, now - WINDOW_MS) as { visitor_id: string } | null;
  return row ? row.visitor_id : null;
}

function candidatesFor(db: Database, obs: Observation, now: number) {
  return db
    .query(
      `SELECT visitor_id, canonical FROM devices
       WHERE platform = ? AND gpu_family = ? AND last_seen > ?
       ORDER BY last_seen DESC LIMIT ?`,
    )
    .all(obs.platform, obs.gpuFamily, now - WINDOW_MS, MAX_CANDIDATES) as Array<{
    visitor_id: string;
    canonical: string;
  }>;
}

function recordStats(db: Database, attrs: Record<string, AttrValue>, now: number): void {
  const upsert = db.query(
    `INSERT INTO attribute_stats (attr, value_hash, count) VALUES (?, ?, 1)
     ON CONFLICT(attr, value_hash) DO UPDATE SET count = count + 1`,
  );
  for (const [attr, value] of Object.entries(attrs)) {
    upsert.run(attr, sha256(JSON.stringify(value)));
  }
}

function saveDevice(db: Database, obs: Observation, visitorId: string, now: number, isNew: boolean) {
  const canonical = JSON.stringify(obs.attrs);
  if (isNew) {
    db.query(
      `INSERT INTO devices
       (visitor_id, first_seen, last_seen, observation_count, confidence, canonical,
        platform, ua_family, screen_bucket, gpu_family)
       VALUES (?, ?, ?, 1, 1.0, ?, ?, ?, ?, ?)`,
    ).run(visitorId, now, now, canonical, obs.platform, obs.uaFamily, obs.screenBucket, obs.gpuFamily);
    return;
  }
  db.query(
    `UPDATE devices
     SET last_seen = ?, observation_count = observation_count + 1, canonical = ?,
         platform = ?, ua_family = ?, screen_bucket = ?, gpu_family = ?
     WHERE visitor_id = ?`,
  ).run(now, canonical, obs.platform, obs.uaFamily, obs.screenBucket, obs.gpuFamily, visitorId);
}

/** Store one observation and decide which device it belongs to. */
export function observe(db: Database, obs: Observation): MatchResult {
  const now = obs.receivedAt;
  const hash = obs.hash || payloadHash(obs);

  let visitorId = exactMatch(db, hash, now);
  let method: MatchResult['method'] = 'exact';
  let score = 1;
  let bestScore = 0;

  if (!visitorId) {
    let best: { id: string; score: number } | null = null;
    for (const candidate of candidatesFor(db, obs, now)) {
      const attrs = JSON.parse(candidate.canonical) as Record<string, AttrValue>;
      const candidateScore = scorePair(attrs, obs.attrs);
      if (!best || candidateScore > best.score) best = { id: candidate.visitor_id, score: candidateScore };
    }
    if (best) bestScore = best.score;
    if (best && best.score >= SAME_DEVICE) {
      visitorId = best.id;
      score = best.score;
      method = 'similarity';
    }
  }

  const isNew = !visitorId;
  if (!visitorId) {
    visitorId = newVisitorId();
    method = 'new';
    score = 1;
  }

  const inserted = db
    .query(
      `INSERT INTO observations
       (received_at, visitor_id, payload_hash, platform, ua_family, ua_major, screen_bucket, gpu_family, ip_hash, attrs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(now, visitorId, hash, obs.platform, obs.uaFamily, obs.uaMajor, obs.screenBucket, obs.gpuFamily, obs.ipHash ?? null, JSON.stringify(obs.attrs));

  db.query(
    `INSERT INTO links (observation_id, visitor_id, score, method, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(Number(inserted.lastInsertRowid), visitorId, score, method, now);

  saveDevice(db, obs, visitorId, now, isNew);
  recordStats(db, obs.attrs, now);

  return { visitorId, score, method, isNew, bestScore };
}
