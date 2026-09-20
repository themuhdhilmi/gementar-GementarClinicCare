import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { DbService } from '../../shared/prisma/db.service.js';
import type { DomainEventEnvelope, DomainEventName } from './domain-events.js';

/**
 * In-process event bus. Events are published *after commit*, so a subscriber
 * can never react to work that was rolled back. V1 (`NTF`) swaps the transport
 * for a durable queue without changing this interface.
 */
@Injectable()
export class EventBus {
  private readonly logger = new Logger(EventBus.name);
  private readonly emitter = new EventEmitter({ captureRejections: true });

  constructor(private readonly db: DbService) {
    this.emitter.setMaxListeners(50);
    this.emitter.on('error', (error) => this.logger.error('event subscriber failed', error));
  }

  publish(envelope: DomainEventEnvelope): void {
    this.db.afterCommit(() => {
      this.emitter.emit(envelope.name, envelope);
      this.emitter.emit('*', envelope);
    });
  }

  on(name: DomainEventName | '*', handler: (event: DomainEventEnvelope) => void): void {
    this.emitter.on(name, handler);
  }
}
