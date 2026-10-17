import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuthModule } from 'src/auth/auth.module';
import { GameHistoryModule } from 'src/game-history/game-history.module';
import { PromotionModule } from 'src/promotion/promotion.module';
import { TurnoverModule } from 'src/turnover/turnover.module';
import { UserModule } from 'src/user/user.module';
import { VerificationModule } from 'src/verification/verification.module';
import { VipModule } from 'src/vip/vip.module';
import { WalletModule } from 'src/wallet/wallet.module';

import {
  AiSupportKycController,
  AiSupportUserController,
} from './controllers/ai-support-user.controller';
import { AiSupportWalletController } from './controllers/ai-support-wallet.controller';
import {
  AiSupportDepositController,
  AiSupportWithdrawalController,
} from './controllers/ai-support-payment.controller';
import { AiSupportBetController } from './controllers/ai-support-bet.controller';
import {
  AiSupportBonusController,
  AiSupportPromotionController,
} from './controllers/ai-support-promotion.controller';

import { AiSupportGuard } from './guards/ai-support.guard';
import { AiSupportUserService } from './services/ai-support-user.service';
import { AiSupportWalletService } from './services/ai-support-wallet.service';
import { AiSupportPaymentService } from './services/ai-support-payment.service';
import { AiSupportBetService } from './services/ai-support-bet.service';
import { AiSupportPromotionService } from './services/ai-support-promotion.service';

/**
 * Read-only customer-support endpoints for the AI support agent.
 *
 * Every number is produced by the module that owns it — wallet, turnover,
 * promotion engine, game history, verification — so a support answer cannot
 * drift from what the customer sees in their own app. This module shapes and
 * redacts; it decides nothing.
 *
 * ThrottlerModule is configured HERE rather than in AppModule. The app has no
 * global throttler, and registering one would start rate-limiting every
 * existing endpoint in the platform — a change well outside this feature.
 * Scoped like this, the limit applies only to these routes.
 */
@Module({
  imports: [
    ThrottlerModule.forRoot([{ name: 'ai-support', ttl: 60_000, limit: 120 }]),
    AuthModule,        // JwtService for the guard
    UserModule,
    VerificationModule,
    WalletModule,
    TurnoverModule,
    PromotionModule,
    GameHistoryModule,
    VipModule,
  ],
  controllers: [
    AiSupportUserController,
    AiSupportKycController,
    AiSupportWalletController,
    AiSupportDepositController,
    AiSupportWithdrawalController,
    AiSupportBetController,
    AiSupportPromotionController,
    AiSupportBonusController,
  ],
  providers: [
    AiSupportGuard,
    AiSupportUserService,
    AiSupportWalletService,
    AiSupportPaymentService,
    AiSupportBetService,
    AiSupportPromotionService,
  ],
})
export class AiSupportModule {}
