import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { WinypayController } from './winypay.controller';
import { WinypayService } from './winypay.service';
import { WinypayClient } from './winypay.client';

/**
 * WinyPay (Bangladesh PSP) — automated online DEPOSITS.
 *   - AuthModule  → JwtService for JwtAuthGuard on /winypay/deposit
 *   - WalletModule→ WalletService (reuses the existing deposit credit path)
 *   ConfigService is global (ConfigModule.forRoot({ isGlobal: true })).
 */
@Module({
  imports: [AuthModule, WalletModule],
  controllers: [WinypayController],
  providers: [WinypayService, WinypayClient],
})
export class WinypayModule {}
