/*
 * Attributes that normally link every tab together: speech voices, the Intl
 * locale and the keyboard layout. Each tab has to look like a different machine,
 * and those values have to agree with the platform and language the identity
 * claims.
 *
 *   bun run test/attributes.ts
 */
import { check, probeTab, warm, withBrowser, type Probe } from './harness';

type System = 'macos' | 'windows' | 'linux';

function systemOf(ua: string): System | null {
  if (ua.includes('Macintosh')) return 'macos';
  if (ua.includes('Windows NT')) return 'windows';
  if (ua.includes('Linux')) return 'linux';
  return null;
}

/** Mirrors layoutFor() in src/shared/profile.js. */
function expectedLayout(locale: string): string {
  const [lang, country] = locale.toLowerCase().split('-');
  if (lang === 'fr') return 'fr';
  if (lang === 'de') return 'de';
  if (lang === 'pt') return 'br';
  if (lang === 'ja') return 'jp';
  if (lang === 'ko') return 'kr';
  if (lang === 'sv') return 'se';
  if (lang === 'en' && country === 'gb') return 'gb';
  return 'us';
}

const COMMA_DECIMAL = new Set(['fr', 'de', 'es', 'it', 'nl', 'pt', 'sv', 'pl', 'ru']);

const problems: string[] = [];
function problem(message: string): void {
  problems.push(message);
}

const signatures: string[] = [];
const systems: Record<string, number> = { macos: 0, windows: 0, linux: 0 };

await withBrowser(async (ctx) => {
  await warm(ctx);

  for (let i = 0; i < 6; i++) {
    const probe: Probe = await probeTab(ctx);
    const system = systemOf(probe.finalUa);
    if (!system) {
      problem(`unknown platform: ${probe.finalUa}`);
      continue;
    }
    systems[system] += 1;

    // Locale follows navigator.language.
    const expectedLocale = probe.finalLanguages[0];
    if (probe.locale !== expectedLocale) {
      problem(`Intl locale ${probe.locale} != navigator.languages[0] ${expectedLocale}`);
    }
    if (probe.localeNumber !== expectedLocale) {
      problem(`NumberFormat locale ${probe.localeNumber} != ${expectedLocale}`);
    }
    if (probe.timeZoneIntl !== probe.finalTimezone) {
      problem(`Intl timeZone ${probe.timeZoneIntl} != ${probe.finalTimezone}`);
    }

    const lang = expectedLocale.split('-')[0].toLowerCase();
    const lastSep = Math.max(probe.number.lastIndexOf(','), probe.number.lastIndexOf('.'));
    const decimalComma = probe.number[lastSep] === ',';
    if (decimalComma !== COMMA_DECIMAL.has(lang)) {
      problem(`${expectedLocale}: number ${probe.number} has the wrong decimal separator`);
    }

    if (probe.dateStyle.startsWith('err:')) {
      problem(`dateStyle threw: ${probe.dateStyle}`);
    }
    if (!probe.numberLocale.includes('1') || !probe.date.length) {
      problem('toLocaleString produced something odd');
    }

    // WebGPU adapter info must agree with the WebGL renderer.
    const renderer = probe.finalRenderer || '';
    const expectedVendor = /Apple/i.test(renderer)
      ? 'apple'
      : /NVIDIA/i.test(renderer)
        ? 'nvidia'
        : /Intel/i.test(renderer)
          ? 'intel'
          : /AMD/i.test(renderer)
            ? 'amd'
            : /llvmpipe/i.test(renderer)
              ? 'mesa'
              : null;
    if (probe.webgpu && !('error' in probe.webgpu)) {
      if (!probe.webgpu.architecture) problem('webgpu architecture is empty');
      if (expectedVendor && probe.webgpu.vendor !== expectedVendor) {
        problem(`webgpu vendor ${probe.webgpu.vendor} != ${expectedVendor} (${renderer})`);
      }
      if (expectedVendor === 'apple' && probe.webgpu.vendor !== 'apple') {
        problem('macOS identity does not report an apple WebGPU adapter');
      }
      if (system !== 'macos' && probe.webgpu.vendor === 'apple') {
        problem(`${system} identity still reports an apple WebGPU adapter`);
      }
    }

    // Voices belong to the platform and are a per-identity subset.
    if (!probe.voices.length) problem(`${system}: no speech voices`);
    if (probe.voices.filter((voice) => voice.def).length !== 1) {
      problem(`${system}: expected exactly one default voice`);
    }
    for (const voice of probe.voices) {
      if (!voice.name || !voice.lang) problem(`${system}: voice without name or lang`);
      if (system === 'macos' && !voice.uri.startsWith('com.apple.speech.synthesis.voice.')) {
        problem(`macos: voice ${voice.name} has a non-macOS URI`);
      }
      if (system === 'windows' && !voice.name.startsWith('Microsoft ')) {
        problem(`windows: voice ${voice.name} is not a Microsoft voice`);
      }
      if (system === 'linux' && !/^[A-Z][a-z]+ \([A-Za-z ]+\)$/.test(voice.name)) {
        problem(`linux: voice ${voice.name} does not look like a speech-dispatcher voice`);
      }
    }
    signatures.push(probe.voices.map((voice) => voice.name).join('|'));

    // Keyboard layout follows the language.
    const layout = expectedLayout(expectedLocale);
    const keys = probe.keyboard;
    if (!keys) {
      problem(`${system}: navigator.keyboard is missing`);
    } else if (layout === 'fr') {
      if (keys.KeyQ !== 'a' || keys.KeyA !== 'q' || keys.Semicolon !== 'm') {
        problem(`fr keyboard is not AZERTY: ${JSON.stringify(keys)}`);
      }
    } else if (layout === 'de') {
      if (keys.KeyY !== 'z' || keys.KeyZ !== 'y' || keys.Semicolon !== 'ö') {
        problem(`de keyboard is not QWERTZ: ${JSON.stringify(keys)}`);
      }
    } else if (layout === 'br') {
      if (keys.KeyQ !== 'q' || keys.KeyA !== 'a' || keys.Semicolon !== 'ç') {
        problem(`br keyboard is not ABNT: ${JSON.stringify(keys)}`);
      }
    } else if (keys.KeyQ !== 'q' || keys.KeyA !== 'a' || keys.Semicolon !== ';') {
      problem(`${layout} keyboard is not QWERTY: ${JSON.stringify(keys)}`);
    }

    console.log(
      JSON.stringify({
        system,
        ua: probe.finalUa.slice(0, 60),
        languages: probe.finalLanguages,
        locale: probe.locale,
        number: probe.number,
        voices: probe.voices.length,
        firstVoice: probe.voices[0]?.name,
        keyboard: keys ? `${keys.KeyQ}${keys.KeyW}${keys.KeyA}${keys.KeyZ}` : null,
        webgpu:
          probe.webgpu && !('error' in probe.webgpu)
            ? `${probe.webgpu.vendor}/${probe.webgpu.architecture}`
            : null,
        renderer: (probe.finalRenderer || '').slice(0, 50),
      }),
    );
  }
});

console.log('');
console.log('systems seen:', systems);
console.log('voice sets:', new Set(signatures).size, 'distinct of', signatures.length);
console.log('problems:', problems.length);
for (const item of problems) console.log('  -', item);

check('every identity is coherent (locale, voices, keyboard)', problems.length === 0);
check('voices differ between tabs', new Set(signatures).size > 1);
check('every tab produced a known platform', systems.macos + systems.windows + systems.linux === 6);
