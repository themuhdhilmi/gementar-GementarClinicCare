import { Controller, Get, Module, Param, Post } from '@nestjs/common';
import { Ctx, Public, RequirePermission } from '../../src/modules/identity/decorators/auth.decorators.js';
import type { TenantContext } from '../../src/modules/tenancy/tenant-context.js';

/**
 * A stand-in for the modules that do not exist yet. It exists so the
 * authorisation behaviour IAM promises to them — permission checks per branch,
 * break-glass auditing, and the front-desk split — can be tested for real
 * rather than asserted about.
 */
@Controller('clinical-probe')
export class ClinicalProbeController {
  /** Two routes that do nothing, so the auth guard can be timed on its own. */
  @Get('ping')
  @Public()
  ping() {
    return { ok: true };
  }

  @Get('ping-auth')
  pingAuthenticated(@Ctx() ctx: TenantContext) {
    return { ok: true, userId: ctx.userId };
  }

  @Get('records/:patientId')
  @RequirePermission('clinical.read')
  read(@Ctx() ctx: TenantContext, @Param('patientId') patientId: string) {
    return { patientId, branchId: ctx.branchId, roles: ctx.roles };
  }

  @Post('records/:patientId/notes')
  @RequirePermission('clinical.write')
  write(@Ctx() ctx: TenantContext, @Param('patientId') patientId: string) {
    return { patientId, branchId: ctx.branchId, written: true };
  }

  @Post('payment')
  @RequirePermission('payment.take')
  takePayment(@Ctx() ctx: TenantContext) {
    return { taken: true, branchId: ctx.branchId };
  }

  @Post('dispense')
  @RequirePermission('dispense.perform')
  dispense(@Ctx() ctx: TenantContext) {
    return { dispensed: true, branchId: ctx.branchId };
  }

  @Post('undeclared')
  undeclared() {
    // Deliberately missing a permission declaration: the guard must refuse it
    // even though CI would normally have caught it first (IAM-R-03).
    return { reached: true };
  }
}

@Module({ controllers: [ClinicalProbeController] })
export class ClinicalProbeModule {}
