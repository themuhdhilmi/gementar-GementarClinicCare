import { Module } from '@nestjs/common';
import { EncounterModule } from '../encounter/encounter.module.js';
import { TriageController } from './triage.controller.js';
import { TriageService } from './triage.service.js';

/**
 * Triage / Nurse Station (TRI, v0-05-triage.md).
 *
 * Exported because the consultation reads the vitals it is based on, and
 * prescribing reads the weight to work out a child's dose.
 */
@Module({
  imports: [EncounterModule],
  controllers: [TriageController],
  providers: [TriageService],
  exports: [TriageService],
})
export class TriageModule {}
