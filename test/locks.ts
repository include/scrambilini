/*
 * Per-field locks: tick a row, scramble, and the locked value stays — across a
 * scramble and across a reload.
 *
 *   bun run test/locks.ts
 */
import { check, extensionPage, launch, PROBE_URL, serve, warm } from './harness';

interface PopupState {
  seed: string;
  ua: string;
  screen: string;
  langs: string;
  tz: string;
  hw: string;
  gpu: string;
  locks: string[];
}

interface PageState {
  seed: string | null;
  ua: string;
  langs: string;
  screen: string;
}

const readPopup = (page: import('playwright').Page): Promise<PopupState> =>
  page.evaluate(() => ({
    seed: document.getElementById('seed')!.textContent!,
    ua: document.getElementById('ua')!.textContent!,
    screen: document.getElementById('screen')!.textContent!,
    langs: document.getElementById('langs')!.textContent!,
    tz: document.getElementById('tz')!.textContent!,
    hw: document.getElementById('hw')!.textContent!,
    gpu: document.getElementById('gpu')!.textContent!,
    locks: Array.from(document.querySelectorAll<HTMLInputElement>('.lock'))
      .filter((box) => box.checked)
      .map((box) => box.dataset.field!),
  }));

const readPage = (page: import('playwright').Page): Promise<PageState> =>
  page.evaluate(() => ({
    seed: sessionStorage.getItem('__scrambilini_seed'),
    ua: navigator.userAgent,
    langs: Array.from(navigator.languages).join(', '),
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
  }));

async function scramble(popup: import('playwright').Page): Promise<void> {
  await popup.click('#reseed');
  await popup.waitForFunction(
    () => !document.getElementById('reseed')!.textContent!.includes('Rolling'),
    null,
    { timeout: 10000 },
  );
  await popup.waitForTimeout(300);
}

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

  const popup = await extensionPage(ctx);
  const start = await readPopup(popup);

  // Lock languages and scramble.
  await popup.click('.lock[data-field="languages"]');
  await popup.waitForTimeout(300);
  const locked = await readPopup(popup);
  await scramble(popup);
  const afterLangs = await readPopup(popup);

  // Lock the screen too, then scramble again.
  await popup.click('.lock[data-field="screen"]');
  await popup.waitForTimeout(300);
  await scramble(popup);
  const afterScreen = await readPopup(popup);
  const live = await readPage(page);

  // The locked values must survive a reload too.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const afterReload = await readPage(page);

  // Unlock everything.
  await popup.click('.lock[data-field="languages"]');
  await popup.waitForTimeout(200);
  await popup.click('.lock[data-field="screen"]');
  await popup.waitForTimeout(300);
  const unlocked = await readPopup(popup);
  const liveUnlocked = await readPage(page);

  console.log('start       :', JSON.stringify(start));
  console.log('locked      :', JSON.stringify(locked));
  console.log('after langs :', JSON.stringify(afterLangs));
  console.log('after screen:', JSON.stringify(afterScreen));
  console.log('page        :', JSON.stringify(live));

  check('lock tick shows up', locked.locks.includes('languages'));
  check('scramble keeps the locked languages', afterLangs.langs === start.langs);
  check('scramble still changes the seed', afterLangs.seed !== start.seed);
  check(
    'second lock keeps both languages and screen',
    afterScreen.langs === afterLangs.langs && afterScreen.screen === afterLangs.screen,
  );
  check(
    'page agrees with the popup',
    live.langs === afterScreen.langs && live.screen === afterScreen.screen,
  );
  check('locks survive a reload', JSON.stringify(afterReload) === JSON.stringify(live));
  check('unlock clears every lock', unlocked.locks.length === 0);
  check(
    'page agrees after unlocking',
    liveUnlocked.langs === unlocked.langs && liveUnlocked.screen === unlocked.screen,
  );
} finally {
  await ctx.close();
}
