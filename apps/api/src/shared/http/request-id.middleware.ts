import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { newId } from '../ids/uuid.js';

/** Every request gets an id; it goes into audit rows and error responses. */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request & { id?: string }, res: Response, next: NextFunction): void {
    const incoming = req.get('x-request-id');
    req.id = incoming && incoming.length <= 64 ? incoming : newId();
    res.setHeader('x-request-id', req.id);
    next();
  }
}
