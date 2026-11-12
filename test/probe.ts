/*
 * Load the extension in a real Chromium and print what the page sees.
 *
 *   bun run test/probe.ts [url ...]
 *
 * Each URL runs in its own tab, so per-tab seeds can be compared.
 */
import { launch, PROBE_URL, serve, warm, type Probe } from './harness';

const urls = process.argv.slice(2);
const targets = urls.length ? urls : [PROBE_URL];

serve();
const ctx = await launch();
try {
  await warm(ctx);

  const results: unknown[] = [];
  for (const url of targets) {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (url.includes('/probe.html')) {
      await page.waitForFunction(
        () => (window as unknown as { __probe?: unknown }).__probe !== undefined,
        null,
        { timeout: 20000 },
      );
      results.push(await page.evaluate(() => (window as unknown as { __probe: Probe }).__probe));
    } else {
      await page.waitForTimeout(6000);
      results.push({ url, text: (await page.innerText('body')).slice(0, 6000) });
    }
    await page.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await ctx.close();
}
