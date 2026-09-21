import { Injectable, Logger } from '@nestjs/common';
import type { Tx } from '../../shared/prisma/db.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/** What billing needs to know to put a line on an invoice. */
export type ChargeInput = {
  encounterId: string;
  branchId: string;
  patientId: string;
  lineType: 'CONSULTATION' | 'MEDICINE' | 'PROCEDURE' | 'DOCUMENT';
  /** Where it came from, so the line can be traced and later removed. */
  sourceType: string;
  sourceId: string;
  description: string;
  quantity: number;
  quantityUnit?: string | null;
  /**
   * Sen. Null means "billing decides" — used by the consultation fee,
   * which comes from the fee schedule rather than from the clinical
   * module. Everything else brings its own snapshot price, because the
   * price that was charged is a property of the thing that happened.
   */
  unitPriceSen: bigint | null;
  taxCode?: string | null;
  /** Only for a consultation fee, to pick the fee-schedule rule. */
  encounterType?: string | null;
  doctorId?: string | null;
  occurredAt?: Date;
};

export type ChargeRecorder = (tx: Tx, ctx: TenantContext, input: ChargeInput) => Promise<void>;
export type ChargeRemover = (
  tx: Tx,
  ctx: TenantContext,
  source: { sourceType: string; sourceId: string },
) => Promise<void>;

/**
 * How a clinical module tells billing that something is chargeable.
 *
 * This is deliberately **not** the event bus. Events here are published
 * after commit and a failing subscriber is only logged — which is right
 * for a notification and wrong for money. A dispense that committed and
 * then failed to bill would take the medicine off the shelf and charge
 * nothing, and the only trace would be a line in a log nobody reads.
 *
 * So the charge is recorded inside the same transaction as the thing
 * being charged for: both happen or neither does. The dependency still
 * points the right way, because the clinical modules know only about
 * this registry, and billing is what fills it in.
 *
 * With nothing registered every call is a no-op, which is exactly right
 * for the months this system ran before billing existed.
 */
@Injectable()
export class ChargeRegistry {
  private readonly logger = new Logger(ChargeRegistry.name);
  private recorder: ChargeRecorder | null = null;
  private remover: ChargeRemover | null = null;

  register(recorder: ChargeRecorder, remover: ChargeRemover): void {
    this.recorder = recorder;
    this.remover = remover;
    this.logger.log('billing registered as the charge recorder');
  }

  get available(): boolean {
    return this.recorder !== null;
  }

  /** Called inside the caller's transaction. Throws if billing throws. */
  async record(tx: Tx, ctx: TenantContext, input: ChargeInput): Promise<void> {
    if (!this.recorder) return;
    await this.recorder(tx, ctx, input);
  }

  /** The thing that was charged for has been undone. */
  async remove(
    tx: Tx,
    ctx: TenantContext,
    source: { sourceType: string; sourceId: string },
  ): Promise<void> {
    if (!this.remover) return;
    await this.remover(tx, ctx, source);
  }
}
