import { Controller, Get } from '@nestjs/common';
import { Public } from './modules/identity/decorators/auth.decorators.js';
import { PrismaService } from './shared/prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Public()
  async health() {
    const guards = await this.prisma.assertDatabaseGuards();
    return {
      status: 'ok',
      database: 'up',
      tenantWriteGuards: `${guards.installed}/${guards.expected}`,
      time: new Date().toISOString(),
    };
  }
}
