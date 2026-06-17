import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';

import { OroplayClient } from './oroplay.client';
import { OroplayTokenCache } from './token-cache.service';
import { OroplayController } from './oroplay.controller';
import { OroplayCallbackController } from './oroplay-callback.controller';
import { OroplayCallbackService } from './oroplay-callback.service';

import { AuthModule } from 'src/auth/auth.module';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { WalletModule } from 'src/wallet/wallet.module';
import { TurnoverModule } from 'src/turnover/turnover.module';

/**
 * OroPlay (Live Casino / Slot / Mini-game) integration module.
 *
 * - OUTBOUND: OroplayClient calls OroPlay (token, vendors, games, launch URL, etc.)
 * - INBOUND:  OroplayCallbackController receives balance / transaction callbacks
 *
 * Required env vars:
 *   OROPLAY_API_ENDPOINT   — base URL (e.g. https://api-endpoint.oroplay.com/api/v2)
 *   OROPLAY_CLIENT_ID      — your agent clientId
 *   OROPLAY_CLIENT_SECRET  — your agent clientSecret
 *
 * Required tables: oroplay_transactions (+ oroplay_registered flag on users)
 * (See migrations/001_oroplay.sql)
 *
 * IMPORTANT: AuthModule must be in app.module's imports BEFORE OroplayModule
 * because JwtAuthGuard depends on it.
 */
@Module({
  imports: [
    ConfigModule,
    HttpModule.register({ timeout: 10_000 }),
    AuthModule,
    WalletModule,
    TurnoverModule,
  ],
  controllers: [OroplayController, OroplayCallbackController],
  providers: [
    OroplayClient,
    OroplayTokenCache,
    OroplayCallbackService,
    JwtAuthGuard,
  ],
  exports: [OroplayClient],
})
export class OroplayModule {}
