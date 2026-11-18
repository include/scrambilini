/*
 * What the network actually sees: does the extension change the order of the
 * request headers?
 *
 *   bun run test/header-order.ts
 *
 * `declarativeNetRequest` can set, append and remove headers, but not move one,
 * so the order the browser builds is the order the server gets. This test pins
 * that: it captures the raw request of the same page with and without the
 * extension, and compares the two lists.
 */
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, EXT } from './harness';

type Header = [string, string];
const captured = new Map<string, Header[]>();

// A raw socket, not Bun.serve: `Headers` iteration is alphabetical, so it
// cannot show the order the headers had on the wire.
const server = Bun.listen({
  hostname: '127.0.0.1',
  port: 0,
  socket: {
    data(socket, data) {
      const text = data.toString();
      if (text.startsWith('GET ')) {
        const lines = text.split('\r\n').filter((line) => line.length > 0);
        const path = lines[0].split(' ')[1];
        const run = new URL(path, 'http://localhost').searchParams.get('run') ?? '';
        if (run && !captured.has(run)) {
          const headers: Header[] = [];
          for (const line of lines.slice(1)) {
            const colon = line.indexOf(':');
            if (colon > 0) headers.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
          }
          captured.set(run, headers);
        }
      }
      socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok');
    },
  },
});

async function capture(run: string, withExtension: boolean): Promise<Header[]> {
  const args = ['--no-first-run', '--no-default-browser-check'];
  if (withExtension) {
    args.unshift(`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`);
  }
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'order-')), {
    headless: false,
    args,
  });
  try {
    const page = await ctx.newPage();
    // The per-tab header rule is installed in tabs.onCreated, a few
    // milliseconds after the tab exists. Navigate before it lands and the first
    // request is real; the point here is the order of spoiled headers.
    if (withExtension) await page.waitForTimeout(500);
    await page
      .goto(`http://127.0.0.1:${server.port}/?run=${run}`, { waitUntil: 'domcontentloaded' })
      .catch(() => {});
    await page.waitForTimeout(600);
  } finally {
    await ctx.close();
  }
  return captured.get(run) ?? [];
}

const vanilla = await capture('vanilla', false);
const scrambled = await capture('extension', true);
server.stop(true);

const names = (list: Header[]) => list.map(([name]) => name.toLowerCase());
const userAgent = (list: Header[]) =>
  list.find(([name]) => name.toLowerCase() === 'user-agent')?.[1] ?? '';

const base = names(vanilla);
const full = names(scrambled);
const common = full.filter((name) => base.includes(name));
const extra = full.filter((name) => !base.includes(name));

console.log('vanilla  :', base.join(' | '));
console.log('extension:', full.join(' | '));
console.log('vanilla ua:', userAgent(vanilla));
console.log('extension ua:', userAgent(scrambled));
console.log('added by the extension:', extra.join(', ') || 'none');

check('both runs reached the server', vanilla.length > 0 && scrambled.length > 0);
check('the extension is on (the user agent is spoofed)', userAgent(vanilla) !== userAgent(scrambled));
check(
  'the extension keeps the browser order for the headers it edits',
  common.join() === base.join(),
);
check(
  'a header the extension adds is appended',
  extra.every((name) => full.indexOf(name) >= base.length),
);
