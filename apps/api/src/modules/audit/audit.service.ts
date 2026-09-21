import { Injectable } from '@nestjs/common';
import { newId } from '../../shared/ids/uuid.js';
import { noteAuditWrite } from './audit.request.js';
import type { Tx } from '../../shared/prisma/db.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { AuditActionName } from './audit.actions.js';

export type AuditActor = {
  tenantId: string;
  branchId?: string | null;
  actorId?: string | null;
  actorName: string;
  actorRole?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
};

export type AuditEntry = {
  action: AuditActionName;
  entityType: string;
  entityId?: string | null;
  subjectPatientId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
};

/**
 * AUD-N-05: how much of an entity one side of an entry may carry.
 *
 * A snapshot is evidence, not a backup. Past a point it stops being
 * either — nobody reads a 400 KB JSON blob in a diff view, and a table
 * that stores one per write grows faster than the records it describes.
 * What replaces it says plainly that it was dropped and how big it was,
 * because "this field is missing" and "this field was too large to keep"
 * are different facts.
 */
const MAX_SNAPSHOT_BYTES = 64 * 1024;

function cap(value: unknown, side: 'before' | 'after'): unknown {
  if (value === null || value === undefined) return value;
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length <= MAX_SNAPSHOT_BYTES)
    return value;
  return {
    _truncated: true,
    _side: side,
    _bytes: encoded.length,
    _why: `over the ${MAX_SNAPSHOT_BYTES}-byte snapshot cap (AUD-N-05)`,
  };
}

/** Keys whose values never reach the audit trail, at any depth (AUD-R-05). */
const REDACT_KEY =
  /pass|secret|token|hash|recovery|kek|pepper|otp|credential|cookie/i;
const REDACTED = '[redacted]';

/**
 * Whether this is an object we can safely walk key by key.
 *
 * A class instance is not. Prisma's `Decimal` is the one that caught us:
 * walking it produced `{ constructor, s, e, d }`, and `constructor` is a
 * function, which the driver then refused to store — turning a
 * successful request into a 500 at the very last step. An audit entry
 * has to be JSON somebody can read in five years, so anything that is
 * not a plain object gets one chance to say what it is (`toJSON`) and is
 * otherwise stringified.
 */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return REDACTED;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return REDACTED;
  if (typeof value === 'object') {
    if (!isPlainObject(value)) {
      const custom = (value as { toJSON?: () => unknown }).toJSON;
      if (typeof custom === 'function')
        return redact(custom.call(value), depth + 1);
      return String(value);
    }
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACT_KEY.test(key) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function shallowDiff(
  before: unknown,
  after: unknown,
): Record<string, unknown> | null {
  if (
    !before ||
    !after ||
    typeof before !== 'object' ||
    typeof after !== 'object'
  )
    return null;
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const diff: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const from = b[key];
    const to = a[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) diff[key] = { from, to };
  }
  return Object.keys(diff).length ? diff : null;
}

/**
 * The write path (AUD, v0-14-audit-trail.md).
 *
 * `record` takes the transaction explicitly (AUD-R-02): an audit entry shares
 * the fate of the change it describes. There is no non-transactional overload,
 * and §14 is blunt about why — if the audit insert fails, the change rolls
 * back. Audit is not best-effort. A system that would rather lose the record
 * of what happened than the thing that happened has the priority backwards.
 */
@Injectable()
export class AuditService {
  async record(tx: Tx, actor: AuditActor, entry: AuditEntry): Promise<void> {
    // Redact first, then cap. The other order would measure secrets
    // towards the limit and could drop an entry for being large with
    // material in it that was never going to be stored anyway.
    const before = cap(redact(entry.before) ?? null, 'before');
    const after = cap(redact(entry.after) ?? null, 'after');
    await tx.auditLog.create({
      data: {
        id: newId(),
        tenantId: actor.tenantId,
        branchId: actor.branchId ?? null,
        actorId: actor.actorId ?? null,
        // Snapshot, so the entry still reads correctly after a rename (AUD-R-06).
        actorName: actor.actorName.slice(0, 120),
        actorRole: actor.actorRole ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        subjectPatientId: entry.subjectPatientId ?? null,
        before: before === null ? undefined : (before as object),
        after: after === null ? undefined : (after as object),
        diff: (shallowDiff(before, after) ?? undefined) as object | undefined,
        reason: entry.reason?.slice(0, 500) ?? null,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent?.slice(0, 512) ?? null,
        requestId: actor.requestId ?? null,
      },
    });
    // So the interceptor knows this request did not go unrecorded.
    noteAuditWrite();
  }

  actorFromContext(ctx: TenantContext): AuditActor {
    return {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      actorName: ctx.userName,
      actorRole: ctx.roles.join(','),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    };
  }
}
