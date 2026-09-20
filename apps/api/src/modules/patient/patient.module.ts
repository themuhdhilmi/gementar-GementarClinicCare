import { Module } from '@nestjs/common';
import { StorageService } from '../../shared/storage/storage.service.js';
import { PatientsController } from './patients.controller.js';
import { PatientService } from './patient.service.js';
import { PatientSearchService } from './patient-search.service.js';
import { PatientClinicalService } from './patient-clinical.service.js';
import { PatientRecordsService } from './patient-records.service.js';
import { PatientMergeService } from './patient-merge.service.js';
import { MrnService } from './mrn.service.js';
import { PatientImportService } from './patient-import.service.js';

/**
 * Patient Registry (PAT, v0-03-patient.md).
 *
 * Exported wholesale because every clinical module ahead of it needs the
 * patient: the encounter needs to know who walked in, the prescription needs
 * their allergies, the invoice needs their name.
 */
@Module({
  controllers: [PatientsController],
  providers: [
    PatientService,
    PatientSearchService,
    PatientClinicalService,
    PatientRecordsService,
    PatientMergeService,
    MrnService,
    PatientImportService,
    StorageService,
  ],
  exports: [
    PatientService,
    PatientSearchService,
    PatientClinicalService,
    PatientRecordsService,
    MrnService,
  ],
})
export class PatientModule {}
