/*
 * Do navigation requests carry the spoofed headers, at various delays after the
 * tab is created? And does the identity the page settles on match them?
 *
 *   bun run test/navtiming.ts
 */
import { check, extensionPage, launch, PROBE_URL, serve, type Probe } from './harness';

serve();

interface Result {
  delay: number;
  headersMatchSettled: boolean;
  headersReal: boolean;
  raced: boolean;
  seedMatchesWorker: boolean;
}

async function run(delay: number): Promise<Result> {
  const ctx = await launch();
  try {
    const warm = await ctx.newPage();
    await warm.goto('about:blank');
    await warm.waitForTimeout(600);
    await warm.close();

    const admin = await extensionPage(ctx);

    const page = await ctx.newPage();
    if (delay) await page.waitForTimeout(delay);
    await page.goto(PROBE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => (window as unknown as { __probe?: unknown }).__probe !== undefined,
      null,
      { timeout: 20000 },
    );
    const probe = (await page.evaluate(
      () => (window as unknown as { __probe: Probe }).__probe,
    )) as Probe;

    const tabId = await admin.evaluate(async () => {
      const chrome = (globalThis as unknown as { chrome: any }).chrome;
      const tabs: Array<{ id?: number; url?: string }> = await chrome.tabs.query({});
      return tabs.find((t) => t.url && t.url.includes('probe.html'))?.id;
    });
    const sw = (await admin.evaluate(async (id) => {
      const chrome = (globalThis as unknown as { chrome: any }).chrome;
      return chrome.runtime.sendMessage({ type: 'getProfile', tabId: id });
    }, tabId)) as { payload?: { seed?: string; ua?: string } } | null;

    // The extension page is not affected by the content scripts, so its
    // navigator.userAgent is the browser's real one.
    const realUa = (await admin.evaluate(() => navigator.userAgent)) as string;
    const navUa = probe.navHeaders?.['user-agent'];
    const result: Result = {
      delay,
      headersMatchSettled: navUa === probe.finalUa,
      headersReal: navUa === realUa,
      raced: navUa !== probe.ua,
      seedMatchesWorker: probe.finalSeed === sw?.payload?.seed,
    };

    console.log(
      `delay ${String(delay).padStart(3)}ms  headers==settled: ${result.headersMatchSettled}  ` +
        `real: ${result.headersReal}  load-time read raced: ${result.raced}  ` +
        `seed ok: ${result.seedMatchesWorker}`,
    );
    return result;
  } finally {
    await ctx.close();
  }
}

for (const delay of [0, 100, 300, 800]) {
  const result = await run(delay);
  if (delay === 0) {
    // Documented race: a navigation started right after tab creation can beat
    // the header rule. It must then still be the real UA, never a third one.
    check(
      'delay 0ms: headers are spoofed, or still the real UA',
      result.headersMatchSettled || result.headersReal,
    );
  } else {
    check(`delay ${delay}ms: headers match the settled identity`, result.headersMatchSettled);
  }
  check(`delay ${delay}ms: page and worker share the seed`, result.seedMatchesWorker);
}
