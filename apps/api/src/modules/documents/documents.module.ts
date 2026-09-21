import { Module } from '@nestjs/common';
import { StorageService } from '../../shared/storage/storage.service.js';
import { DocumentController } from './document.controller.js';
import { DocumentService } from './document.service.js';
import { DocumentIntegrityJob } from './integrity.job.js';

/**
 * Documents (DOC, v0-13-documents.md).
 *
 * The paper the patient walks out with. It reads from every clinical
 * module and is depended on by none of them: a document is made *from* a
 * record rather than being part of one, which is why this module can
 * arrive last and change nothing that came before it.
 */
@Module({
  controllers: [DocumentController],
  providers: [StorageService, DocumentService, DocumentIntegrityJob],
  exports: [DocumentService],
})
export class DocumentsModule {}
