/*
 * The master switch: off shows the real device, on scrambles again.
 *
 *   bun run test/toggle.ts
 */
import { check, extensionPage, launch, PROBE_URL, serve, warm } from './harness';

serve();
const ctx = await launch();
await warm(ctx);

const read = () =>
  page.evaluate(() => ({
    ua: navigator.userAgent,
    seed: sessionStorage.getItem('__scrambilini_seed'),
  }));

const page = await ctx.newPage();
await page.goto(PROBE_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
const before = await read();

const popup = await extensionPage(ctx);
await popup.waitForTimeout(400);
const realUa = await popup.evaluate(() => navigator.userAgent);

await popup.click('.switch .track');
await page.waitForTimeout(1500);
const off = await read();

await popup.click('.switch .track');
await page.waitForTimeout(1500);
const on = await read();

const state = await popup.evaluate(() => ({
  checked: (document.getElementById('enabled') as HTMLInputElement).checked,
  offNotice: !document.getElementById('offNotice')!.hidden,
}));

console.log('before :', JSON.stringify(before));
console.log('real   :', realUa);
console.log('off    :', JSON.stringify(off));
console.log('on     :', JSON.stringify(on));
console.log('popup  :', JSON.stringify(state));

check('the tab is spoofed by default', Boolean(before.seed));
check('off drops the seed', off.seed === null);
check('off shows the real user agent', off.ua === realUa);
check('on scrambles again', Boolean(on.seed));
check('the identity survives the toggle', on.seed === before.seed);
check('the switch reflects the state', state.checked === true && state.offNotice === false);

await ctx.close();
