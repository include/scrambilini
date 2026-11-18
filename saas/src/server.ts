/*
 * Minimal fingerprint SaaS — proof of concept.
 *
 *   bun run src/server.ts
 *
 * Endpoints:
 *   POST /v1/observe        collect one visit, return the visitor id
 *   GET  /v1/visitor/:id    what we know about one device
 *   GET  /v1/stats          counts and attribute diversity
 *   GET  /demo              a page that fingerprints itself
 *   GET  /collect.js        the customer-side script
 *   GET  /                  dashboard
 */
import { join } from 'node:path';
import { openDb } from './db';
import { payloadHash, canonicalize, sha256 } from './normalize';
import { observe, type Observation } from './match';

const PORT = Number(Bun.env.PORT ?? 8787);
const dbPath = Bun.env.DB_PATH ?? join(import.meta.dir, '..', 'data', 'fp.db');
const db = openDb(dbPath);
const IP_SALT = Bun.env.IP_SALT ?? 'dev-salt-change-me';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --line: #e4e4e7; --muted: #666; }
  @media (prefers-color-scheme: dark) { :root { --line: #27272a; --muted: #a1a1aa; } }
  body { margin: 0; padding: 32px; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 900px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 28px 0 8px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  p.sub { color: var(--muted); margin: 0 0 24px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  th { font-weight: 600; color: var(--muted); font-size: 12px; }
  code { font-size: 12px; }
  .big { font-size: 26px; font-weight: 650; }
  .cards { display: flex; gap: 24px; flex-wrap: wrap; }
  .card { min-width: 120px; }
  .muted { color: var(--muted); }
  .new { color: #16a34a; } .same { color: #4f46e5; }
</style></head><body>${body}</body></html>`;

function dashboard(): Response {
  const totals = db
    .query('SELECT COUNT(*) AS observations, COUNT(DISTINCT visitor_id) AS devices FROM observations')
    .get() as { observations: number; devices: number };
  const methods = db
    .query('SELECT method, COUNT(*) AS n FROM links GROUP BY method ORDER BY n DESC')
    .all() as Array<{ method: string; n: number }>;
  const attrs = db
    .query(
      `SELECT attr, COUNT(*) AS distinct_values, SUM(count) AS seen
       FROM attribute_stats GROUP BY attr ORDER BY distinct_values DESC`,
    )
    .all() as Array<{ attr: string; distinct_values: number; seen: number }>;
  const devices = db
    .query(
      `SELECT visitor_id, first_seen, last_seen, observation_count
       FROM devices ORDER BY last_seen DESC LIMIT 15`,
    )
    .all() as Array<{ visitor_id: string; first_seen: number; last_seen: number; observation_count: number }>;

  const rows = devices
    .map(
      (d) => `<tr><td><code>${d.visitor_id}</code></td>
        <td>${new Date(d.first_seen).toLocaleString()}</td>
        <td>${new Date(d.last_seen).toLocaleString()}</td>
        <td>${d.observation_count}</td></tr>`,
    )
    .join('');

  const methodRows = methods
    .map((m) => `<tr><td>${m.method}</td><td>${m.n}</td></tr>`)
    .join('');

  const attrRows = attrs
    .map((a) => `<tr><td>${a.attr}</td><td>${a.distinct_values}</td><td>${a.seen}</td></tr>`)
    .join('');

  return new Response(
    layout(
      'Fingerprint PoC',
      `<h1>Fingerprint PoC</h1>
       <p class="sub">SQLite + Bun. Open <a href="/demo">/demo</a> to fingerprint this browser.</p>
       <div class="cards">
         <div class="card"><div class="muted">Observations</div><div class="big">${totals.observations}</div></div>
         <div class="card"><div class="muted">Devices</div><div class="big">${totals.devices}</div></div>
         <div class="card"><div class="muted">Avg. visits / device</div>
           <div class="big">${totals.devices ? (totals.observations / totals.devices).toFixed(1) : '—'}</div></div>
       </div>
       <h2>Matches by method</h2>
       <table><tr><th>Method</th><th>Observations</th></tr>${methodRows || '<tr><td colspan="2" class="muted">none yet</td></tr>'}</table>
       <h2>Attribute diversity</h2>
       <table><tr><th>Attribute</th><th>Distinct values</th><th>Seen</th></tr>${attrRows || '<tr><td colspan="3" class="muted">none yet</td></tr>'}</table>
       <h2>Recent devices</h2>
       <table><tr><th>Visitor</th><th>First seen</th><th>Last seen</th><th>Visits</th></tr>${rows || '<tr><td colspan="4" class="muted">none yet</td></tr>'}</table>`,
    ),
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

function demo(): Response {
  return new Response(
    layout(
      'Your fingerprint',
      `<h1>Your fingerprint</h1>
       <p class="sub">This page runs the collector and posts the result to <code>/v1/observe</code>.</p>
       <p>Visitor: <code id="visitor" class="muted">collecting…</code>
          <span id="state"></span></p>
       <p class="muted">Reload the page: the same browser gets the same visitor id.
          Open it in a private window: a new device.</p>
       <table id="attrs"><tr><th>Attribute</th><th>Value</th></tr></table>
       <script src="/collect.js"></script>
       <script>
         window.addEventListener('fp:done', (event) => {
           const { payload, data } = event.detail;
           document.getElementById('visitor').textContent = data.visitor_id;
           const state = document.getElementById('state');
           state.textContent = data.is_new ? 'new device' : 'seen before (' + data.method + ', ' + data.score.toFixed(3) + ')';
           state.className = data.is_new ? 'new' : 'same';
           const table = document.getElementById('attrs');
           const order = ['ua', 'platform', 'languages', 'timezone', 'screenW', 'screenH', 'dpr',
             'cores', 'memory', 'plugins', 'webglVendor', 'webglRenderer', 'webgpu',
             'canvasHash', 'audioHash', 'fonts'];
           for (const key of order) {
             const value = payload[key];
             if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) continue;
             const row = document.createElement('tr');
             row.innerHTML = '<td>' + key + '</td><td></td>';
             row.lastElementChild.textContent = Array.isArray(value) ? value.join(', ') : String(value);
             table.append(row);
           }
         });
         window.addEventListener('fp:error', (event) => {
           document.getElementById('visitor').textContent = 'error: ' + event.detail;
         });
       </script>`,
    ),
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

type AppServer = ReturnType<typeof Bun.serve>;

async function handleObserve(req: Request, server: AppServer): Promise<Response> {
  let raw: Record<string, unknown>;
  try {
    raw = (await req.json()) as Record<string, unknown>;
  } catch (error) {
    return json({ error: 'invalid json' }, 400);
  }
  if (!raw || typeof raw !== 'object') return json({ error: 'empty body' }, 400);

  const canonical = canonicalize(raw);
  const address = server.requestIP(req)?.address ?? '';
  const observation: Observation = {
    ...canonical,
    hash: payloadHash(canonical),
    receivedAt: Date.now(),
    ipHash: sha256(`${address}:${IP_SALT}`),
  };

  const result = observe(db, observation);
  return json({
    visitor_id: result.visitorId,
    is_new: result.isNew,
    method: result.method,
    score: Number(result.score.toFixed(4)),
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/') return dashboard();
    if (url.pathname === '/demo') return demo();
    if (url.pathname === '/collect.js') {
      return new Response(Bun.file(join(import.meta.dir, 'collect.js')), {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      });
    }

    if (url.pathname === '/v1/observe' && req.method === 'POST') {
      return handleObserve(req, server);
    }

    if (url.pathname.startsWith('/v1/visitor/')) {
      const id = url.pathname.slice('/v1/visitor/'.length);
      const device = db.query('SELECT * FROM devices WHERE visitor_id = ?').get(id);
      if (!device) return json({ error: 'not found' }, 404);
      const visits = db
        .query(
          `SELECT received_at, method, score FROM links
           WHERE visitor_id = ? ORDER BY received_at DESC LIMIT 20`,
        )
        .all(id);
      return json({ device, visits });
    }

    if (url.pathname === '/v1/stats') {
      const totals = db
        .query('SELECT COUNT(*) AS observations, COUNT(DISTINCT visitor_id) AS devices FROM observations')
        .get();
      const methods = db.query('SELECT method, COUNT(*) AS n FROM links GROUP BY method').all();
      const attrs = db
        .query('SELECT attr, COUNT(*) AS distinct_values FROM attribute_stats GROUP BY attr ORDER BY distinct_values DESC')
        .all();
      return json({ totals, methods, attrs });
    }

    if (url.pathname === '/v1/feedback' && req.method === 'POST') {
      const body = (await req.json().catch(() => null)) as
        | { observation_id?: number; visitor_id?: string; action?: string }
        | null;
      if (!body || !body.visitor_id || !body.action) return json({ error: 'bad request' }, 400);
      if (body.action === 'merge' && body.observation_id) {
        db.query('UPDATE observations SET visitor_id = ? WHERE id = ?').run(body.visitor_id, body.observation_id);
        db.query(
          `UPDATE devices SET observation_count =
             (SELECT COUNT(*) FROM observations WHERE visitor_id = ?)
           WHERE visitor_id = ?`,
        ).run(body.visitor_id, body.visitor_id);
        return json({ ok: true });
      }
      return json({ error: 'unknown action' }, 400);
    }

    return json({ error: 'not found' }, 404);
  },
});

console.log(`fingerprint poc on http://localhost:${server.port}`);
console.log(`  dashboard  http://localhost:${server.port}/`);
console.log(`  demo       http://localhost:${server.port}/demo`);
console.log(`  database   ${dbPath}`);
