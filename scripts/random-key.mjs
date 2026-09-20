/**
 * Prints a 32-byte key, base64. Used for APP_KEK_V1 and APP_HASH_PEPPER, and
 * by the Jenkins pipeline to mint throwaway keys for a build.
 *
 *   node scripts/random-key.mjs
 */
import { randomBytes } from 'node:crypto';

process.stdout.write(`${randomBytes(32).toString('base64')}\n`);
