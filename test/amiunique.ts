/*
 * Open amiunique.org/fingerprint in several tabs and compare what it sees.
 *
 * Each tab should look like a different, internally coherent device: the HTTP
 * header values and the JavaScript values must agree, and no two tabs may share
 * an identity.
 *
 *   bun run test/amiunique.ts [tabs]
 */
import type { Page } from 'playwright';
import { check, launch, serve, warm } from './harness';

const URL = 'https://amiunique.org/fingerprint';

const FIELDS = [
  'User agent',
  'Content language',
  'Hardware concurrency',
  'Device memory',
  'Screen width',
  'Screen height',
  'WebGL Vendor',
  'WebGL Renderer',
];

const ROW = /^\d+ - (.+?)\s*$/;

interface Scrape {
  headers: Record<string, string | null>;
  js: Record<string, string | null>;
}

function valueAfter(lines: string[], name: string): string | null {
  for (let i = 0; i < lines.length; i++) {
    const match = ROW.exec(lines[i].trim());
    if (!match || match[1] !== name) continue;
    let value = '';
    for (const follow of lines.slice(i + 1, i + 6)) {
      const stripped = follow.trim();
      if (!stripped) continue;
      if (ROW.test(stripped)) break;
      value = stripped;
    }
    return value;
  }
  return null;
}

function languages(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.split(';')[0].trim())
    .filter(Boolean);
}

async function scrape(page: Page): Promise<Scrape> {
  await page.waitForFunction(
    () => document.body.innerText.includes('JAVASCRIPT ATTRIBUTES'),
    null,
    { timeout: 45000 },
  );
  await page.waitForTimeout(4000);
  const text = await page.innerText('body');
  const at = text.indexOf('JAVASCRIPT ATTRIBUTES');
  const headLines = text.slice(0, at).split('\n');
  const jsLines = text.slice(at + 'JAVASCRIPT ATTRIBUTES'.length).split('\n');
  return {
    headers: Object.fromEntries(FIELDS.map((field) => [field, valueAfter(headLines, field)])),
    js: Object.fromEntries(FIELDS.map((field) => [field, valueAfter(jsLines, field)])),
  };
}

const tabs = Number(process.argv[2] ?? 2);
serve();
const ctx = await launch();
try {
  await warm(ctx);

  const results: Scrape[] = [];
  for (let i = 0; i < tabs; i++) {
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    results.push(await scrape(page));
    await page.close();
  }

  const identities: string[] = [];
  results.forEach((result, index) => {
    const { headers, js } = result;
    identities.push(
      JSON.stringify([
        js['User agent'],
        languages(js['Content language']),
        js['Hardware concurrency'],
        js['Device memory'],
        js['Screen width'],
        js['Screen height'],
        js['WebGL Renderer'],
      ]),
    );
    console.log(`--- tab ${index + 1} ---`);
    console.log('  ua      :', String(js['User agent']).split(') ').at(-1));
    console.log('  headers :', String(headers['User agent']).split(') ').at(-1));
    console.log('  language:', languages(js['Content language']));
    console.log('  accept  :', languages(headers['Content language']));
    console.log('  cores/mem:', js['Hardware concurrency'], '/', js['Device memory']);
    console.log('  screen  :', js['Screen width'], 'x', js['Screen height']);
    console.log('  renderer:', js['WebGL Renderer']);
  });

  const distinct = new Set(identities).size;
  console.log('');
  console.log('distinct identities:', distinct, 'of', identities.length);

  let coherent = true;
  results.forEach((result, index) => {
    const uaOk = result.js['User agent'] === result.headers['User agent'];
    const langOk =
      JSON.stringify(languages(result.js['Content language'])) ===
      JSON.stringify(languages(result.headers['Content language']));
    if (!uaOk || !langOk) coherent = false;
    console.log(`tab ${index + 1}: header/js coherent ua=${uaOk} language=${langOk}`);
  });

  check('every tab has a distinct identity', distinct === identities.length);
  check('headers are coherent with the page in every tab', coherent);
} finally {
  await ctx.close();
}
