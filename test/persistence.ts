/*
 * "Lock for all tabs": pins shared by every tab, kept across a browser restart,
 * and still overridable per tab.
 *
 *   bun run test/persistence.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import {
  check,
  extensionPage,
  launch,
  PROBE_URL,
  probeTab,
  serve,
  warm,
  type Probe,
} from './harness';

const popupState = (page: Page) =>
  page.evaluate(() => ({
    langs: document.getElementById('langs')!.textContent!,
    ua: document.getElementById('ua')!.textContent!,
    allTabs: (document.getElementById('allTabs') as HTMLInputElement).checked,
    locks: Array.from(document.querySelectorAll<HTMLInputElement>('.lock'))
      .filter((box) => box.checked)
      .map((box) => box.dataset.field!),
  }));

const probeLanguages = async (ctx: BrowserContext) => {
  const probe = await probeTab(ctx);
  return { langs: probe.finalLanguages, ua: probe.finalUa };
};

const openProbe = async (ctx: BrowserContext): Promise<{ page: Page; probe: Probe }> => {
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
  return { page, probe };
};

serve();
const profileDir = mkdtempSync(join(tmpdir(), 'scrambilini-persist-'));

// --- first session -----------------------------------------------------------
let ctx = await launch(profileDir);
await warm(ctx);

const first = await probeLanguages(ctx);
const popup = await extensionPage(ctx);
await popup.click('.lock[data-field="languages"]');
await popup.waitForTimeout(250);
await popup.click('#allTabs');
await popup.waitForTimeout(400);
const shared = await popupState(popup);
const second = await probeLanguages(ctx);
await ctx.close();

// --- second session, same profile -------------------------------------------
ctx = await launch(profileDir);
await warm(ctx);

const { page: probePage, probe } = await openProbe(ctx);
const third = { langs: probe.finalLanguages, ua: probe.finalUa };

const popup2 = await extensionPage(ctx);
await popup2.waitForTimeout(400);
const restored = await popupState(popup2);

const tabId = await popup2.evaluate(async () => {
  const chrome = (globalThis as unknown as { chrome: any }).chrome;
  const tabs: Array<{ id?: number; url?: string }> = await chrome.tabs.query({});
  return tabs.find((tab) => tab.url && tab.url.includes('probe.html'))?.id;
});
const profile = (await popup2.evaluate(async (id) => {
  const chrome = (globalThis as unknown as { chrome: any }).chrome;
  return chrome.runtime.sendMessage({ type: 'getProfile', tabId: id });
}, tabId)) as { locks?: Record<string, unknown> } | null;

// A tab can still opt out of the shared lock for itself.
await popup2.click('#allTabs');
await popup2.waitForTimeout(300);
await popup2.click('.lock[data-field="languages"]');
await popup2.waitForTimeout(500);
const unlocked = await popupState(popup2);
const afterUnlock = await probePage.evaluate(() => Array.from(navigator.languages));
const other = await probeLanguages(ctx);
await ctx.close();

console.log('first tab    :', JSON.stringify(first));
console.log('shared       :', JSON.stringify(shared));
console.log('new tab      :', JSON.stringify(second));
console.log('after restart:', JSON.stringify(third));
console.log('restored     :', JSON.stringify(restored));

check('the lock is shared with new tabs', second.langs.join(', ') === shared.langs);
check('the new tab still has its own identity', second.ua !== first.ua);
check('the lock survives a browser restart', third.langs.join(', ') === shared.langs);
check('the toggle is restored', restored.allTabs === true);
check('the shared lock is visible after restart', restored.locks.includes('languages'));
check('the worker reports the lock for the tab', Boolean(profile && profile.locks && profile.locks.languages));
check('unlocking here clears the tick', unlocked.locks.length === 0);
check('the popup and page agree after unlocking', afterUnlock.join(', ') === unlocked.langs);
check('another tab still gets the shared lock', other.langs.join(', ') === shared.langs);
