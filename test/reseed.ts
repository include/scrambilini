/*
 * A tab keeps its identity across reloads; a reseed gives it a new one in
 * place, and the new identity survives a reload.
 *
 *   bun run test/reseed.ts
 */
import { check, extensionPage, launch, PROBE_URL, serve, warm, type Probe } from './harness';

interface Snapshot {
  seed: string;
  ua: string;
  langs: string[];
  screen: [number, number];
  cores: number;
}

async function snapshot(page: import('playwright').Page): Promise<Snapshot> {
  await page.waitForFunction(
    () => (window as unknown as { __probe?: unknown }).__probe !== undefined,
    null,
    { timeout: 20000 },
  );
  const probe = (await page.evaluate(
    () => (window as unknown as { __probe: Probe }).__probe,
  )) as Probe;
  // The settled identity: the values read a few milliseconds after the
  // document starts can still be the provisional ones.
  return {
    seed: probe.finalSeed || probe.seed,
    ua: probe.finalUa || probe.ua,
    langs: probe.languages,
    screen: [probe.screen.w, probe.screen.h],
    cores: probe.hardwareConcurrency,
  };
}

interface Live {
  seed: string | null;
  ua: string;
  platform: string;
  uadPlatform: string | null;
}

function coherent(values: Live): boolean {
  if (values.ua.includes('Macintosh')) return values.platform === 'MacIntel' && values.uadPlatform === 'macOS';
  if (values.ua.includes('Windows NT')) return values.platform === 'Win32' && values.uadPlatform === 'Windows';
  if (values.ua.includes('Linux')) return values.platform === 'Linux x86_64' && values.uadPlatform === 'Linux';
  return false;
}

serve();
const ctx = await launch();
try {
  await warm(ctx);

  const page = await ctx.newPage();
  await page.goto(PROBE_URL, { waitUntil: 'domcontentloaded' });
  const first = await snapshot(page);

  await page.reload({ waitUntil: 'domcontentloaded' });
  const second = await snapshot(page);

  const admin = await extensionPage(ctx);
  const tabId = await admin.evaluate(async () => {
    const chrome = (globalThis as unknown as { chrome: any }).chrome;
    const tabs: Array<{ id?: number; url?: string }> = await chrome.tabs.query({});
    return tabs.find((t) => t.url && t.url.includes('probe.html'))?.id;
  });
  await admin.evaluate(async (id) => {
    const chrome = (globalThis as unknown as { chrome: any }).chrome;
    return chrome.runtime.sendMessage({ type: 'reseed', tabId: id });
  }, tabId);

  // No reload: the page swaps its identity in place.
  await page.waitForTimeout(800);
  const swapped = (await page.evaluate(() => ({
    seed: sessionStorage.getItem('__scrambilini_seed'),
    ua: navigator.userAgent,
    platform: navigator.platform,
    uadPlatform: (navigator as unknown as { userAgentData?: { platform: string } }).userAgentData
      ?.platform ?? null,
  }))) as Live;

  await page.reload({ waitUntil: 'domcontentloaded' });
  const third = await snapshot(page);

  console.log('first   :', JSON.stringify(first));
  console.log('reload  :', JSON.stringify(second));
  console.log('reseeded:', JSON.stringify(third));
  console.log('live    :', JSON.stringify(swapped));

  check('reload keeps the identity', JSON.stringify(first) === JSON.stringify(second));
  check(
    'reseed changes the identity in place',
    swapped.seed !== first.seed && swapped.ua !== first.ua,
  );
  check(
    'the new identity survives a reload',
    third.seed === swapped.seed && third.ua === swapped.ua,
  );
  check('platform coherent with the UA', coherent(swapped));
} finally {
  await ctx.close();
}
