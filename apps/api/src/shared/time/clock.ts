import { Injectable } from '@nestjs/common';

/** Injectable clock, so time-dependent rules (lockout, expiry) are testable. */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }

  inMinutes(minutes: number, from: Date = this.now()): Date {
    return new Date(from.getTime() + minutes * 60_000);
  }

  inHours(hours: number, from: Date = this.now()): Date {
    return new Date(from.getTime() + hours * 3_600_000);
  }

  inDays(days: number, from: Date = this.now()): Date {
    return new Date(from.getTime() + days * 86_400_000);
  }

  agoMinutes(minutes: number, from: Date = this.now()): Date {
    return new Date(from.getTime() - minutes * 60_000);
  }

  agoDays(days: number, from: Date = this.now()): Date {
    return new Date(from.getTime() - days * 86_400_000);
  }
}
