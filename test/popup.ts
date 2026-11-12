/*
 * The popup rolls a new identity for the tab, keeps the new values on screen,
 * and stays open while it does it.
 *
 *   bun run test/popup.ts
 */
import { check, extensionPage, launch, PROBE_URL, serve, warm } from './harness';

interface PopupState {
  seed: string;
  ua: string;
  screen: string;
  tz: string;
  langs: string;
  hw: string;
  gpu: string;
  locks: string[];
}

const readPopup = (page: import('playwright').Page): Promise<PopupState> =>
  page.evaluate(() => ({
    seed: document.getElementById('seed')!.textContent!,
    ua: document.getElementById('ua')!.textContent!,
    screen: document.getElementById('screen')!.textContent!,
    tz: document.getElementById('tz')!.textContent!,
    langs: document.getElementById('langs')!.textContent!,
    hw: document.getElementById('hw')!.textContent!,
    gpu: document.getElementById('gpu')!.textContent!,
    locks: Array.from(document.querySelectorAll<HTMLInputElement>('.lock'))
      .filter((box) => box.checked)
      .map((box) => box.dataset.field!),
  }));

serve();
const ctx = await launch();
try {
  await warm(ctx);

  const probe = await ctx.newPage();
  await probe.goto(PROBE_URL, { waitUntil: 'domcontentloaded' });
  await probe.waitForFunction(
    () => (window as unknown as { __probe?: unknown }).__probe !== undefined,
    null,
    { timeout: 20000 },
  );

  const popup = await extensionPage(ctx);
  const before = await readPopup(popup);

  await popup.click('#reseed');
  await popup.waitForFunction(
    () => !document.getElementById('reseed')!.textContent!.includes('Rolling'),
    null,
    { timeout: 10000 },
  );
  await popup.waitForTimeout(400);

  const after = await readPopup(popup);
  const live = (await probe.evaluate(() => ({
    ua: navigator.userAgent,
    seed: sessionStorage.getItem('__scrambilini_seed'),
  }))) as { ua: string; seed: string | null };

  console.log('before:', JSON.stringify(before));
  console.log('after :', JSON.stringify(after));
  console.log('page  :', JSON.stringify(live));

  const stillOpen = popup.url().endsWith('popup.html') && !popup.isClosed();
  check('popup stayed open', stillOpen);
  check('popup shows a new identity', after.seed !== before.seed);
  check('page and popup agree', live.ua === after.ua);
} finally {
  await ctx.close();
}
