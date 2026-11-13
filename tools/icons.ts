/*
 * Build icons/icon{16,32,48,128}.png from the images/scrambilini.png artwork.
 *
 * The full composition works at 128 px; at 48 px and below the head crop keeps
 * the character readable.
 *
 *   bun run tools/icons.ts     (or: make icons)
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const ROOT = join(import.meta.dir, '..');
const SOURCE = join(ROOT, 'images', 'scrambilini.png');

// Square crops of the artwork, in source pixels.
const FULL = { left: 67, top: 18, width: 777, height: 777 }; // the whole character
const HEAD = { left: 285, top: 85, width: 330, height: 330 }; // head and sunglasses
const FACE = { left: 310, top: 110, width: 280, height: 280 }; // tightest: glasses and eyes

// size, crop, corner radius as a fraction of the side
const SPECS = [
  { size: 128, crop: FULL, radius: 0.22 },
  { size: 48, crop: HEAD, radius: 0.2 },
  { size: 32, crop: HEAD, radius: 0.2 },
  { size: 16, crop: FACE, radius: 0.18 },
];

for (const { size, crop, radius } of SPECS) {
  const r = Math.max(1, Math.round(size * radius));
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#fff"/></svg>`,
  );
  const out = join(ROOT, 'icons', `icon${size}.png`);
  await sharp(SOURCE)
    .extract(crop)
    .resize(size, size, { kernel: 'lanczos3' })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png({ compressionLevel: 9 })
    .toFile(out);
  const { size: bytes } = await stat(out);
  console.log(`icons/icon${size}.png  ${size}x${size}  ${bytes} bytes`);
}
