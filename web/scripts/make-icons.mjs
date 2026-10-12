// Renders public/icon.svg to the PNG sizes the manifest and iOS need. Run: pnpm --dir web icons
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const svg = await readFile(join(pub, 'icon.svg'));

const square = (size) => sharp(svg, { density: 384 }).resize(size, size);

await square(192).png().toFile(join(pub, 'icon-192.png'));
await square(512).png().toFile(join(pub, 'icon-512.png'));
// iOS rounds the corners itself, so the touch icon is a full-bleed square.
const full = Buffer.from(svg.toString().replace('rx="112"', 'rx="0"'));
await sharp(full, { density: 384 }).resize(180, 180).png().toFile(join(pub, 'apple-touch-icon.png'));
// Maskable: full-bleed background with the mark kept inside the central safe zone.
const maskable = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#143A2D"/><g transform="translate(256 256) scale(0.8) translate(-256 -256)"><circle cx="256" cy="256" r="150" fill="none" stroke="#E8B04A" stroke-width="22"/><circle cx="256" cy="256" r="84" fill="#5FC49A"/></g></svg>`,
);
await sharp(maskable, { density: 384 }).resize(512, 512).png().toFile(join(pub, 'icon-maskable-512.png'));
console.log('icons written');
