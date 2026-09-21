import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject, filter, map, merge, timer } from 'rxjs';

export type QueueEvent = {
  /** Which branch changed. Subscribers only see their own. */
  branchId: string;
  /** What kind of change, so a client can decide what to refetch. */
  kind: 'status' | 'call' | 'skip' | 'priority' | 'assignment' | 'created';
  /** Enough to refetch with, and no more (ENC-R-08). */
  encounterId: string;
  /** Safe to show on a public screen: a queue number is not a person. */
  queueNo: string;
  /** Present on a call, so the display can chime and announce. */
  station?: string;
  room?: string | null;
  at: string;
};

/**
 * The fan-out behind the live queue boards (ENC-F-19).
 *
 * In-process, deliberately. One Node process serves one clinic in V0, and a
 * shared broker would be a second thing to run and to keep alive for no gain
 * a single branch can feel. `documents/modules/v0-04-encounter-queue.md` §19
 * puts multi-process fan-out over PostgreSQL LISTEN/NOTIFY in V2, where a
 * second process first exists.
 *
 * **Events are invalidation signals, not data** (ENC-R-08). They carry the
 * branch, what changed and the queue number, and the client refetches. That
 * is what keeps a public waiting-room screen from ever being sent a name it
 * should not have, and what makes a missed event harmless: the next refetch
 * is the truth either way.
 */
@Injectable()
export class QueueStreamService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueStreamService.name);
  private readonly events = new Subject<QueueEvent>();
  private subscribers = 0;

  publish(event: QueueEvent): void {
    this.events.next(event);
  }

  /**
   * One branch's events, with a heartbeat.
   *
   * The heartbeat is not decoration. A proxy or a mobile network will close
   * a connection that has said nothing for a minute, and a waiting-room
   * screen that quietly stopped receiving events looks exactly like a clinic
   * with nobody in it.
   */
  forBranch(
    branchId: string,
  ): Observable<{ data: QueueEvent | { heartbeat: string } }> {
    this.subscribers += 1;
    this.logger.debug(
      `queue stream opened for ${branchId} (${this.subscribers} open)`,
    );

    const changes = this.events.pipe(
      filter((event) => event.branchId === branchId),
      map((event) => ({ data: event })),
    );
    const heartbeat = timer(15_000, 15_000).pipe(
      map(() => ({ data: { heartbeat: new Date().toISOString() } })),
    );

    return new Observable<{ data: QueueEvent | { heartbeat: string } }>(
      (subscriber) => {
        const inner = merge(changes, heartbeat).subscribe(subscriber);
        return () => {
          inner.unsubscribe();
          this.subscribers -= 1;
          this.logger.debug(
            `queue stream closed for ${branchId} (${this.subscribers} open)`,
          );
        };
      },
    );
  }

  get openConnections(): number {
    return this.subscribers;
  }

  onModuleDestroy(): void {
    this.events.complete();
  }
}
