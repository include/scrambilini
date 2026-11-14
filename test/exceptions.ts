/*
 * Exceptions: a listed site keeps its real identity and is never patched.
 *
 *   bun run test/exceptions.ts
 */
import { check, extensionPage, launch, PROBE_URL, serve, warm } from './harness';

const entries = (page: import('playwright').Page) =>
  page.$$eval('#exceptionList .domain', (nodes) => nodes.map((node) => node.textContent || ''));

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

await popup.click('#openExceptions');
await popup.fill('#entry', '127.0.0.1');
await popup.press('#entry', 'Enter');
// The list has to update immediately, without waiting for the worker.
await popup.waitForTimeout(250);
const listedQuick = await entries(popup);
await page.waitForTimeout(1500);

const excepted = await read();
const listed = await entries(popup);
const popupState = await popup.evaluate(() => ({
  excepted: document.body.classList.contains('excepted'),
  count: document.getElementById('exCount')!.textContent,
}));

await popup.click('#exceptionList .remove');
await popup.waitForTimeout(250);
const afterRemovalQuick = await entries(popup);
await page.waitForTimeout(1500);
const restored = await read();
const afterRemoval = await entries(popup);

console.log('before  :', JSON.stringify(before));
console.log('real    :', realUa);
console.log('excepted:', JSON.stringify(excepted));
console.log('listed  :', JSON.stringify(listed));
console.log('popup   :', JSON.stringify(popupState));
console.log('restored:', JSON.stringify(restored));

check('the tab is spoofed before the exception', Boolean(before.seed));
check('an excepted site uses the real user agent', excepted.ua === realUa);
check('an excepted site gets no seed', excepted.seed === null);
check('the exception is listed', listed.includes('127.0.0.1'));
check('the list updates as soon as you add', listedQuick.includes('127.0.0.1'));
check('the list updates as soon as you remove', !afterRemovalQuick.includes('127.0.0.1'));
check('the popup shows the excepted state', popupState.excepted === true && popupState.count === '1');
check('removing it scrambles the tab again', Boolean(restored.seed));
check('the identity survives the exception', restored.seed === before.seed);
check('the list is empty again', !afterRemoval.includes('127.0.0.1'));

await ctx.close();
