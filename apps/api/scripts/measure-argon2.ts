/**
 * IAM-N-02: the Argon2id cost must be tuned on the host that will run it, to
 * 200–300 ms. Run this on the production box and record the result in
 * `documents/modules/v0-01-identity-access.md`.
 *
 *   npm run measure:argon2 -- --target 250
 */
import 'dotenv/config';
import { hash } from '@node-rs/argon2';

const ARGON2ID = 2;
const target = Number(
  process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : 250,
);

async function time(memoryCost: number, timeCost: number, parallelism: number): Promise<number> {
  const password = 'correct horse battery staple 42';
  const started = process.hrtime.bigint();
  await hash(password, { algorithm: ARGON2ID as never, memoryCost, timeCost, parallelism });
  return Number(process.hrtime.bigint() - started) / 1e6;
}

/**
 * Memory first, then iterations. Memory is what makes GPU cracking expensive,
 * but every concurrent login holds its own pool, so it is also the number that
 * decides how much RAM a login storm costs. 64–128 MiB is the sensible band
 * for a single-VPS clinic system; iterations take it the rest of the way.
 */
const candidates: Array<[number, number, number]> = [
  [19456, 2, 1],
  [32768, 2, 1],
  [47104, 3, 1],
  [65536, 3, 1],
  [65536, 6, 1],
  [65536, 10, 1],
  [98304, 4, 1],
  [98304, 8, 1],
  [131072, 3, 1],
  [131072, 6, 1],
  [131072, 8, 1],
];

console.log(`Target: ~${target} ms per hash. Three runs each, median reported.\n`);
console.log('  memory KiB  iterations  parallelism   median ms');

let best: { config: [number, number, number]; ms: number } | null = null;
for (const [memoryCost, timeCost, parallelism] of candidates) {
  const samples: number[] = [];
  for (let i = 0; i < 3; i += 1) samples.push(await time(memoryCost, timeCost, parallelism));
  samples.sort((a, b) => a - b);
  const median = samples[1]!;
  console.log(
    `  ${String(memoryCost).padStart(10)}  ${String(timeCost).padStart(10)}  ` +
      `${String(parallelism).padStart(11)}   ${median.toFixed(0).padStart(9)}`,
  );
  if (!best || Math.abs(median - target) < Math.abs(best.ms - target)) {
    best = { config: [memoryCost, timeCost, parallelism], ms: median };
  }
}

if (best) {
  const [memoryCost, timeCost, parallelism] = best.config;
  console.log(
    `\nClosest to target: ${best.ms.toFixed(0)} ms\n\n` +
      `  ARGON2_MEMORY_KIB=${memoryCost}\n  ARGON2_ITERATIONS=${timeCost}\n  ARGON2_PARALLELISM=${parallelism}\n`,
  );
}
