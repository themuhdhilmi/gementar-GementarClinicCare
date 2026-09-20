/**
 * Turns documents/media/logos/logo.png into the web assets the app uses.
 *
 *   node scripts/build-logo-assets.mjs
 *
 * Produces, in apps/web/public/brand/:
 *   logo.png            full lockup, transparent, for light surfaces
 *   logo-dark.png       the same with the black wordmark in white
 *   logo-compact.png    lockup without the tagline, for headers
 *   logo-compact-dark.png
 *   mark.png            the G mark alone, square, for tight spaces and the favicon
 *
 * Needs `sharp`, a devDependency of the web app. Re-run it when the logo
 * changes; do not hand-edit the output.
 */
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const SOURCE = new URL('../documents/media/logos/logo.png', import.meta.url).pathname;
const OUT = new URL('../apps/web/public/brand/', import.meta.url).pathname;
const ICON = new URL('../apps/web/src/app/icon.png', import.meta.url).pathname;

/**
 * A logo is flat colour and one gradient, so a palette costs nothing visually
 * and saves most of the bytes. These files are on the critical path of the
 * sign-in screen, which the clinic loads on every shift.
 */
const PNG_OPTIONS = { compressionLevel: 9, effort: 10, palette: true, colours: 200 };

/**
 * The source has a flat white background. Removing every white pixel would
 * also punch out the ECG line drawn through the mark, so this floods inward
 * from the edges and only clears background that is actually connected to it.
 * Near-white pixels at the boundary get partial alpha, which keeps the
 * antialiasing on the letterforms.
 */
function clearBackground(data, width, height) {
  // The export is not perfectly flat white, so "pale and colourless" is the
  // test, not "exactly #ffffff".
  const isPale = (i) => {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    return r > 214 && g > 214 && b > 214 && Math.max(r, g, b) - Math.min(r, g, b) < 14;
  };
  const seen = new Uint8Array(width * height);
  const stack = [];

  for (let x = 0; x < width; x += 1) {
    stack.push(x, x + (height - 1) * width);
  }
  for (let y = 0; y < height; y += 1) {
    stack.push(y * width, width - 1 + y * width);
  }

  while (stack.length > 0) {
    const pixel = stack.pop();
    if (pixel === undefined || seen[pixel]) continue;
    const i = pixel * 4;
    if (!isPale(i)) continue;
    seen[pixel] = 1;

    const luminance = (data[i] + data[i + 1] + data[i + 2]) / 3;
    // White disappears entirely, and the grey fringe of an antialiased edge
    // keeps proportionally more of its weight, so letterforms stay smooth.
    data[i + 3] = Math.max(0, Math.min(255, Math.round((252 - luminance) * (255 / 34))));

    const x = pixel % width;
    const y = (pixel - x) / width;
    if (x > 0) stack.push(pixel - 1);
    if (x < width - 1) stack.push(pixel + 1);
    if (y > 0) stack.push(pixel - width);
    if (y < height - 1) stack.push(pixel + width);
  }
}

/**
 * Builds the variant for dark surfaces.
 *
 * Inverting colours is not enough: the enclosed parts of letters — the middle
 * of an A, the bowl of an R — are white background that the flood fill cannot
 * reach, and they would sit on a dark page as white blobs. So the wordmark is
 * rebuilt as an ink mask instead: white ink, with transparency taken from how
 * dark each pixel was.
 *
 * The mark itself is left exactly as it is, because the white inside it is not
 * background. It is the ECG line.
 */
function toDarkVariant(light, width, height, markWidth) {
  const dark = Buffer.from(light);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (x < markWidth) continue;

      const [r, g, b] = [light[i], light[i + 1], light[i + 2]];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 45) continue; // red "Care"

      const luminance = (r + g + b) / 3;
      dark[i] = 255;
      dark[i + 1] = 255;
      dark[i + 2] = 255;
      dark[i + 3] = Math.max(0, Math.min(255, Math.round(255 - luminance)));
    }
  }
  return dark;
}

/**
 * Rows of the wordmark that carry ink, read from the bottom up: the first gap
 * is the space between the tagline and the name above it.
 */
function findTaglineTop(data, width, height) {
  const from = Math.round(width * 0.30);
  const inked = [];
  for (let y = 0; y < height; y += 1) {
    let ink = 0;
    for (let x = from; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 40) ink += 1;
    }
    inked.push(ink > 2);
  }
  let y = height - 1;
  while (y > 0 && !inked[y]) y -= 1; // skip trailing space
  while (y > 0 && inked[y]) y -= 1; // skip the tagline
  while (y > 0 && !inked[y]) y -= 1; // skip the gap above it
  return Math.max(1, y + 1);
}

/** Clears the tagline, and nothing else. */
function eraseTagline(source, width, height, taglineTop, wordmarkFrom) {
  const out = Buffer.from(source);
  for (let y = taglineTop; y < height; y += 1) {
    for (let x = wordmarkFrom; x < width; x += 1) {
      out[(y * width + x) * 4 + 3] = 0;
    }
  }
  return out;
}

async function load() {
  const trimmed = await sharp(SOURCE)
    .trim({ background: '#ffffff', threshold: 12 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  clearBackground(trimmed.data, trimmed.info.width, trimmed.info.height);
  return trimmed;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const { data, info } = await load();
  const raw = { raw: { width: info.width, height: info.height, channels: 4 } };
  console.log(`source trimmed to ${info.width}x${info.height}`);

  // The mark is the leftmost block, up to the gap before the wordmark.
  const markWidth = Math.round(info.width * 0.28);

  await sharp(data, raw)
    .resize({ width: 900, withoutEnlargement: true })
    .png(PNG_OPTIONS)
    .toFile(`${OUT}logo.png`);

  const dark = toDarkVariant(data, info.width, info.height, markWidth);
  await sharp(dark, raw)
    .resize({ width: 900, withoutEnlargement: true })
    .png(PNG_OPTIONS)
    .toFile(`${OUT}logo-dark.png`);

  await sharp(data, raw)
    .extract({ left: 0, top: 0, width: markWidth, height: info.height })
    .trim({ threshold: 1 })
    .resize({ width: 512, height: 512, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png(PNG_OPTIONS)
    .toFile(`${OUT}mark.png`);

  // The tagline stops being words below about 40px, so headers get a lockup
  // without it. The gap above it is found rather than guessed.
  //
  // Only the tagline is erased, not everything below its line: the mark is
  // taller than the text beside it, and cropping the canvas to the tagline
  // would slice the bottom off the G.
  const taglineTop = findTaglineTop(data, info.width, info.height);
  const wordmarkFrom = Math.round(info.width * 0.3);
  for (const [name, source] of [
    ['logo-compact.png', data],
    ['logo-compact-dark.png', dark],
  ]) {
    const compact = eraseTagline(source, info.width, info.height, taglineTop, wordmarkFrom);
    await sharp(compact, raw)
      .trim({ threshold: 1 })
      .resize({ width: 720, withoutEnlargement: true })
      .png(PNG_OPTIONS)
      .toFile(`${OUT}${name}`);
  }

  // The browser tab icon. Small on purpose: it is fetched on every page load.
  await sharp(`${OUT}mark.png`)
    .resize({ width: 256, height: 256 })
    .png({ compressionLevel: 9, effort: 10, palette: true, colours: 128 })
    .toFile(ICON);

  const { statSync } = await import('node:fs');
  for (const file of ['logo.png', 'logo-dark.png', 'logo-compact.png', 'logo-compact-dark.png', 'mark.png']) {
    const meta = await sharp(`${OUT}${file}`).metadata();
    const kb = (statSync(`${OUT}${file}`).size / 1024).toFixed(0);
    console.log(`  ${file.padEnd(22)} ${meta.width}x${meta.height}  ${kb} KB`);
  }
  console.log(`  ${'app/icon.png'.padEnd(22)} 256x256  ${(statSync(ICON).size / 1024).toFixed(0)} KB`);
}

await main();
