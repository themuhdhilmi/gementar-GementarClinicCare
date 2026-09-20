import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';
import { ProblemDetailsFilter } from './shared/errors/problem.filter.js';

/**
 * Everything that turns a Nest application into *this* application. Shared by
 * `main.ts` and the end-to-end tests, so the tests exercise the same pipeline
 * the clinic will run — including the cookie parser and the error format.
 */
export function configureApp(app: INestApplication): AppConfig {
  const config = app.get<AppConfig>(APP_CONFIG);
  const express = app as NestExpressApplication;

  // Behind Caddy; the client IP in audit rows must be the real one.
  express.set('trust proxy', 1);
  app.use(cookieParser());
  app.use(
    helmet({
      // IAM-N-04: HSTS for a year, preload-eligible.
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      contentSecurityPolicy: false, // the API serves JSON; the web app sets its own
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.enableCors({ origin: config.webOrigins, credentials: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();
  return config;
}
