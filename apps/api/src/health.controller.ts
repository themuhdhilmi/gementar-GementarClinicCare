import { Controller, Get } from '@nestjs/common';
import { Public } from './modules/identity/decorators/auth.decorators.js';
import { PrismaService, RLS_PROTECTED_TABLES } from './shared/prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Public()
  async health() {
    const rls = await this.prisma.readRlsStatus();
    const isolated =
      rls.unprotected.length === 0 &&
      rls.unexpected.length === 0 &&
      !rls.role.bypassRls &&
      !rls.role.superuser;

    return {
      status: 'ok',
      database: 'up',
      tenantIsolation: {
        rowLevelSecurity: `${rls.protected.length}/${RLS_PROTECTED_TABLES.length} tables`,
        // Loud on purpose: a role that bypasses policies makes the layer
        // decorative, and that is not something to discover during an incident.
        role: rls.role.superuser
          ? 'superuser — row-level security is bypassed'
          : rls.role.bypassRls
            ? 'BYPASSRLS — row-level security is bypassed'
            : 'unprivileged',
        ...(rls.unprotected.length > 0 ? { unprotected: rls.unprotected } : {}),
        ...(rls.unexpected.length > 0 ? { unclassified: rls.unexpected } : {}),
        enforced: isolated,
      },
      time: new Date().toISOString(),
    };
  }
}
