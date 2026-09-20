import { Injectable } from '@nestjs/common';
import { TemplateScope } from '../../generated/prisma/enums.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../shared/errors/domain-errors.js';
import { newId } from '../../shared/ids/uuid.js';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

export type TemplateContent = {
  chiefComplaint?: string;
  hpi?: string;
  history?: string;
  examination?: string;
  planText?: string;
  diagnoses?: Array<{ description: string; icd10Code?: string | null }>;
};

export type TemplateInput = {
  name: string;
  keywords?: string[];
  content: TemplateContent;
  scope?: TemplateScope;
  active?: boolean;
};

/**
 * CON-F-07: a starting point for a presentation the doctor sees weekly.
 *
 * The point is the twenty seconds it saves, thirty times a day. The danger
 * is a doctor signing a template rather than a consultation, so nothing
 * here signs, nothing is applied without the doctor pressing something, and
 * applying one is recorded on the record (CON-R-09).
 */
@Injectable()
export class TemplateService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** A doctor's own templates, and the clinic's. */
  async list(tx: Tx, userId: string) {
    return tx.clinicalTemplate.findMany({
      where: {
        active: true,
        OR: [{ scope: TemplateScope.TENANT }, { scope: TemplateScope.USER, ownerId: userId }],
      },
      orderBy: [{ scope: 'asc' }, { name: 'asc' }],
    });
  }

  async getOrThrow(tx: Tx, id: string) {
    const template = await tx.clinicalTemplate.findFirst({ where: { id } });
    if (!template) throw new NotFoundError('Template');
    return template;
  }

  private assertMayEdit(ctx: TenantContext, template: { scope: TemplateScope; ownerId: string | null }) {
    if (template.scope === TemplateScope.USER && template.ownerId === ctx.userId) return;
    if (template.scope === TemplateScope.TENANT && ctx.permissions.has('admin.settings')) return;
    throw new ForbiddenError(
      template.scope === TemplateScope.TENANT
        ? 'Clinic templates are managed by an administrator.'
        : 'That template belongs to another doctor.',
    );
  }

  /**
   * Who may manage templates at all.
   *
   * Two different people with two different permissions: a doctor keeping
   * their own, and an administrator keeping the clinic's. The route guard
   * takes one permission, so the route declares this explicitly and the
   * check lives here, where the distinction between the two scopes is.
   */
  private assertMayManage(ctx: TenantContext) {
    if (ctx.permissions.has('clinical.write') || ctx.permissions.has('admin.settings')) return;
    throw new ForbiddenError('Templates are managed by a doctor or an administrator.');
  }

  async create(ctx: TenantContext, input: TemplateInput) {
    const tx = this.db.tx();
    this.assertMayManage(ctx);
    const scope = input.scope ?? TemplateScope.USER;
    if (scope === TemplateScope.TENANT && !ctx.permissions.has('admin.settings')) {
      throw new ForbiddenError('Only an administrator creates a template for the whole clinic.');
    }
    if (scope === TemplateScope.USER && !ctx.permissions.has('clinical.write')) {
      throw new ForbiddenError(
        'A personal template belongs to a doctor. Make it a clinic template instead.',
      );
    }
    const name = input.name.trim();
    if (name.length < 2) throw new BadRequestError('A template needs a name.', 'invalid_name');

    const id = newId();
    await tx.clinicalTemplate.create({
      data: {
        id,
        tenantId: requireTenantId(),
        scope,
        ownerId: scope === TemplateScope.USER ? ctx.userId : null,
        name,
        keywords: (input.keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean),
        content: input.content as unknown as object,
        active: input.active ?? true,
        createdBy: ctx.userId,
      },
    });
    return this.getOrThrow(tx, id);
  }

  async update(ctx: TenantContext, id: string, input: Partial<TemplateInput>) {
    const tx = this.db.tx();
    this.assertMayManage(ctx);
    const before = await this.getOrThrow(tx, id);
    this.assertMayEdit(ctx, before);

    await tx.clinicalTemplate.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.keywords === undefined
          ? {}
          : { keywords: input.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean) }),
        ...(input.content === undefined ? {} : { content: input.content as unknown as object }),
        ...(input.active === undefined ? {} : { active: input.active }),
      },
    });
    return this.getOrThrow(tx, id);
  }

  async retire(ctx: TenantContext, id: string) {
    const tx = this.db.tx();
    this.assertMayManage(ctx);
    const before = await this.getOrThrow(tx, id);
    this.assertMayEdit(ctx, before);
    // Retired, not deleted: consultations point at the template they were
    // written from, and a chart from last year should still say so.
    await tx.clinicalTemplate.update({ where: { id }, data: { active: false } });
    return { retired: true };
  }

  /**
   * Fills the empty sections of a draft, and never overwrites one.
   *
   * A doctor who has already typed something has said more than a template
   * can. Overwriting it would be the single most infuriating thing this
   * screen could do.
   */
  async apply(ctx: TenantContext, consultationId: string, templateId: string) {
    const tx = this.db.tx();
    const template = await this.getOrThrow(tx, templateId);
    const content = template.content as TemplateContent;

    const consultation = await tx.consultation.findFirst({
      where: { id: consultationId },
      select: {
        id: true,
        status: true,
        doctorId: true,
        patientId: true,
        chiefComplaint: true,
        hpi: true,
        history: true,
        examination: true,
        planText: true,
      },
    });
    if (!consultation) throw new NotFoundError('Consultation');
    if (consultation.doctorId !== ctx.userId) {
      throw new ForbiddenError('This consultation belongs to another doctor.');
    }
    if (consultation.status !== 'DRAFT') {
      throw new BadRequestError('This consultation has been signed.', 'consultation_signed');
    }

    const data: Record<string, unknown> = { templateId };
    const filled: string[] = [];
    for (const field of ['chiefComplaint', 'hpi', 'history', 'examination', 'planText'] as const) {
      const existing = consultation[field];
      const offered = content[field];
      if (offered && !(existing ?? '').trim()) {
        data[field] = offered;
        filled.push(field);
      }
    }
    await tx.consultation.update({ where: { id: consultationId }, data });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.TemplateUsed,
      entityType: 'consultation',
      entityId: consultationId,
      subjectPatientId: consultation.patientId,
      after: { templateId, name: template.name, filled },
    });

    return {
      filled,
      // Left alone because the doctor had already written there. Reported
      // so the screen can say so rather than appearing to have done nothing.
      skipped: (['chiefComplaint', 'hpi', 'history', 'examination', 'planText'] as const).filter(
        (field) => content[field] && !filled.includes(field),
      ),
      suggestedDiagnoses: content.diagnoses ?? [],
    };
  }
}
