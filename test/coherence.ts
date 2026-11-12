/*
 * Open several tabs and check that each one is internally coherent: the UA, the
 * platform hints, the client-hint header and the font list all tell the same
 * story.
 *
 *   bun run test/coherence.ts
 */
import { check, probeTab, warm, withBrowser, type Probe } from './harness';

type System = 'macos' | 'windows' | 'linux';

const EXPECTED_FONTS: Record<System, Record<string, boolean>> = {
  macos: { arial: true, calibri: false, segoe: false, menlo: true, liberation: false, nimbus: false },
  windows: { arial: true, calibri: true, segoe: true, menlo: false, liberation: false, nimbus: false },
  linux: { arial: true, calibri: false, segoe: false, menlo: false, liberation: true, nimbus: true },
};

const WIDTH_KEYS = ['arial', 'calibri', 'segoe', 'menlo', 'liberation', 'nimbus'];

function platformOf(ua: string): { system: System; nav: string; uad: string; ch: string } | null {
  if (ua.includes('Macintosh')) return { system: 'macos', nav: 'MacIntel', uad: 'macOS', ch: '"macOS"' };
  if (ua.includes('Windows NT')) return { system: 'windows', nav: 'Win32', uad: 'Windows', ch: '"Windows"' };
  if (ua.includes('Linux')) return { system: 'linux', nav: 'Linux x86_64', uad: 'Linux', ch: '"Linux"' };
  return null;
}

const problems: string[] = [];
const seen: Record<System, number> = { macos: 0, windows: 0, linux: 0 };
let raced = 0;

function problem(message: string): void {
  problems.push(message);
}

await withBrowser(async (ctx) => {
  await warm(ctx);

  for (let i = 0; i < 6; i++) {
    const probe: Probe = await probeTab(ctx);
    const info = platformOf(probe.finalUa);
    if (!info) {
      problem(`unknown UA: ${probe.finalUa}`);
      continue;
    }
    seen[info.system] += 1;
    if (probe.requestHeaders['user-agent'] !== probe.ua) raced += 1;
    if (!probe.coherenceMatched) {
      problem(`headers never matched the page identity (waited ${probe.coherenceMs}ms)`);
    }

    if (probe.finalPlatform !== info.nav) {
      problem(`navigator.platform ${probe.finalPlatform} != ${info.nav}`);
    }
    if (probe.finalUadPlatform !== info.uad) {
      problem(`userAgentData.platform ${probe.finalUadPlatform} != ${info.uad}`);
    }
    if (probe.requestHeaders['sec-ch-ua-platform'] !== info.ch) {
      problem(`sec-ch-ua-platform ${probe.requestHeaders['sec-ch-ua-platform']} != ${info.ch}`);
    }
    const navUa = probe.navHeaders?.['user-agent'];
    const fetchUa = probe.requestHeaders['user-agent'];
    if (navUa !== probe.finalUa) problem(`navigation UA != settled UA (${navUa})`);
    if (fetchUa !== probe.finalUa) problem(`request UA != settled UA (${fetchUa})`);

    const expected = EXPECTED_FONTS[info.system];
    for (const name of WIDTH_KEYS) {
      const want = expected[name];
      const got = probe.fonts[name];
      if (got !== want) problem(`${info.system}: fonts.check(${name}) = ${got}, want ${want}`);

      const width = probe.fontWidths[name];
      const baseline = probe.fontWidths.baseline;
      const differs = Math.abs(width - baseline) > 0.01;
      if (differs !== want) {
        problem(
          `${info.system}: ${name} width ${width.toFixed(3)} vs baseline ${baseline.toFixed(3)} ` +
            `(differs=${differs}, want ${want})`,
        );
      }
    }

    console.log(
      JSON.stringify({
        seed: probe.finalSeed,
        ua: probe.finalUa,
        platform: probe.finalPlatform,
        fonts: probe.fonts,
        settledAfterMs: probe.coherenceMs,
      }),
    );
  }
});

console.log('');
console.log('systems seen:', seen);
console.log('tabs that read the identity before the hand-off landed:', raced);
console.log('problems:', problems.length);
for (const item of problems) console.log('  -', item);

check('all tabs are coherent', problems.length === 0);
if (seen.macos + seen.windows + seen.linux !== 6) {
  check('every tab produced a known platform', false);
}
