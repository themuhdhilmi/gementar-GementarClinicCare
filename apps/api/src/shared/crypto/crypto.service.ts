import { Inject, Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';

/**
 * Node's Buffer is a Uint8Array over a possibly shared ArrayBuffer; Prisma's
 * Bytes columns want a plain one. Copying 32 bytes is free and keeps the types
 * honest at the boundary.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

function toBytes(buf: Buffer): Bytes {
  return Uint8Array.from(buf);
}

const MAGIC = 0x43; // 'C'
const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Symmetric crypto for data that must be readable again: TOTP secrets and the
 * recovery-code list (IAM-R-08). Keys come from configuration, never from the
 * database, so a database dump alone does not yield MFA secrets.
 *
 * Framing: MAGIC | VERSION | keyIdLen | keyId | iv(12) | tag(16) | ciphertext
 * The key id travels with the ciphertext so keys can be rotated without a
 * migration: add a new key, flip APP_KEK_ACTIVE, re-encrypt lazily.
 */
@Injectable()
export class CryptoService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Opaque, unguessable token: 256 bits of randomness (IAM-R-09). */
  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  randomDigits(length: number): string {
    let out = '';
    while (out.length < length) {
      for (const byte of randomBytes(length)) {
        if (byte < 250) out += String(byte % 10);
        if (out.length === length) break;
      }
    }
    return out;
  }

  /** Base32 (RFC 4648, no padding) — used for recovery codes and TOTP secrets. */
  randomBase32(bytes: number): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const buf = randomBytes(bytes);
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buf) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        out += alphabet[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
    return out;
  }

  sha256(value: string | Uint8Array): Bytes {
    return toBytes(createHash('sha256').update(value).digest());
  }

  /** Keyed hash for values we only ever compare, never read back (recovery codes). */
  peppered(value: string): Bytes {
    return toBytes(createHmac('sha256', this.config.crypto.hashPepper).update(value).digest());
  }

  equals(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * @param aad Additional authenticated data, e.g. `mfa:<userId>`. Binds the
   *   ciphertext to its row, so copying a blob between users fails to decrypt.
   */
  encrypt(plaintext: string, aad: string): Bytes {
    const keyId = this.config.crypto.activeKekId;
    const key = this.config.crypto.keks[keyId];
    if (!key) throw new Error(`Encryption key ${keyId} is not configured`);

    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const keyIdBuf = Buffer.from(keyId, 'ascii');

    return toBytes(
      Buffer.concat([Buffer.from([MAGIC, VERSION, keyIdBuf.length]), keyIdBuf, iv, tag, ciphertext]),
    );
  }

  decrypt(blob: Buffer | Uint8Array, aad: string): string {
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    if (buf.length < 3 || buf[0] !== MAGIC || buf[1] !== VERSION) {
      throw new Error('Ciphertext is not in the expected format');
    }
    const keyIdLen = buf[2]!;
    let offset = 3;
    const keyId = buf.subarray(offset, offset + keyIdLen).toString('ascii');
    offset += keyIdLen;
    const iv = buf.subarray(offset, offset + IV_LEN);
    offset += IV_LEN;
    const tag = buf.subarray(offset, offset + TAG_LEN);
    offset += TAG_LEN;
    const ciphertext = buf.subarray(offset);

    const key = this.config.crypto.keks[keyId];
    if (!key) throw new Error(`Encryption key ${keyId} is not configured`);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
