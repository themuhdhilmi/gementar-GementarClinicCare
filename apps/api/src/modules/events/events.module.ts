import { Global, Module } from '@nestjs/common';
import { EventBus } from './event-bus.service.js';
import { ChargeRegistry } from './charge.registry.js';

@Global()
@Module({
  providers: [EventBus, ChargeRegistry],
  exports: [EventBus, ChargeRegistry],
})
export class EventsModule {}
