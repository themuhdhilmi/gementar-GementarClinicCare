import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service.js';
import { Clock } from '../time/clock.js';

@Global()
@Module({
  providers: [CryptoService, Clock],
  exports: [CryptoService, Clock],
})
export class CryptoModule {}
