import { Injectable, Logger } from '@nestjs/common';
import type { Tx } from '../../shared/prisma/db.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

export type SigningConsultation = {
  id: string;
  encounterId: string;
  patientId: string;
  branchId: string;
  doctorId: string;
};

/**
 * What a module contributes to a signature. Both flags feed the encounter's
 * routing decision: a patient with a prescription goes to the pharmacy, one
 * with a procedure to the treatment room.
 */
export type SignContribution = {
  hasRx?: boolean;
  hasProcedures?: boolean;
};

/**
 * Anything the person signing said as they signed. Today that is only
 * RX-R-04's second confirmation, which is per prescribed item.
 */
export type SignOptions = {
  readonly confirm: readonly string[];
};

export type SignHook = (
  tx: Tx,
  ctx: TenantContext,
  consultation: SigningConsultation,
  options: SignOptions,
) => Promise<SignContribution>;

export type CancelHook = (
  tx: Tx,
  ctx: TenantContext,
  consultation: SigningConsultation,
  reason: string,
) => Promise<void>;

/**
 * CON-R-07: signing a consultation finishes more than the note.
 *
 * A prescription becomes real at the moment the consultation is signed,
 * and a procedure order with it. Neither belongs in the consultation
 * service — it should not know what a prescription is — but both have to
 * happen inside the same transaction, because a signature that half took
 * effect is worse than one that did not.
 *
 * So modules register here and CON asks. A hook may throw: that is how
 * RX blocks a signature when a severe allergy override has not been
 * confirmed (RX-R-04, RX-F-17), and the whole signature rolls back with
 * it, which is the correct outcome.
 */
@Injectable()
export class ConsultationSignRegistry {
  private readonly logger = new Logger(ConsultationSignRegistry.name);
  private readonly hooks = new Map<string, SignHook>();
  private readonly cancelHooks = new Map<string, CancelHook>();

  add(name: string, hook: SignHook): void {
    this.hooks.set(name, hook);
    this.logger.log(`consultation sign hook registered: ${name}`);
  }

  /** Chiefly for tests, which must not leave a hook behind them. */
  remove(name: string): void {
    this.hooks.delete(name);
  }

  get registered(): string[] {
    return [...this.hooks.keys()];
  }

  addCancelHook(name: string, hook: CancelHook): void {
    this.cancelHooks.set(name, hook);
    this.logger.log(`consultation cancel hook registered: ${name}`);
  }

  removeCancelHook(name: string): void {
    this.cancelHooks.delete(name);
  }

  /**
   * A cancelled consultation takes its prescription with it: the
   * pharmacy must not be left holding an order for a visit that was
   * abandoned.
   */
  async runCancel(
    tx: Tx,
    ctx: TenantContext,
    consultation: SigningConsultation,
    reason: string,
  ): Promise<void> {
    for (const hook of this.cancelHooks.values()) {
      await hook(tx, ctx, consultation, reason);
    }
  }

  async run(
    tx: Tx,
    ctx: TenantContext,
    consultation: SigningConsultation,
    options: SignOptions,
  ): Promise<Required<SignContribution>> {
    let hasRx = false;
    let hasProcedures = false;

    for (const [name, hook] of this.hooks) {
      const result = await hook(tx, ctx, consultation, options);
      this.logger.debug(`sign hook ${name}: ${JSON.stringify(result)}`);
      hasRx ||= result.hasRx ?? false;
      hasProcedures ||= result.hasProcedures ?? false;
    }

    return { hasRx, hasProcedures };
  }
}
