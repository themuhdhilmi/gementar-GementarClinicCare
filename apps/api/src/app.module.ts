import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from './config/config.module.js';
import { CryptoModule } from './shared/crypto/crypto.module.js';
import { PrismaModule } from './shared/prisma/prisma.module.js';
import { RequestIdMiddleware } from './shared/http/request-id.middleware.js';
import { OriginCheckMiddleware } from './shared/http/origin-check.middleware.js';
import { TenancyModule } from './modules/tenancy/tenancy.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { EventsModule } from './modules/events/events.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { HealthController } from './health.controller.js';
import { PatientModule } from './modules/patient/patient.module.js';
import { EncounterModule } from './modules/encounter/encounter.module.js';
import { TriageModule } from './modules/triage/triage.module.js';
import { ConsultationModule } from './modules/consultation/consultation.module.js';
import { CatalogueModule } from './modules/catalogue/catalogue.module.js';
import { PrescriptionModule } from './modules/prescription/prescription.module.js';
import { StockModule } from './modules/stock/stock.module.js';
import { ProcedureModule } from './modules/procedure/procedure.module.js';
import { DispensingModule } from './modules/dispensing/dispensing.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { DocumentsModule } from './modules/documents/documents.module.js';
import { PaymentModule } from './modules/payment/payment.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';

@Module({
  imports: [
    ConfigModule,
    CryptoModule,
    PrismaModule,
    EventsModule,
    TenancyModule,
    // IdentityModule registers the interceptor that opens the per-request
    // transaction, and AuditModule registers one that must run *inside*
    // it. Global interceptors fire in module-import order, outermost
    // first, so this pair is ordered deliberately rather than
    // alphabetically. `audit.e2e-spec.ts` fails if they are swapped.
    IdentityModule,
    AuditModule,
    PatientModule,
    EncounterModule,
    TriageModule,
    CatalogueModule,
    PrescriptionModule,
    StockModule,
    ProcedureModule,
    DispensingModule,
    BillingModule,
    DocumentsModule,
    PaymentModule,
    ReportsModule,
    ConsultationModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware, OriginCheckMiddleware).forRoutes('*splat');
  }
}
