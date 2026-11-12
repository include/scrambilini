/*
 * Shared harness for the Scrambilini tests.
 *
 * Serves the probe page, launches a Chromium with the unpacked extension
 * loaded, and reads `window.__probe` back. Everything is Bun + Playwright.
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ROOT = join(import.meta.dir, '..');
export const PORT = 8765;
export const PROBE_URL = `http://127.0.0.1:${PORT}/probe.html`;

/** Chromium derives an unpacked extension id from the absolute path. */
export function extensionId(path = ROOT): string {
  const hex = createHash('sha256').update(path).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

let server: ReturnType<typeof Bun.serve> | null = null;

/** Local probe server: /probe.html and /headers. */
export function serve(): void {
  if (server) return;
  const probeHtml = readFileSync(join(ROOT, 'test', 'probe.html'), 'utf8');
  server = Bun.serve({
    port: PORT,
    hostname: '127.0.0.1',
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === '/probe.html') {
        // Bun lower-cases header names; the tests read them that way too.
        const headers = Object.fromEntries(req.headers);
        const html = probeHtml.replace(
          '<head>',
          `<head><script>window.__navHeaders = ${JSON.stringify(headers)};</script>`,
        );
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (pathname === '/headers') {
        return Response.json(Object.fromEntries(req.headers));
      }
      return new Response('not found', { status: 404 });
    },
  });
  // Do not keep the process alive once the tests are done.
  server.unref();
}

export async function launch(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'scrambilini-')), {
    headless: false,
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
}

/** Opens and closes a tab so the service worker is awake before measuring. */
export async function warm(ctx: BrowserContext, ms = 600): Promise<void> {
  const page = await ctx.newPage();
  await page.goto('about:blank');
  await page.waitForTimeout(ms);
  await page.close();
}

export interface Probe {
  early: { ua: string; languages: string[] };
  ua: string;
  appVersion: string;
  platform: string;
  vendor: string;
  productSub: string;
  languages: string[];
  language: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  doNotTrack: string | null;
  webdriver: boolean;
  pdfViewerEnabled: boolean;
  plugins: string[];
  mimeTypes: string[];
  screen: { w: number; h: number; aw: number; ah: number; cd: number; pd: number };
  window: { dpr: number; iw: number; ih: number; ow: number; oh: number; sx: number; sy: number };
  timezone: string;
  tzOffset: number;
  dateString: string;
  dateHours: number;
  utcHours: number;
  brands: { brand: string; version: string }[] | null;
  uadPlatform: string | null;
  hev: Record<string, unknown> | null;
  connection: { et: string; rtt: number } | null;
  battery: { level: number; charging: boolean } | null;
  devices: string[];
  storage: number | null;
  canvasDataUrl: string;
  canvasPixels: number[];
  measure: number;
  fonts: Record<string, boolean>;
  fontWidths: Record<string, number>;
  glVendor?: string;
  glRenderer?: string;
  glUnmaskedVendor?: string | null;
  glUnmaskedRenderer?: string | null;
  glMaxTex?: number;
  glVersion?: string;
  audioSampleRate?: number;
  audioFingerprint: string;
  native: { uaGetter: string; fnToString: string; toDataURL: string };
  voices: Array<{ name: string; lang: string; uri: string; def: boolean; local: boolean }>;
  locale: string;
  localeNumber: string;
  timeZoneIntl: string;
  number: string;
  numberLocale: string;
  date: string;
  dateLocaleString: string;
  dateStyle: string;
  keyboard: Record<string, string> | null;
  seed: string;
  requestHeaders: Record<string, string>;
  navHeaders: Record<string, string> | null;
  finalUa: string;
  finalSeed: string;
  finalPlatform: string;
  finalUadPlatform: string | null;
  finalLanguages: string[];
  finalTimezone: string;
  finalScreen: { w: number; h: number; dpr: number };
  finalCores: number;
  coherenceMs: number;
  coherenceMatched: boolean;
  tLoad: number;
  tEnd: number;
}

/** Opens the probe page, waits for the load-time snapshot and returns it. */
export async function probeTab(ctx: BrowserContext, url = PROBE_URL): Promise<Probe> {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as unknown as { __probe?: unknown }).__probe !== undefined, null, {
    timeout: 20000,
  });
  const result = (await page.evaluate(
    () => (window as unknown as { __probe: Probe }).__probe,
  )) as Probe;
  await page.close();
  return result;
}

/** Opens one of the extension's own pages (the popup, by default). */
export async function extensionPage(ctx: BrowserContext, path = 'src/popup.html'): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extensionId()}/${path}`);
  await page.waitForTimeout(300);
  return page;
}

/** Runs a function with a fresh browser, always closing it afterwards. */
export async function withBrowser<T>(fn: (ctx: BrowserContext) => Promise<T>): Promise<T> {
  serve();
  const ctx = await launch();
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

export function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

export function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) process.exitCode = 1;
}
