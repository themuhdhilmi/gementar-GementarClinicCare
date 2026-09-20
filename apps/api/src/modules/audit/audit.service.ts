import { Injectable } from '@nestjs/common';
import { newId } from '../../shared/ids/uuid.js';
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

/** Keys whose values never reach the audit trail, at any depth (AUD-R-05). */
const REDACT_KEY = /pass|secret|token|hash|recovery|kek|pepper|otp|credential|cookie/i;
const REDACTED = '[redacted]';

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return REDACTED;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACT_KEY.test(key) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function shallowDiff(before: unknown, after: unknown): Record<string, unknown> | null {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return null;
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
 * Minimum viable slice of the AUD module: the write path IAM depends on, plus a
 * narrow read for the admin dashboard. Partitioning, retention and the full
 * query surface arrive with `v0-14-audit-trail.md`.
 *
 * `record` takes the transaction explicitly (AUD-R-02): an audit entry shares
 * the fate of the change it describes. There is no non-transactional overload.
 */
@Injectable()
export class AuditService {
  async record(tx: Tx, actor: AuditActor, entry: AuditEntry): Promise<void> {
    const before = redact(entry.before) ?? null;
    const after = redact(entry.after) ?? null;
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
