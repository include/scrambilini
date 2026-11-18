import { describe, expect, test } from 'bun:test';
import { canonicalize, payloadHash, type AttrValue } from '../src/normalize';
import { scorePair } from '../src/match';

const base = {
  ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  platform: 'MacIntel',
  languages: ['en-US', 'en'],
  timezone: 'Europe/Lisbon',
  screenW: 1512,
  screenH: 982,
  dpr: 2,
  cores: 10,
  memory: 16,
  plugins: 5,
  webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2)',
  canvasHash: 'a1b2c3d4e5f60718',
  audioHash: '0011223344556677',
  fonts: ['Arial', 'Helvetica', 'Menlo'],
  webgpu: 'apple/metal-3',
};

const attrs = (overrides: Record<string, unknown> = {}): Record<string, AttrValue> =>
  canonicalize({ ...base, ...overrides }).attrs;

describe('normalization', () => {
  test('groups the browser family and major version', () => {
    const canonical = canonicalize(base);
    expect(canonical.uaFamily).toBe('chrome');
    expect(canonical.uaMajor).toBe(131);
    expect(canonical.platform).toBe('MacIntel');
    expect(canonical.gpuFamily).toBe('apple');
  });

  test('the payload hash does not depend on key order', () => {
    const a = { ...base };
    const b = Object.fromEntries(Object.entries(base).reverse());
    expect(payloadHash(canonicalize(a))).toBe(payloadHash(canonicalize(b)));
  });

  test('a different canvas changes the hash', () => {
    const other = { ...base, canvasHash: 'ffffffffffffffff' };
    expect(payloadHash(canonicalize(other))).not.toBe(payloadHash(canonicalize(base)));
  });
});

describe('similarity', () => {
  test('the same profile scores 1', () => {
    expect(scorePair(attrs(), attrs())).toBeCloseTo(1, 5);
  });

  test('a browser update barely changes the score', () => {
    const updated = attrs({
      ua: base.ua.replace('Chrome/131', 'Chrome/132'),
    });
    const score = scorePair(attrs(), updated);
    expect(score).toBeGreaterThan(0.98);
    expect(score).toBeLessThan(1);
  });

  test('a new font is forgiven', () => {
    const fonts = [...base.fonts, 'Georgia'];
    const score = scorePair(attrs(), attrs({ fonts }));
    expect(score).toBeGreaterThan(0.9);
  });

  test('a different canvas and audio is a different device', () => {
    const other = attrs({ canvasHash: 'ffffffffffffffff', audioHash: 'ffffffffffffffff' });
    expect(scorePair(attrs(), other)).toBeLessThan(0.85);
  });

  test('a different platform is never the same device', () => {
    const other = attrs({ platform: 'Win32', ua: base.ua.replace('Macintosh; Intel Mac OS X 10_15_7', 'Windows NT 10.0; Win64; x64') });
    expect(scorePair(attrs(), other)).toBeLessThan(0.6);
  });
});
