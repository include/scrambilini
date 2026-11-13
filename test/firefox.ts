/*
 * Firefox smoke test: load the Firefox build as a temporary add-on and check
 * that it produces Firefox identities, not Chrome ones.
 *
 *   bun run test/firefox.ts
 *
 * Uses Selenium + geckodriver, because Playwright's Firefox cannot load
 * extensions.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Builder, type WebDriver } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { check, PROBE_URL, ROOT, serve, type Probe } from './harness';

const EXT = join(ROOT, 'firefox');

async function buildXpi(): Promise<string> {
  const xpi = join(mkdtempSync(join(tmpdir(), 'scrambilini-xpi-')), 'scrambilini.xpi');
  const zip = Bun.spawnSync(['zip', '-qr', xpi, 'manifest.json', 'src', 'icons'], { cwd: EXT });
  if (zip.exitCode !== 0) throw new Error(`zip failed: ${zip.stderr.toString()}`);
  return xpi;
}

async function readProbe(driver: WebDriver): Promise<Probe> {
  await driver.wait(
    async () => (await driver.executeScript('return !!window.__probe')) === true,
    20000,
  );
  return (await driver.executeScript('return window.__probe')) as Probe;
}

async function openTab(driver: WebDriver): Promise<Probe> {
  await driver.switchTo().newWindow('tab');
  await driver.get(PROBE_URL);
  return readProbe(driver);
}

/** installAddon exists at runtime but is missing from the published types. */
const installAddon = (driver: WebDriver, path: string, temporary = true) =>
  (driver as unknown as {
    installAddon: (path: string, temporary: boolean) => Promise<void>;
  }).installAddon(path, temporary);

const platformOf = (ua: string): string | null => {
  if (ua.includes('Macintosh')) return 'MacIntel';
  if (ua.includes('Windows NT')) return 'Win32';
  if (ua.includes('Linux')) return 'Linux x86_64';
  return null;
};

serve();
const xpi = await buildXpi();
const options = new firefox.Options().addArguments('-headless');
const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).build();

try {
  await installAddon(driver, xpi);

  const first = await openTab(driver);
  const second = await openTab(driver);

  const firstUa = first.finalUa;
  const secondUa = second.finalUa;
  const caps = (await driver.executeScript(
    'return { uad: typeof navigator.userAgentData, dm: typeof navigator.deviceMemory, ' +
      'conn: typeof navigator.connection, battery: typeof navigator.getBattery, ' +
      'productSub: navigator.productSub, vendor: navigator.vendor }',
  )) as Record<string, string>;

  console.log('tab 1     :', firstUa);
  console.log('tab 2     :', secondUa);
  console.log('platform  :', first.finalPlatform, '| oscpu:', caps);
  console.log('headers   :', JSON.stringify(first.requestHeaders));
  console.log('voices    :', first.voices.length, first.voices[0]?.name);
  console.log('locale    :', first.locale, '| languages:', first.finalLanguages);
  console.log('coherence :', first.coherenceMatched, `${first.coherenceMs}ms`);

  check('the UA is a Firefox UA', firstUa.includes('Firefox/') && !firstUa.includes('Chrome/'));
  check('the platform matches the UA', first.finalPlatform === platformOf(firstUa));
  check('the headers carry the same UA', first.requestHeaders['user-agent'] === firstUa);
  check('no Chrome client hints are sent', !('sec-ch-ua' in first.requestHeaders));
  check('userAgentData is absent', caps.uad === 'undefined');
  check('deviceMemory is absent', caps.dm === 'undefined');
  check('connection is absent', caps.conn === 'undefined');
  check('getBattery is absent', caps.battery === 'undefined');
  check('productSub is Firefox', caps.productSub === '20100101');
  check('vendor is empty', caps.vendor === '');
  check('locale follows the languages', first.locale === first.finalLanguages[0]);
  check('speech voices are spoofed', first.voices.length > 0);
  check('headers match the page', first.coherenceMatched);
  check('each tab has its own seed', first.finalSeed !== second.finalSeed);
  check('each tab has its own identity', first.finalSeed !== second.finalSeed);

  if (first.webgpu && !('error' in first.webgpu)) {
    const renderer = first.finalRenderer || '';
    const expected = /Apple/i.test(renderer)
      ? 'apple'
      : /NVIDIA/i.test(renderer)
        ? 'nvidia'
        : /Intel/i.test(renderer)
          ? 'intel'
          : /AMD/i.test(renderer)
            ? 'amd'
            : null;
    console.log('webgpu    :', first.webgpu.vendor, '/', first.webgpu.architecture);
    if (expected) {
      check('the WebGPU vendor matches the renderer', first.webgpu.vendor === expected);
    }
  } else {
    console.log('webgpu    : not available in this Firefox build');
  }
} finally {
  await driver.quit();
}
