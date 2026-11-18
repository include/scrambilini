/*
 * Normalization: turn what the browser sent into a stable shape.
 *
 * Two outputs matter:
 *   - `attrs`: the values we compare between visits.
 *   - `payloadHash`: a single hash of the whole set, the exact-match key.
 */

export type Scalar = string | number | boolean;
export type AttrValue = Scalar | Scalar[];

export interface Canonical {
  platform: string;
  uaFamily: string;
  uaMajor: number;
  screenBucket: string;
  gpuFamily: string;
  attrs: Record<string, AttrValue>;
}

/** Attribute weights. Higher = more trust in the value. */
export const WEIGHTS: Record<string, number> = {
  canvas: 3,
  audio: 3,
  gpuRenderer: 2,
  fonts: 2,
  platform: 2,
  webgpu: 1.5,
  uaFamily: 1.5,
  screen: 1,
  timezone: 1,
  languages: 0.8,
  cores: 0.8,
  plugins: 0.5,
  uaMajor: 0.3,
};

export function sha256(input: string): string {
  return new Bun.CryptoHasher('sha256').update(input).digest('hex');
}

function uaFamilyOf(ua: string): string {
  if (/Edg\//.test(ua)) return 'edge';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

function uaMajorOf(ua: string): number {
  const match = /(?:Edg|Firefox|Chrome|Version)\/(\d+)/.exec(ua);
  return match ? Number(match[1]) : 0;
}

function gpuFamilyOf(renderer: string): string {
  if (/Apple/i.test(renderer)) return 'apple';
  if (/NVIDIA/i.test(renderer)) return 'nvidia';
  if (/Intel/i.test(renderer)) return 'intel';
  if (/AMD|Radeon/i.test(renderer)) return 'amd';
  if (/llvmpipe|Mesa/i.test(renderer)) return 'mesa';
  return 'other';
}

function asArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).sort();
}

export function canonicalize(raw: Record<string, unknown>): Canonical {
  const ua = String(raw.ua ?? '');
  const platform = String(raw.platform ?? 'unknown');
  const renderer = String(raw.webglRenderer ?? '');
  const screenW = Number(raw.screenW ?? 0);
  const screenH = Number(raw.screenH ?? 0);
  const dpr = Number(raw.dpr ?? 1);

  const attrs: Record<string, AttrValue> = {
    canvas: String(raw.canvasHash ?? ''),
    audio: String(raw.audioHash ?? ''),
    gpuRenderer: renderer,
    fonts: asArray(raw.fonts),
    platform,
    webgpu: String(raw.webgpu ?? ''),
    screen: `${Math.round(screenW / 100) * 100}x${Math.round(screenH / 100) * 100}`,
    timezone: String(raw.timezone ?? ''),
    languages: asArray(raw.languages),
    cores: Number(raw.cores ?? 0),
    uaFamily: uaFamilyOf(ua),
    uaMajor: uaMajorOf(ua),
    plugins: Number(raw.plugins ?? 0),
  };

  return {
    platform,
    uaFamily: String(attrs.uaFamily),
    uaMajor: Number(attrs.uaMajor),
    screenBucket: String(attrs.screen),
    gpuFamily: gpuFamilyOf(renderer),
    attrs,
  };
}

/** Stable hash of every attribute, sorted by key. */
export function payloadHash(c: Canonical): string {
  const keys = Object.keys(c.attrs).sort();
  const parts = keys.map((key) => `${key}=${JSON.stringify(c.attrs[key])}`);
  return sha256(parts.join('\n'));
}
