import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { EncounterStatus } from '../../generated/prisma/enums.js';
import { NotFoundError } from '../../shared/errors/domain-errors.js';
import { newId } from '../../shared/ids/uuid.js';
import { Clock } from '../../shared/time/clock.js';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { SettingsService } from '../tenancy/settings/settings.service.js';

/**
 * What a screen in the waiting room shows.
 *
 * Everything here is visible to whoever is sitting in the room, which is the
 * entire design constraint (ENC-R-10). A queue number is not a person. A
 * first name and an initial is a compromise a clinic may choose, and the
 * setting exists because some will and some will not.
 */
export type DisplayView = {
  branch: { name: string; code: string };
  nowServing: Array<{ queueNo: string; label: string | null; where: string }>;
  waiting: Array<{ queueNo: string; label: string | null }>;
  recentlyCalled: Array<{
    queueNo: string;
    label: string | null;
    where: string;
    at: string;
  }>;
  waitingCount: number;
  at: string;
};

/**
 * The waiting-room screen, and the token that lets it in.
 *
 * A television in a public room cannot hold a password, so it holds a token
 * in its address bar instead. The token is stored hashed, for the same
 * reason a session token is: the database is the thing most likely to be
 * copied, and a stolen display token shows a stranger the queue.
 *
 * It grants exactly one thing — the queue numbers at one branch — and it is
 * rotatable, because a screen in a public room will eventually be
 * photographed.
 */
@Injectable()
export class DisplayService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  private hash(token: string): Buffer {
    return createHash('sha256').update(token).digest();
  }

  async issue(ctx: TenantContext, branchId: string, label: string) {
    const tx = this.db.tx();
    // 32 bytes: it is in a URL on a screen and never typed, so length costs
    // nothing and guessing must be hopeless.
    const token = randomBytes(32).toString('base64url');
    const id = newId();

    await tx.displayToken.create({
      data: {
        id,
        tenantId: requireTenantId(),
        branchId,
        tokenHash: Uint8Array.from(this.hash(token)),
        label: label.trim() || 'Waiting room',
        createdBy: ctx.userId,
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.DisplayTokenIssued,
      entityType: 'display_token',
      entityId: id,
      after: { branchId, label },
    });

    // Shown once. It is not recoverable afterwards, which is what makes
    // storing the hash worth anything.
    return { id, token, label };
  }

  async list(tx: Tx, branchId: string) {
    return tx.displayToken.findMany({
      where: { branchId, revokedAt: null },
      select: { id: true, label: true, createdAt: true, lastSeenAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revoke(ctx: TenantContext, tokenId: string) {
    const tx = this.db.tx();
    const token = await tx.displayToken.findFirst({
      where: { id: tokenId, revokedAt: null },
    });
    if (!token) throw new NotFoundError('Display token');

    await tx.displayToken.update({
      where: { id: tokenId },
      data: { revokedAt: this.clock.now() },
    });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.DisplayTokenRevoked,
      entityType: 'display_token',
      entityId: tokenId,
      before: { label: token.label },
    });
    // The old address stops working on the next request, which is what
    // "rotate" has to mean for a screen somebody photographed.
    return { revoked: true };
  }

  /**
   * Turns a token into a branch.
   *
   * Runs in platform scope, because the request arrives with no session and
   * therefore no tenant. The bypass policy on `display_token` is the only
   * one outside identity, and it reaches exactly this one table; everything
   * afterwards happens inside the branch's own tenant scope.
   */
  async resolve(
    token: string,
  ): Promise<{ tenantId: string; branchId: string; id: string }> {
    const hash = Uint8Array.from(this.hash(token));
    const found = await this.db.withPlatform(
      'resolve a waiting-room display token',
      (tx) =>
        tx.displayToken.findFirst({
          where: { tokenHash: hash, revokedAt: null },
          select: { id: true, tenantId: true, branchId: true },
        }),
    );
    if (!found) throw new NotFoundError('Display');
    return found;
  }

  /** ENC-F-20, ENC-R-10: the view itself, with nothing on it that identifies. */
  async view(branchId: string): Promise<DisplayView> {
    const tx = this.db.tx();
    const now = this.clock.now();
    const { displayShowFirstName } = await this.settings.group(
      branchId,
      'queue',
    );

    const branch = await tx.branch.findFirst({
      where: { id: branchId },
      select: { name: true, code: true },
    });
    if (!branch) throw new NotFoundError('Branch');

    const rows = await tx.encounter.findMany({
      where: {
        branchId,
        status: {
          in: [
            EncounterStatus.TRIAGE_WAITING,
            EncounterStatus.TRIAGE_IN_PROGRESS,
            EncounterStatus.DOCTOR_WAITING,
            EncounterStatus.IN_CONSULTATION,
            EncounterStatus.PHARMACY_WAITING,
            EncounterStatus.DISPENSING,
            EncounterStatus.PAYMENT_WAITING,
          ],
        },
      },
      select: {
        queueNo: true,
        status: true,
        statusSince: true,
        calledAt: true,
        priority: true,
        patient: { select: { name: true } },
        room: { select: { name: true } },
      },
      orderBy: [{ statusSince: 'asc' }],
      take: 200,
    });

    /**
     * A first name and an initial, or nothing at all.
     *
     * "Ahmad bin Zulkifli" becomes "Ahmad Z." — enough for somebody half
     * asleep in a plastic chair to recognise themselves, and not enough for
     * a stranger to write down. Off entirely if the clinic prefers.
     */
    const label = (name: string): string | null => {
      if (!displayShowFirstName) return null;
      const parts = name
        .trim()
        .split(/\s+/)
        .filter((part) => !PARTICLES.has(part.toLowerCase()));
      const first = parts[0] ?? '';
      const last = parts.length > 1 ? parts.at(-1)! : '';
      return last ? `${first} ${last[0]!.toUpperCase()}.` : first;
    };

    const BEING_SEEN: readonly EncounterStatus[] = [
      EncounterStatus.TRIAGE_IN_PROGRESS,
      EncounterStatus.IN_CONSULTATION,
      EncounterStatus.DISPENSING,
    ];
    const serving = rows.filter((row) => BEING_SEEN.includes(row.status));
    const waiting = rows.filter((row) => !serving.includes(row));

    return {
      branch: { name: branch.name, code: branch.code },
      nowServing: serving.map((row) => ({
        queueNo: row.queueNo,
        label: label(row.patient.name),
        where: row.room?.name ?? whereFor(row.status),
      })),
      waiting: waiting
        .sort((a, b) => {
          const rank = (p: string) =>
            p === 'EMERGENCY' ? 0 : p === 'URGENT' ? 1 : 2;
          return (
            rank(a.priority) - rank(b.priority) ||
            a.statusSince.getTime() - b.statusSince.getTime()
          );
        })
        .slice(0, 12)
        .map((row) => ({
          queueNo: row.queueNo,
          label: label(row.patient.name),
        })),
      recentlyCalled: rows
        .filter((row) => row.calledAt)
        .sort((a, b) => b.calledAt!.getTime() - a.calledAt!.getTime())
        .slice(0, 5)
        .map((row) => ({
          queueNo: row.queueNo,
          label: label(row.patient.name),
          where: row.room?.name ?? whereFor(row.status),
          at: row.calledAt!.toISOString(),
        })),
      waitingCount: waiting.length,
      at: now.toISOString(),
    };
  }

  async touch(tokenId: string, tenantId: string): Promise<void> {
    await this.db.withTenantIndependently(
      tenantId,
      'display token last seen',
      (tx) =>
        tx.displayToken.update({
          where: { id: tokenId },
          data: { lastSeenAt: this.clock.now() },
        }),
    );
  }
}

/** Malaysian name particles, which are not part of what someone is called. */
const PARTICLES = new Set([
  'bin',
  'binti',
  'bt',
  'bte',
  'a/l',
  'a/p',
  's/o',
  'd/o',
  '@',
]);

function whereFor(status: EncounterStatus): string {
  switch (status) {
    case EncounterStatus.TRIAGE_IN_PROGRESS:
      return 'Triage';
    case EncounterStatus.IN_CONSULTATION:
      return 'Consultation';
    case EncounterStatus.DISPENSING:
      return 'Pharmacy';
    case EncounterStatus.PAYMENT_WAITING:
      return 'Payment';
    default:
      return 'Waiting';
  }
}
