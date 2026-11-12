/*
 * Deep dive: compare the seed the page adopted, the seed stored by the worker,
 * and the headers installed in the session rule.
 *
 *   bun run test/debug.ts
 */
import { extensionId, extensionPage, launch, PROBE_URL, serve, warm, type Probe } from './harness';

serve();
const ctx = await launch();
try {
  await warm(ctx);

  const page = await ctx.newPage();
  await page.goto(PROBE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => (window as unknown as { __probe?: unknown }).__probe !== undefined,
    null,
    { timeout: 20000 },
  );
  const probe = (await page.evaluate(
    () => (window as unknown as { __probe: Probe }).__probe,
  )) as Probe;

  const admin = await extensionPage(ctx);
  const rules = await admin.evaluate(() => {
    const chrome = (globalThis as unknown as { chrome: any }).chrome;
    return chrome.declarativeNetRequest.getSessionRules();
  });
  const stored = await admin.evaluate(() => {
    const chrome = (globalThis as unknown as { chrome: any }).chrome;
    return chrome.storage.session.get(null);
  });
  const tabs = await admin.evaluate(() => {
    const chrome = (globalThis as unknown as { chrome: any }).chrome;
    return chrome.tabs.query({});
  });

  console.log('extension id:', extensionId());
  console.log('page seed   :', probe.seed);
  console.log('page ua     :', probe.ua);
  console.log('nav ua      :', probe.navHeaders?.['user-agent']);
  console.log('nav lang    :', probe.navHeaders?.['accept-language']);
  console.log('js lang     :', probe.languages);
  console.log('stored      :', JSON.stringify(stored, null, 2));
  console.log('rules       :', JSON.stringify(rules, null, 2));
  console.log(
    'tabs        :',
    JSON.stringify(
      (tabs as Array<{ id?: number; url?: string }>).map((tab) => ({ id: tab.id, url: tab.url })),
      null,
      2,
    ),
  );
} finally {
  await ctx.close();
}
