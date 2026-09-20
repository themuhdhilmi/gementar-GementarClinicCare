import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { DbService } from './db.service.js';

@Global()
@Module({
  providers: [PrismaService, DbService],
  exports: [PrismaService, DbService],
})
export class PrismaModule {}
