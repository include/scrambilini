/*
 * The master switch: off shows the real device, on scrambles again — and
 * flipping it reloads only the tab the popup acts on, never every tab in every
 * window.
 *
 *   bun run test/toggle.ts
 */
import type { Page } from 'playwright';
import { check, extensionPage, launch, PROBE_URL, serve, warm } from './harness';

serve();
const ctx = await launch();
await warm(ctx);

function read(page: Page) {
  return page.evaluate(() => ({
    ua: navigator.userAgent,
    seed: sessionStorage.getItem('__scrambilini_seed'),
    alive: (window as unknown as { __alive?: boolean }).__alive === true,
  }));
}

function markAlive(page: Page) {
  return page.evaluate(() => {
    (window as unknown as { __alive?: boolean }).__alive = true;
  });
}

// Two tabs. The popup acts on the last one (it is opened as a tab, so it falls
// back to the last real page); the first must never be reloaded.
const left = await ctx.newPage();
await left.goto(PROBE_URL, { waitUntil: 'domcontentloaded' });
await left.waitForTimeout(800);
await markAlive(left);
const leftBefore = await read(left);

const right = await ctx.newPage();
await right.goto(PROBE_URL, { waitUntil: 'domcontentloaded' });
await right.waitForTimeout(800);
await markAlive(right);
const rightBefore = await read(right);

const popup = await extensionPage(ctx);
await popup.waitForTimeout(400);
const realUa = await popup.evaluate(() => navigator.userAgent);
const target = await popup
  .evaluate('typeof state === "undefined" ? null : state.tabId')
  .catch(() => null);

await popup.click('.switch .track');
await popup.waitForTimeout(2000);
const leftOff = await read(left);
const rightOff = await read(right);

const offState = await popup.evaluate(() => ({
  checked: (document.getElementById('enabled') as HTMLInputElement).checked,
  offNotice: !document.getElementById('offNotice')!.hidden,
}));

// Mark both again before the second flip, so a reload is visible as a lost
// marker on either tab.
await markAlive(left);
await markAlive(right);

await popup.click('.switch .track');
await popup.waitForTimeout(2000);
const leftOn = await read(left);
const rightOn = await read(right);

const onState = await popup.evaluate(() => ({
  checked: (document.getElementById('enabled') as HTMLInputElement).checked,
  offNotice: !document.getElementById('offNotice')!.hidden,
}));

console.log('target     :', target);
console.log('real ua    :', realUa);
console.log('left before:', JSON.stringify(leftBefore));
console.log('right before:', JSON.stringify(rightBefore));
console.log('left off   :', JSON.stringify(leftOff));
console.log('right off  :', JSON.stringify(rightOff));
console.log('left on    :', JSON.stringify(leftOn));
console.log('right on   :', JSON.stringify(rightOn));

check('both tabs are spoofed by default', Boolean(leftBefore.seed) && Boolean(rightBefore.seed));
check('off reloads the tab the popup acts on', rightOff.alive === false);
check('off leaves the other tab alone', leftOff.alive === true);
check('off drops the seed', rightOff.seed === null);
check('off shows the real user agent', rightOff.ua === realUa);
check(
  'the untouched tab keeps its identity',
  leftOff.seed === leftBefore.seed && leftOff.ua === leftBefore.ua,
);
check('the switch reflects the off state', offState.checked === false && offState.offNotice === true);

check('on reloads the tab the popup acts on', rightOn.alive === false);
check('on leaves the other tab alone', leftOn.alive === true);
check('on scrambles again', Boolean(rightOn.seed));
check('the identity survives the toggle', rightOn.seed === rightBefore.seed);
check('the untouched tab is still untouched', leftOn.alive === true && leftOn.seed === leftBefore.seed);
check('the switch reflects the on state', onState.checked === true && onState.offNotice === false);

await ctx.close();
