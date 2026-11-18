/*
 * Synthetic evaluation.
 *
 *   bun run src/simulate.ts
 *
 * Builds N devices, lets them visit over time with realistic changes (browser
 * updates, new fonts, a new monitor), and measures how well the matcher links
 * the visits back to the right device.
 */
import { openDb } from './db';
import { canonicalize, payloadHash } from './normalize';
import { observe, type Observation } from './match';

// ---------------------------------------------------------------------------
// Deterministic randomness, so two runs give the same numbers.
// ---------------------------------------------------------------------------
let state = 20261118;
const rnd = () => {
  state = (state * 1664525 + 1013904223) >>> 0;
  return state / 4294967296;
};
const pick = <T>(items: T[]): T => items[Math.floor(rnd() * items.length)];
const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
const hex = (length: number) => Array.from({ length }, () => Math.floor(rnd() * 16).toString(16)).join('');

const UA = {
  macos: (v: number) =>
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
  windows: (v: number) =>
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
  linux: (v: number) =>
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
};

const SCREENS = {
  macos: [[1512, 982, 2], [1728, 1117, 2], [1440, 900, 2], [2560, 1440, 2]],
  windows: [[1920, 1080, 1], [1536, 864, 1.25], [2560, 1440, 1], [1366, 768, 1]],
  linux: [[1920, 1080, 1], [2560, 1440, 1], [1366, 768, 1]],
};

const GPUS = {
  macos: ['ANGLE (Apple, ANGLE Metal Renderer: Apple M1)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2)'],
  windows: ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)', 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'],
  linux: ['ANGLE (AMD, AMD Radeon RX 580 OpenGL 4.6)', 'ANGLE (Intel, Mesa Intel(R) Xeon OpenGL 4.6)'],
};

const FONT_POOL = [
  'Arial', 'Helvetica', 'Times New Roman', 'Courier New', 'Georgia', 'Verdana',
  'Tahoma', 'Trebuchet MS', 'Calibri', 'Cambria', 'Consolas', 'Segoe UI',
  'Menlo', 'Monaco', 'DejaVu Sans', 'Liberation Sans', 'Ubuntu', 'Noto Sans',
  'Nimbus Sans', 'SF Pro Text',
];

const TIMEZONES = ['Europe/Lisbon', 'Europe/Madrid', 'Europe/Berlin', 'America/New_York', 'Asia/Tokyo'];
const LANGS = [['en-US', 'en'], ['en-GB', 'en'], ['pt-PT', 'pt', 'en'], ['de-DE', 'de', 'en'], ['fr-FR', 'fr', 'en']];

interface Device {
  id: string;
  platform: keyof typeof UA;
  major: number;
  screen: number[];
  gpu: string;
  fonts: string[];
  timezone: string;
  languages: string[];
  cores: number;
  memory: number;
  plugins: number;
  canvas: string;
  audio: string;
  webgpu: string;
}

function makeDevice(index: number): Device {
  const platform = pick(['macos', 'windows', 'linux'] as const);
  return {
    id: `d${index}`,
    platform,
    major: int(132, 145),
    screen: pick(SCREENS[platform]),
    gpu: pick(GPUS[platform]),
    fonts: FONT_POOL.filter(() => rnd() < 0.55),
    timezone: pick(TIMEZONES),
    languages: pick(LANGS),
    cores: pick([4, 8, 10, 12, 16]),
    memory: pick([4, 8, 16]),
    plugins: 5,
    canvas: hex(16),
    audio: hex(16),
    webgpu: `${pick(['apple', 'nvidia', 'intel'])}/${pick(['metal-3', 'ampere', 'gen-12lp'])}`,
  };
}

function mutate(device: Device): void {
  // Browser update every few weeks.
  if (rnd() < 0.06) device.major = Math.min(170, device.major + 1);
  // A font gets installed.
  if (rnd() < 0.04) {
    const missing = FONT_POOL.filter((font) => !device.fonts.includes(font));
    if (missing.length) device.fonts = [...device.fonts, pick(missing)].sort();
  }
  // A monitor change.
  if (rnd() < 0.02) device.screen = pick(SCREENS[device.platform]);
  // Travel.
  if (rnd() < 0.01) device.timezone = pick(TIMEZONES);
  // Driver update.
  if (rnd() < 0.005) device.canvas = hex(16);
}

function toObservation(device: Device, at: number): Observation {
  const raw = {
    ua: UA[device.platform](device.major),
    platform: device.platform === 'macos' ? 'MacIntel' : device.platform === 'windows' ? 'Win32' : 'Linux x86_64',
    languages: device.languages,
    timezone: device.timezone,
    screenW: device.screen[0],
    screenH: device.screen[1],
    dpr: device.screen[2],
    cores: device.cores,
    memory: device.memory,
    plugins: device.plugins,
    webglRenderer: device.gpu,
    canvasHash: device.canvas,
    audioHash: device.audio,
    fonts: device.fonts,
    webgpu: device.webgpu,
  };
  const canonical = canonicalize(raw);
  return { ...canonical, hash: payloadHash(canonical), receivedAt: at };
}

const DEVICES = Number(Bun.env.DEVICES ?? 400);
const VISITS = Number(Bun.env.VISITS ?? 10);
const DAY = 24 * 60 * 60 * 1000;

const db = openDb(':memory:');
const now = Date.now();
const devices = Array.from({ length: DEVICES }, (_, i) => makeDevice(i));
const truth: string[] = [];
const predicted: string[] = [];
const methods = { exact: 0, similarity: 0, new: 0 };
const bands = { below60: 0, ambiguous: 0, above85: 0 };

for (let visit = 0; visit < VISITS; visit++) {
  for (const device of devices) {
    if (visit > 0) mutate(device);
    const at = now - (VISITS - 1 - visit) * DAY + int(-3_600_000, 3_600_000);
    const result = observe(db, toObservation(device, at));
    truth.push(device.id);
    predicted.push(result.visitorId);
    methods[result.method] += 1;
    if (result.method === 'new') {
      if (result.bestScore >= 0.85) bands.above85 += 1;
      else if (result.bestScore >= 0.6) bands.ambiguous += 1;
      else bands.below60 += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
const clusters = new Map<string, Map<string, number>>();
for (let i = 0; i < predicted.length; i++) {
  if (!clusters.has(predicted[i])) clusters.set(predicted[i], new Map());
  const bucket = clusters.get(predicted[i])!;
  bucket.set(truth[i], (bucket.get(truth[i]) ?? 0) + 1);
}

let mergedClusters = 0;
let mergedObservations = 0;
let pureObservations = 0;
for (const bucket of clusters.values()) {
  if (bucket.size === 1) {
    pureObservations += [...bucket.values()].reduce((a, b) => a + b, 0);
  } else {
    mergedClusters += 1;
    mergedObservations += [...bucket.values()].reduce((a, b) => a + b, 0);
  }
}

// Per device: did the visits stay on one visitor id?
let fragmented = 0;
let linked = 0;
let revisits = 0;
const perDevice = new Map<string, Map<string, number>>();
for (let i = 0; i < predicted.length; i++) {
  if (!perDevice.has(truth[i])) perDevice.set(truth[i], new Map());
  const bucket = perDevice.get(truth[i])!;
  bucket.set(predicted[i], (bucket.get(predicted[i]) ?? 0) + 1);
}
for (const bucket of perDevice.values()) {
  if (bucket.size > 1) fragmented += 1;
  const dominant = Math.max(...bucket.values());
  const visits = [...bucket.values()].reduce((a, b) => a + b, 0);
  linked += dominant - 1;
  revisits += visits - 1;
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

console.log(`devices ${DEVICES}, visits ${VISITS} each, over ${VISITS} days`);
console.log(`observations       ${truth.length}`);
console.log(`exact matches      ${methods.exact}`);
console.log(`similarity matches ${methods.similarity}`);
console.log(`new devices        ${methods.new}`);
console.log('');
console.log(`link recall        ${pct(revisits ? linked / revisits : 0)}  (${linked}/${revisits} revisits linked)`);
console.log(`observation purity ${pct(truth.length ? pureObservations / truth.length : 0)}`);
console.log(`false merges       ${mergedClusters} clusters, ${mergedObservations} observations (${pct(truth.length ? mergedObservations / truth.length : 0)})`);
console.log(`fragmented devices ${fragmented} of ${DEVICES} (${pct(DEVICES ? fragmented / DEVICES : 0)})`);
console.log(`new visits by best score: <0.6 ${bands.below60}, 0.6-0.85 ${bands.ambiguous}, >=0.85 ${bands.above85}`);
