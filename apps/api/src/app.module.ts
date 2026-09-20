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

@Module({
  imports: [
    ConfigModule,
    CryptoModule,
    PrismaModule,
    EventsModule,
    AuditModule,
    TenancyModule,
    IdentityModule,
    PatientModule,
    EncounterModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware, OriginCheckMiddleware).forRoutes('*splat');
  }
}
