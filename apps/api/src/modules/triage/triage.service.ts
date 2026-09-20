import { Injectable } from '@nestjs/common';
import { EncounterStatus, FlagLevel } from '../../generated/prisma/enums.js';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../../shared/errors/domain-errors.js';
import { newId } from '../../shared/ids/uuid.js';
import { Clock } from '../../shared/time/clock.js';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import { EventBus } from '../events/event-bus.service.js';
import { DomainEvent } from '../events/domain-events.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { SettingsService } from '../tenancy/settings/settings.service.js';
import { EncounterService } from '../encounter/encounter.service.js';
import { TERMINAL_STATUSES } from '../encounter/transitions.js';
import { ageInYears } from '../patient/patient.validation.js';
import {
  assertBloodPressure,
  assertPlausible,
  computeBmiX10,
  flagsFor,
  maxLevel,
  thresholdsFor,
  type Thresholds,
  type VitalFlag,
  type VitalName,
} from './vitals.js';

/** What a nurse types, in the units on the form. The service converts. */
export type TriageInput = {
  systolic?: number | null;
  diastolic?: number | null;
  heartRate?: number | null;
  respRate?: number | null;
  /** Degrees Celsius, one decimal place. */
  temperature?: number | null;
  spo2?: number | null;
  /** Kilograms, one decimal place. */
  weightKg?: number | null;
  /** Centimetres. */
  heightCm?: number | null;
  /** mmol/L, one decimal place. */
  glucose?: number | null;
  glucoseFasting?: boolean | null;
  painScore?: number | null;
  complaint?: string | null;
  notes?: string | null;
};

const MEASURED: VitalName[] = [
  'systolic',
  'diastolic',
  'heartRate',
  'respRate',
  'temperatureDc',
  'spo2',
  'weightG',
  'heightMm',
  'glucoseX10',
  'painScore',
];

/**
 * Vitals, taken once, by the nurse.
 *
 * Small module, high clinical value. Three things carry the weight: what is
 * stored is an integer in a fixed unit, what is flagged is decided at save
 * time and written down, and what is locked stays locked.
 */
@Injectable()
export class TriageService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly settings: SettingsService,
    private readonly encounters: EncounterService,
  ) {}

  /** TRI-R-01: the form's units become the stored units, here and nowhere else. */
  private toStored(input: TriageInput) {
    const scale = (value: number | null | undefined, factor: number): number | null =>
      value === null || value === undefined ? null : Math.round(value * factor);

    const stored = {
      systolic: scale(input.systolic, 1),
      diastolic: scale(input.diastolic, 1),
      heartRate: scale(input.heartRate, 1),
      respRate: scale(input.respRate, 1),
      temperatureDc: scale(input.temperature, 10),
      spo2: scale(input.spo2, 1),
      weightG: scale(input.weightKg, 1000),
      heightMm: scale(input.heightCm, 10),
      glucoseX10: scale(input.glucose, 10),
      painScore: scale(input.painScore, 1),
    } satisfies Record<VitalName, number | null>;

    for (const name of MEASURED) {
      const value = stored[name];
      if (value !== null) assertPlausible(name, value);
    }
    assertBloodPressure(stored.systolic, stored.diastolic);

    return stored;
  }

  /** The clinic's adult bands, in the units the readings are stored in. */
  async thresholds(branchId: string): Promise<Thresholds> {
    const v = await this.settings.group(branchId, 'vitals');
    return {
      systolic: {
        low: v.systolicLow,
        high: v.systolicHigh,
        criticalLow: v.systolicCriticalLow,
        criticalHigh: v.systolicCriticalHigh,
      },
      diastolic: {
        low: v.diastolicLow,
        high: v.diastolicHigh,
        criticalHigh: v.diastolicCriticalHigh,
      },
      heartRate: {
        low: v.heartRateLow,
        high: v.heartRateHigh,
        criticalLow: v.heartRateCriticalLow,
        criticalHigh: v.heartRateCriticalHigh,
      },
      respRate: {
        low: v.respRateLow,
        high: v.respRateHigh,
        criticalLow: v.respRateCriticalLow,
        criticalHigh: v.respRateCriticalHigh,
      },
      temperatureDc: {
        low: v.temperatureLowDc,
        high: v.temperatureHighDc,
        criticalLow: v.temperatureCriticalLowDc,
        criticalHigh: v.temperatureCriticalHighDc,
      },
      spo2: { low: v.spo2Low, criticalLow: v.spo2CriticalLow },
      glucoseX10: {
        low: v.glucoseLowX10,
        high: v.glucoseHighX10,
        criticalLow: v.glucoseCriticalLowX10,
        criticalHigh: v.glucoseCriticalHighX10,
      },
      bmi: { low: v.bmiLowX10, high: v.bmiHighX10 },
      painScore: { high: v.painHigh },
    };
  }

  /**
   * TRI-F-01, TRI-F-07: record a set of readings.
   *
   * `advance` sends the patient on to the doctor. The nurse can decline it
   * when a second reading is coming — after a nebuliser, say — and the
   * patient stays at triage rather than being pushed down the corridor and
   * back.
   */
  async record(
    ctx: TenantContext,
    encounterId: string,
    input: TriageInput,
    options: { advance?: boolean; escalate?: boolean } = {},
  ) {
    const tx = this.db.tx();
    const now = this.clock.now();
    const encounter = await this.encounters.getOrThrow(tx, encounterId);

    if (TERMINAL_STATUSES.includes(encounter.status)) {
      throw new BadRequestError(
        'This visit is finished. Vitals belong to the visit they were taken during.',
        'encounter_closed',
      );
    }

    const stored = this.toStored(input);
    const bmiX10 = computeBmiX10(stored.weightG, stored.heightMm);

    // §14: "at least one value", and a note counts. A patient who refuses
    // to be measured is a thing that happened and is worth recording.
    const anyReading =
      MEASURED.some((name) => stored[name] !== null) ||
      Boolean((input.complaint ?? '').trim()) ||
      Boolean((input.notes ?? '').trim());
    if (!anyReading) {
      throw new BadRequestError(
        'Record at least one reading, or a note saying why there is none.',
        'nothing_recorded',
      );
    }

    const patient = await tx.patient.findFirst({
      where: { id: encounter.patientId },
      select: { dateOfBirth: true },
    });
    const age = ageInYears(patient?.dateOfBirth ?? null, now);
    const bands = thresholdsFor(age, await this.thresholds(encounter.branchId));
    const flags = flagsFor({ ...stored, bmi: bmiX10 }, bands);
    const level = maxLevel(flags);

    const previous = await tx.triage.findFirst({
      where: { encounterId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    const sequence = (previous?.sequence ?? 0) + 1;

    const id = newId();
    await tx.triage.create({
      data: {
        id,
        tenantId: requireTenantId(),
        encounterId,
        patientId: encounter.patientId,
        sequence,
        ...stored,
        bmiX10,
        glucoseFasting: input.glucoseFasting ?? null,
        complaint: input.complaint?.trim() || null,
        notes: input.notes?.trim() || null,
        flags: flags as unknown as object,
        maxFlagLevel: level,
        recordedBy: ctx.userId,
        recordedAt: now,
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.TriageRecorded,
      entityType: 'triage',
      entityId: id,
      subjectPatientId: encounter.patientId,
      after: { sequence, maxFlagLevel: level, flags },
    });

    this.events.publish({
      name: DomainEvent.TriageRecorded,
      tenantId: ctx.tenantId,
      branchId: encounter.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { encounterId, triageId: id, maxFlagLevel: level, advance: options.advance ?? true },
    });
    if (level !== FlagLevel.NONE) {
      this.events.publish({
        name: DomainEvent.TriageAbnormalFlagged,
        tenantId: ctx.tenantId,
        branchId: encounter.branchId,
        actorId: ctx.userId,
        occurredAt: now,
        payload: { encounterId, triageId: id, level, flags },
      });
    }

    // TRI-F-08: a critical reading prompts, it does not decide. The nurse
    // is looking at the patient and the system is looking at a number.
    if (options.escalate && level === FlagLevel.CRITICAL) {
      await this.escalate(ctx, encounterId, flags);
    }

    // TRI-F-07. TRI-R-05 says the encounter module owns the transition, and
    // it does: this calls its service rather than writing the status.
    if ((options.advance ?? true) && encounter.status === EncounterStatus.TRIAGE_IN_PROGRESS) {
      await this.encounters.transition(ctx, encounterId, EncounterStatus.DOCTOR_WAITING, {
        note: level === FlagLevel.NONE ? undefined : `Triage flagged ${level.toLowerCase()}`,
      });
    }

    return this.present(await this.getOrThrow(tx, id));
  }

  /** Moves the visit to the front of every queue, and records why. */
  private async escalate(ctx: TenantContext, encounterId: string, flags: VitalFlag[]) {
    const worst = flags.find((flag) => flag.level === 'CRITICAL');
    const reason = worst
      ? `${worst.label} ${worst.threshold} at triage`
      : 'Critical reading at triage';
    const tx = this.db.tx();
    await tx.encounter.update({
      where: { id: encounterId },
      data: { priority: 'EMERGENCY', priorityReason: reason },
    });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.EncounterPriorityChanged,
      entityType: 'encounter',
      entityId: encounterId,
      after: { priority: 'EMERGENCY' },
      reason,
    });
  }

  async getOrThrow(tx: Tx, triageId: string) {
    const triage = await tx.triage.findFirst({ where: { id: triageId } });
    if (!triage) throw new NotFoundError('Triage record');
    return triage;
  }

  /** TRI-F-06: every reading taken during this visit, in order. */
  async forEncounter(tx: Tx, encounterId: string) {
    const rows = await tx.triage.findMany({
      where: { encounterId },
      orderBy: { sequence: 'asc' },
    });
    return rows.map((row) => this.present(row));
  }

  /**
   * TRI-F-04: what to put in the form before the nurse types.
   *
   * Height is a value, because an adult's height does not change and
   * retyping it is a chance to get it wrong. Weight is a hint shown beside
   * the field and never filled in, because weight is the thing being
   * measured today.
   */
  async prefill(tx: Tx, patientId: string, ageYears: number | null) {
    const twelveMonthsAgo = new Date(this.clock.now().getTime() - 365 * 86_400_000);
    const [lastHeight, lastAny] = await Promise.all([
      tx.triage.findFirst({
        where: { patientId, heightMm: { not: null }, recordedAt: { gte: twelveMonthsAgo } },
        orderBy: { recordedAt: 'desc' },
        select: { heightMm: true, recordedAt: true },
      }),
      tx.triage.findFirst({
        where: { patientId },
        orderBy: { recordedAt: 'desc' },
      }),
    ]);

    return {
      // A child's height changes month to month, so it is a hint for them
      // and a value for an adult.
      heightCm:
        lastHeight && (ageYears === null || ageYears >= 12) ? lastHeight.heightMm! / 10 : null,
      lastReading: lastAny ? this.present(lastAny) : null,
    };
  }

  /** TRI-F-09: the last dozen readings of one measurement. */
  async trend(tx: Tx, patientId: string, param: string, limit = 12) {
    const column = TREND_COLUMNS[param];
    if (!column) {
      throw new BadRequestError(
        `"${param}" is not something that is measured. One of: ${Object.keys(TREND_COLUMNS).join(', ')}.`,
        'unknown_vital',
      );
    }
    const rows = await tx.$queryRawUnsafe<Array<{ at: Date; value: number }>>(
      `SELECT recorded_at AS at, ${column} AS value
         FROM triage
        WHERE tenant_id = $1::uuid AND patient_id = $2::uuid AND ${column} IS NOT NULL
        ORDER BY recorded_at DESC
        LIMIT ${Math.min(Math.max(limit, 1), 60)}`,
      requireTenantId(),
      patientId,
    );
    return rows
      .map((row) => ({ at: row.at.toISOString(), value: Number(row.value) }))
      .reverse();
  }

  /** Editable until the consultation is signed (TRI-F-10). */
  async update(ctx: TenantContext, triageId: string, input: TriageInput) {
    const tx = this.db.tx();
    const before = await this.getOrThrow(tx, triageId);
    if (before.lockedAt) {
      throw new ConflictError(
        'The consultation has been signed, so these vitals are part of the record. ' +
          'Amend them instead, with a reason.',
        'triage_locked',
      );
    }

    const encounter = await this.encounters.getOrThrow(tx, before.encounterId);
    const stored = this.toStored(input);
    const bmiX10 = computeBmiX10(stored.weightG, stored.heightMm);
    const patient = await tx.patient.findFirst({
      where: { id: before.patientId },
      select: { dateOfBirth: true },
    });
    const bands = thresholdsFor(
      ageInYears(patient?.dateOfBirth ?? null, this.clock.now()),
      await this.thresholds(encounter.branchId),
    );
    const flags = flagsFor({ ...stored, bmi: bmiX10 }, bands);

    await tx.triage.update({
      where: { id: triageId },
      data: {
        ...stored,
        bmiX10,
        glucoseFasting: input.glucoseFasting ?? null,
        complaint: input.complaint?.trim() || null,
        notes: input.notes?.trim() || null,
        flags: flags as unknown as object,
        maxFlagLevel: maxLevel(flags),
      },
    });

    const after = await this.getOrThrow(tx, triageId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.TriageRecorded,
      entityType: 'triage',
      entityId: triageId,
      subjectPatientId: before.patientId,
      before: this.present(before),
      after: this.present(after),
    });
    return this.present(after);
  }

  /**
   * TRI-F-10, TRI-T-06: a correction after the record was locked.
   *
   * The original values stay in the row and the amendment records what was
   * changed, by whom and why. That is the same shape the consultation will
   * use, and the reason both exist: a clinical record that can be quietly
   * edited is not a record.
   */
  async amend(ctx: TenantContext, triageId: string, input: TriageInput, reason: string) {
    const tx = this.db.tx();
    const before = await this.getOrThrow(tx, triageId);
    if (!before.lockedAt) {
      throw new BadRequestError(
        'This record is not locked yet, so it can simply be corrected.',
        'not_locked',
      );
    }
    if (!reason.trim()) {
      throw new BadRequestError('An amendment needs a reason.', 'reason_required');
    }

    const stored = this.toStored(input);
    const bmiX10 = computeBmiX10(stored.weightG, stored.heightMm);
    const current = {
      ...stored,
      bmiX10,
      complaint: input.complaint?.trim() || null,
      notes: input.notes?.trim() || null,
    };

    const id = newId();
    await tx.triageAmendment.create({
      data: {
        id,
        tenantId: requireTenantId(),
        triageId,
        amendedBy: ctx.userId,
        amendedAt: this.clock.now(),
        reason: reason.trim(),
        previous: this.present(before) as unknown as object,
        current: current as unknown as object,
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.TriageAmended,
      entityType: 'triage',
      entityId: triageId,
      subjectPatientId: before.patientId,
      before: this.present(before),
      after: current,
      reason,
    });
    this.events.publish({
      name: DomainEvent.TriageAmended,
      tenantId: ctx.tenantId,
      branchId: null,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { triageId, amendmentId: id },
    });

    return { triage: this.present(before), amendments: await this.amendments(tx, triageId) };
  }

  async amendments(tx: Tx, triageId: string) {
    return tx.triageAmendment.findMany({
      where: { triageId },
      orderBy: { amendedAt: 'asc' },
    });
  }

  /**
   * Locks every triage record for an encounter. Called when the
   * consultation is signed; `CON` does not exist yet, so nothing calls it.
   */
  async lockForEncounter(tx: Tx, encounterId: string): Promise<number> {
    const result = await tx.triage.updateMany({
      where: { encounterId, lockedAt: null },
      data: { lockedAt: this.clock.now() },
    });
    return result.count;
  }

  /** Back into the units the form and the doctor use. */
  present(row: Awaited<ReturnType<TriageService['getOrThrow']>>) {
    return {
      id: row.id,
      encounterId: row.encounterId,
      patientId: row.patientId,
      sequence: row.sequence,
      systolic: row.systolic,
      diastolic: row.diastolic,
      heartRate: row.heartRate,
      respRate: row.respRate,
      temperature: row.temperatureDc === null ? null : row.temperatureDc / 10,
      spo2: row.spo2,
      weightKg: row.weightG === null ? null : row.weightG / 1000,
      heightCm: row.heightMm === null ? null : row.heightMm / 10,
      bmi: row.bmiX10 === null ? null : row.bmiX10 / 10,
      glucose: row.glucoseX10 === null ? null : row.glucoseX10 / 10,
      glucoseFasting: row.glucoseFasting,
      painScore: row.painScore,
      complaint: row.complaint,
      notes: row.notes,
      flags: row.flags as unknown as VitalFlag[],
      maxFlagLevel: row.maxFlagLevel,
      recordedBy: row.recordedBy,
      recordedAt: row.recordedAt.toISOString(),
      locked: row.lockedAt !== null,
    };
  }
}

/** What a trend can be drawn for, and which column holds it. */
const TREND_COLUMNS: Record<string, string> = {
  systolic: 'systolic',
  diastolic: 'diastolic',
  heartRate: 'heart_rate',
  respRate: 'resp_rate',
  temperature: 'temperature_dc',
  spo2: 'spo2',
  weight: 'weight_g',
  height: 'height_mm',
  bmi: 'bmi_x10',
  glucose: 'glucose_x10',
  painScore: 'pain_score',
};
