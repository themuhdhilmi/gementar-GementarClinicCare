import { Global, Module } from '@nestjs/common';
import { BranchService } from './branch.service.js';
import { TenantService } from './tenant.service.js';
import { BranchDeactivationRegistry } from './branch-deactivation.registry.js';
import { SettingsChangeRegistry } from './settings-change.registry.js';
import { TenancyController } from './tenancy.controller.js';
import { BranchesController } from './branches.controller.js';
import { SettingsService } from './settings/settings.service.js';

@Global()
@Module({
  controllers: [TenancyController, BranchesController],
  providers: [
    TenantService,
    BranchService,
    BranchDeactivationRegistry,
    SettingsChangeRegistry,
    SettingsService,
  ],
  exports: [
    TenantService,
    BranchService,
    BranchDeactivationRegistry,
    SettingsChangeRegistry,
    SettingsService,
  ],
})
export class TenancyModule {}
