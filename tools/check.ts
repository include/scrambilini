/*
 * Sanity checks for the extension sources.
 *
 *   bun run tools/check.ts     (or: make check)
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const problems: string[] = [];

function problem(message: string): void {
  problems.push(message);
  console.error('error:', message);
}

let version = '';
try {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as {
    name?: string;
    version?: string;
  };
  version = manifest.version ?? '';
  if (!version) problem('manifest.json has no version');
} catch (error) {
  problem(`manifest.json is not valid JSON: ${(error as Error).message}`);
  process.exit(1);
}

const JS_FILES = [
  'src/background.js',
  'src/content/bridge.js',
  'src/content/scramble.js',
  'src/shared/profile.js',
  'src/popup.js',
];

for (const file of JS_FILES) {
  try {
    // Parses the source without running it.
    new Function(readFileSync(join(ROOT, file), 'utf8'));
  } catch (error) {
    problem(`${file}: ${(error as Error).message}`);
  }
}

// The profile builder has to stay deterministic, and a lock must only pin the
// field it was set on.
const require = createRequire(import.meta.url);
const build = require(join(ROOT, 'src/shared/profile.js')) as (
  seed: string,
  ua: string,
  locks?: Record<string, unknown>,
) => Record<string, any>;

const ua =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const seed = '00112233445566778899aabbccddeeff';

const a = build(seed, ua);
const b = build(seed, ua);
if (JSON.stringify(a) !== JSON.stringify(b)) problem('profile builder is not deterministic');

const c = build(seed, ua, { languages: a.languages });
if (JSON.stringify(c.languages) !== JSON.stringify(a.languages)) {
  problem('locked languages were not kept');
}
if (JSON.stringify(c.ua) !== JSON.stringify(a.ua)) {
  problem('locking one field disturbed the rest of the identity');
}

if (problems.length) process.exit(1);
console.log(`check: sources are fine (version ${version})`);
