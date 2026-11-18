# Fingerprint SaaS — proof of concept

A minimal fingerprint-collection service: it collects a browser fingerprint,
stores it, and tells whether it has seen that browser before.

Everything is **Bun + TypeScript**. No `npm install`, no dependencies:

| Need | Bun built-in |
| --- | --- |
| HTTP server | `Bun.serve()` |
| Database | `bun:sqlite` (SQLite compiled into Bun) |
| Hashing | `Bun.CryptoHasher` (SHA-256) |
| File server | `Bun.file()` |
| Config | `Bun.env` |
| Tests | `bun test` |

## Run it

```bash
cd saas
bun run src/server.ts
```

Then open:

- <http://localhost:8787/> — dashboard: observations, devices, matches by
  method, attribute diversity.
- <http://localhost:8787/demo> — the page fingerprints **this** browser and
  posts the result. Reload it: same visitor id, "seen before". Open it in a
  private window: a new device.

The database is `saas/data/fp.db` (ignored by git). Delete the folder to start
over.

## Simulation

```bash
bun run src/simulate.ts
```

It builds 400 devices, gives each 10 visits over 10 days, and mutates them the
way real browsers change (updates, new fonts, a new monitor, travel). Then it
measures how well the matcher puts the visits back together.

Current output:

```
devices 400, visits 10 each, over 10 days
observations       4000
exact matches      3152
similarity matches 434
new devices        414

link recall        98.7%  (3553/3600 revisits linked)
observation purity 100.0%
false merges       0 clusters, 0 observations (0.0%)
fragmented devices 14 of 400 (3.5%)
```

With 2,000 devices it holds up, but the candidate cap starts to matter:

```
$ DEVICES=2000 bun run src/simulate.ts
link recall        98.5%
false merges       0
fragmented devices 4.7%
```

With `MAX_CANDIDATES=500` the same run drops to 92.6% recall and 19.8%
fragmented devices: the correct device was sometimes outside the candidate list.
That is the scaling limit described in the report, and the reason the next step
is an approximate index instead of a bigger threshold.

Tune it with `DEVICES` and `VISITS`:

```bash
DEVICES=2000 VISITS=20 bun run src/simulate.ts
```

## Tests

```bash
bun test
```

Covers normalization, the payload hash, and the similarity scoring: browser
updates, a new font, a different canvas, a different platform.

## API

```bash
# one visit
curl -s -X POST http://localhost:8787/v1/observe \
  -H 'content-type: application/json' \
  -d '{"ua":"Mozilla/5.0 … Chrome/140.0.0.0 Safari/537.36","platform":"MacIntel",
       "languages":["en-US","en"],"timezone":"Europe/Lisbon",
       "screenW":1512,"screenH":982,"dpr":2,"cores":10,"memory":16,
       "plugins":5,"webglRenderer":"ANGLE (Apple, … Apple M2)",
       "canvasHash":"…","audioHash":"…","fonts":["Arial","Menlo"]}'

# { "visitor_id": "v_…", "is_new": true, "method": "new", "score": 1 }

curl -s http://localhost:8787/v1/stats
curl -s http://localhost:8787/v1/visitor/v_…
```

## What is implemented

- `src/db.ts` — schema: `observations`, `devices`, `attribute_stats`, `links`.
- `src/normalize.ts` — canonical attribute names, version parsing, bucketed
  screens, SHA-256 payload hash, the weight table.
- `src/match.ts` — exact match, candidate blocking by platform and recency,
  weighted similarity, thresholds (`0.85` same, `0.6` ambiguous).
- `src/server.ts` — the HTTP API, the dashboard and the demo page.
- `src/collect.js` — the customer script: canvas, WebGL, audio, fonts,
  timezone, screen, hardware, WebGPU.
- `src/simulate.ts` — synthetic devices with realistic evolution, and the
  evaluation.

## What is not implemented (yet)

These are the parts that make it a product rather than a demo:

- a durable queue between collection and matching;
- an edge collector for TLS (JA4), HTTP/2 settings, header order and IP;
- LSH or another approximate index for very large candidate sets;
- learned weights (the current ones are hand-written);
- retention jobs, rate limits, authentication, multi-tenancy;
- the legal layer: consent, DPIA, retention policy, opt-out.
