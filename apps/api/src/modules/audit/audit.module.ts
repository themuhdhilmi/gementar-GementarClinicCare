import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditService } from './audit.service.js';
import { AuditQueryService } from './audit.query.service.js';
import { AuditController } from './audit.controller.js';
import { AuditInterceptor } from './audit.interceptor.js';
import { AuditPartitionJob } from './partition.job.js';

/**
 * The audit trail (AUD, v0-14-audit-trail.md).
 *
 * Global, because every module writes to it and none should have to
 * import it to do so. The interceptor registered here is the backstop
 * described in `audit.interceptor.ts`; it must run inside the
 * per-request transaction, which is why `app.module.ts` imports this
 * module after `IdentityModule`.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [
    AuditService,
    AuditQueryService,
    AuditPartitionJob,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditService],
})
export class AuditModule {}
