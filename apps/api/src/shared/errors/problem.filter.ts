import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError, RateLimitedError } from './domain-errors.js';
import { isDatabaseUnavailable, toDatabaseUnavailable } from './database-errors.js';

type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  traceId: string;
  errors?: unknown;
};

/** RFC 7807-ish error responses, uniform across the API (architecture doc). */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request & { id?: string }>();
    const traceId = req.id ?? 'unknown';

    // A database that is not answering is not a bug in the request. Say so
    // plainly, and with a status that says "try again", not "you are wrong".
    const mapped = isDatabaseUnavailable(exception) ? toDatabaseUnavailable() : exception;
    const problem = this.toProblem(mapped, traceId);

    if (exception instanceof RateLimitedError) {
      res.setHeader('Retry-After', String(exception.retryAfterSeconds));
    }
    if (problem.status === 503) {
      // One line, not a stack: during an outage this fires on every request.
      this.logger.error(
        `${req.method} ${req.originalUrl} -> 503 [${traceId}] database unavailable: ` +
          `${(exception as Error).message?.split('\n')[0]}`,
      );
    } else if (problem.status >= 500) {
      this.logger.error(
        `${req.method} ${req.originalUrl} -> ${problem.status} [${traceId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`${req.method} ${req.originalUrl} -> ${problem.status} [${traceId}] ${problem.code}`);
    }

    res.status(problem.status).type('application/problem+json').send(problem);
  }

  private toProblem(exception: unknown, traceId: string): Problem {
    if (exception instanceof AppError) {
      return {
        type: `https://cliniccare.gementar.com/problems/${exception.code}`,
        title: exception.title,
        status: exception.status,
        detail: exception.detail ?? exception.title,
        code: exception.code,
        traceId,
        ...(exception.extra ? { errors: exception.extra } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const detail =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] }).message ?? exception.message);
      const code = status === 400 ? 'validation_failed' : `http_${status}`;
      return {
        type: `https://cliniccare.gementar.com/problems/${code}`,
        title: HttpStatus[status] ? String(HttpStatus[status]) : 'Error',
        status,
        detail: Array.isArray(detail) ? detail.join('; ') : String(detail),
        code,
        traceId,
        ...(Array.isArray(detail) ? { errors: detail } : {}),
      };
    }

    return {
      type: 'https://cliniccare.gementar.com/problems/internal_error',
      title: 'Internal server error',
      status: 500,
      detail: 'Something went wrong. Quote the trace id when reporting this.',
      code: 'internal_error',
      traceId,
    };
  }
}
