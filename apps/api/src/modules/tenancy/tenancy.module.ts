import { Global, Module } from '@nestjs/common';
import { BranchService } from './branch.service.js';
import { TenantService } from './tenant.service.js';

@Global()
@Module({
  providers: [TenantService, BranchService],
  exports: [TenantService, BranchService],
})
export class TenancyModule {}
