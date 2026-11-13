/*
 * Sanity checks for both extensions.
 *
 *   bun run tools/check.ts     (or: make check)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const problems: string[] = [];

function problem(message: string): void {
  problems.push(message);
  console.error('error:', message);
}

const manifests: Record<string, any> = {};
for (const browser of ['chrome', 'firefox']) {
  const path = join(ROOT, browser, 'manifest.json');
  try {
    manifests[browser] = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    problem(`${browser}/manifest.json is not valid JSON: ${(error as Error).message}`);
  }
}

const version = manifests.chrome?.version ?? '';
if (!version) problem('chrome/manifest.json has no version');
if (manifests.firefox && manifests.firefox.version !== version) {
  problem(`version mismatch: chrome ${version}, firefox ${manifests.firefox.version}`);
}

// The Chrome build must not lose its service worker, the Firefox one must not
// lose its event page.
if (!manifests.chrome?.background?.service_worker) problem('chrome manifest has no service_worker');
if (!Array.isArray(manifests.firefox?.background?.scripts)) {
  problem('firefox manifest has no background.scripts');
}
if (!manifests.firefox?.browser_specific_settings?.gecko?.id) {
  problem('firefox manifest has no gecko id');
}

// The generated folders have to match shared/ (run make sync).
function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path, base) : [relative(base, path)];
  });
}

const sharedFiles = walk(join(ROOT, 'shared', 'src')).filter((f) => !f.endsWith('browser.js'));
for (const browser of ['chrome', 'firefox']) {
  for (const file of sharedFiles) {
    const a = readFileSync(join(ROOT, 'shared', 'src', file), 'utf8');
    let b = '';
    try {
      b = readFileSync(join(ROOT, browser, 'src', file), 'utf8');
    } catch {
      problem(`${browser}/src/${file} is missing (run make sync)`);
      continue;
    }
    if (a !== b) problem(`${browser}/src/${file} is out of sync with shared/src (run make sync)`);
  }
}

const JS_FILES = ['background.js', 'content/bridge.js', 'content/scramble.js', 'shared/profile.js', 'popup.js'];
for (const file of JS_FILES) {
  try {
    new Function(readFileSync(join(ROOT, 'shared', 'src', file), 'utf8'));
  } catch (error) {
    problem(`shared/src/${file}: ${(error as Error).message}`);
  }
}

// The profile builder has to be deterministic, keep locks isolated, and stay
// coherent with the browser it is built for.
const profileSource = readFileSync(join(ROOT, 'shared', 'src', 'shared', 'profile.js'), 'utf8');

function loadBuilder(browser: 'chrome' | 'firefox') {
  const module = { exports: {} as any };
  const factory = new Function('module', 'exports', '__scrambiliniBrowser', profileSource);
  factory(module, module.exports, browser);
  return module.exports as (
    seed: string,
    ua: string,
    locks?: Record<string, unknown>,
  ) => Record<string, any>;
}

const UA = {
  chrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0',
};

for (const browser of ['chrome', 'firefox'] as const) {
  const build = loadBuilder(browser);
  const ua = UA[browser];
  const seed = '00112233445566778899aabbccddeeff';

  const a = build(seed, ua);
  if (JSON.stringify(a) !== JSON.stringify(build(seed, ua))) {
    problem(`${browser}: profile builder is not deterministic`);
  }

  if (browser === 'chrome') {
    if (!a.ua.includes('Chrome/')) problem('chrome build produced a non-Chrome UA');
    if (!a.caps.userAgentData) problem('chrome build lost userAgentData');
  } else {
    if (!a.ua.includes('Firefox/') || a.ua.includes('Chrome/')) {
      problem(`firefox build produced a non-Firefox UA: ${a.ua}`);
    }
    if (a.caps.userAgentData) problem('firefox build must not claim userAgentData');
    if (a.caps.deviceMemory) problem('firefox build must not claim deviceMemory');
    if (a.productSub !== '20100101') problem('firefox build has the wrong productSub');
    if (!a.oscpu || !a.buildID) problem('firefox build is missing oscpu/buildID');
    if (a.vendor !== '') problem('firefox build has a vendor');
  }

  const c = build(seed, ua, { languages: a.languages });
  if (JSON.stringify(c.languages) !== JSON.stringify(a.languages)) {
    problem(`${browser}: locked languages were not kept`);
  }
  if (JSON.stringify(c.ua) !== JSON.stringify(a.ua)) {
    problem(`${browser}: locking one field disturbed the rest of the identity`);
  }

  const LAYOUTS = new Set(['us', 'gb', 'fr', 'de', 'br', 'jp', 'kr', 'se']);
  for (let i = 0; i < 250; i++) {
    const p = build(i.toString(16).padStart(32, '0'), ua);
    if (p.locale !== p.languages[0]) problem(`${browser} ${i}: locale != languages[0]`);
    if (!LAYOUTS.has(p.keyboard)) problem(`${browser} ${i}: unknown keyboard ${p.keyboard}`);
    if (!Array.isArray(p.voices) || !p.voices.length) problem(`${browser} ${i}: no speech voices`);
    if (p.voices.filter((voice: { default: boolean }) => voice.default).length !== 1) {
      problem(`${browser} ${i}: expected exactly one default voice`);
    }
    if (!p.webgpu || !p.webgpu.architecture) problem(`${browser} ${i}: empty WebGPU adapter info`);
    if (p.system === 'macos' && p.webgpu.vendor !== 'apple') {
      problem(`${browser} ${i}: macOS identity has WebGPU vendor ${p.webgpu.vendor}`);
    }
    if (p.system !== 'macos' && !['nvidia', 'intel', 'amd', 'mesa'].includes(p.webgpu.vendor)) {
      problem(`${browser} ${i}: ${p.system} identity has WebGPU vendor ${p.webgpu.vendor}`);
    }
  }
}

if (problems.length) process.exit(1);
console.log(`check: chrome + firefox sources are fine (version ${version})`);
