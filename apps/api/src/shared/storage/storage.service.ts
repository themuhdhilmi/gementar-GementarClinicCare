import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { NotFoundError } from '../errors/domain-errors.js';
import { assertOutsideScope } from '../prisma/tenant-scope.js';

/**
 * Where uploaded files live.
 *
 * V0 writes to a directory on the server. There is no object storage yet and
 * buying one to hold a few thousand scanned identity cards would be a cost
 * without a benefit. What matters is that the rest of the application never
 * learns which it is: everything goes through a key and this service, so
 * moving to S3 later is a new driver and a copy, not a change to PAT.
 *
 * Two rules the filesystem does not give for free:
 *
 *   - **Keys are ours, not the user's.** A filename from a browser is a
 *     string an attacker chose, and `../../etc/passwd` is a valid one. The
 *     key is generated here and the original name is only ever metadata.
 *   - **Tenants cannot reach each other's files.** The key starts with the
 *     tenant id and reads verify it, so a guessed key from another clinic
 *     fails the same way a row would.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private get root(): string {
    return resolve(this.config.storage.root);
  }

  /**
   * An opaque key under the tenant's own prefix.
   *
   * The extension is carried for the sake of anyone looking at the directory
   * during an incident; nothing reads it back, because the media type is in
   * the database where it cannot be renamed.
   */
  newKey(tenantId: string, kind: string, extension: string): string {
    const safeExtension = /^[a-z0-9]{1,8}$/.test(extension) ? extension : 'bin';
    const day = new Date().toISOString().slice(0, 10);
    return `${tenantId}/${kind}/${day}/${randomBytes(16).toString('hex')}.${safeExtension}`;
  }

  /** Resolves a key to a path, refusing anything that escapes the root. */
  private pathFor(key: string, tenantId: string): string {
    if (!key.startsWith(`${tenantId}/`)) {
      throw new NotFoundError('File');
    }
    const target = resolve(join(this.root, normalize(key)));
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      // A key that climbs out of the root is not a missing file, it is an
      // attempt. It is logged and answered as if the file were simply absent.
      this.logger.warn(`Refused a storage key that escapes the root: ${key}`);
      throw new NotFoundError('File');
    }
    return target;
  }

  async put(key: string, tenantId: string, bytes: Buffer): Promise<void> {
    // Writing a file is slow work and must not happen inside a transaction
    // (TEN-F-17): a 20 MB upload would hold a database connection for it.
    assertOutsideScope('Writing an uploaded file');
    const path = this.pathFor(key, tenantId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o600 });
  }

  async get(key: string, tenantId: string): Promise<Buffer> {
    const path = this.pathFor(key, tenantId);
    try {
      return await readFile(path);
    } catch {
      throw new NotFoundError('File');
    }
  }

  async remove(key: string, tenantId: string): Promise<void> {
    await rm(this.pathFor(key, tenantId), { force: true });
  }

  /**
   * PAT-N-04: a link that works for five minutes and then does not.
   *
   * Object storage would sign this; with a local store the application is
   * the only thing that can serve the bytes, so the signature is ours. It
   * covers the key, the expiry and the tenant, so a token cannot be edited
   * to reach a different file or to last longer.
   */
  signKey(key: string, tenantId: string, ttlSeconds = 300): { token: string; expiresAt: Date } {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload = `${tenantId}:${key}:${expires}`;
    const signature = this.sign(payload);
    const token = Buffer.from(`${expires}.${signature}`, 'utf8').toString('base64url');
    return { token, expiresAt: new Date(expires * 1000) };
  }

  verifyKey(key: string, tenantId: string, token: string): boolean {
    let decoded: string;
    try {
      decoded = Buffer.from(token, 'base64url').toString('utf8');
    } catch {
      return false;
    }
    const [expiresRaw, signature] = decoded.split('.');
    const expires = Number(expiresRaw);
    if (!expiresRaw || !signature || !Number.isFinite(expires)) return false;
    if (expires < Math.floor(Date.now() / 1000)) return false;

    const expected = this.sign(`${tenantId}:${key}:${expires}`);
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private sign(payload: string): string {
    return createHash('sha256')
      .update(this.config.crypto.hashPepper)
      .update(payload)
      .digest('base64url');
  }
}
