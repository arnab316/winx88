import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';

import { PalaceCasinoClient } from './palace-casino.client';
import { PalaceCasinoController } from './palace-casino.controller';
import { PalaceCallbackController } from './callback.controller';
import { PalaceCallbackService } from './palace-callback.service';
import { AuthModule } from 'src/auth/auth.module';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { WalletModule } from 'src/wallet/wallet.module';

/**
 * Palace Casino integration module.
 *
 * - OUTBOUND: PalaceCasinoClient calls Palace's API (game list, launch, etc.)
 * - INBOUND:  PalaceCallbackController receives bet/win/cancel callbacks
 *
 * Required env vars:
 *   SLOT_API_ENDPOINT, SLOT_API_TOKEN, SLOT_CALLBACK_TOKEN
 *
 * Required tables: palace_user_mapping, slot_transactions
 * (See migrations/001_palace_casino.sql)
 *
 * IMPORTANT: This module depends on JwtAuthGuard, which is exported by
 * AuthModule. If you haven't already, make sure AuthModule is in your
 * app.module's imports BEFORE PalaceCasinoModule.
 */
@Module({
  imports: [ConfigModule, HttpModule.register({ timeout: 10_000 }), AuthModule, WalletModule],
  controllers: [PalaceCasinoController, PalaceCallbackController],
  providers: [PalaceCasinoClient, PalaceCallbackService, JwtAuthGuard],
  exports: [PalaceCasinoClient],
})
export class PalaceCasinoModule {}
