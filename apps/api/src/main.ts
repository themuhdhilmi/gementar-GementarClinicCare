import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = configureApp(app);
  await app.listen(config.port);
  new Logger('Bootstrap').log(`API listening on :${config.port} (${config.nodeEnv})`);
}

await bootstrap();
