import { Module, forwardRef } from '@nestjs/common';
import { NexusClient } from './nexus.client';
import { NexusService } from './nexus.service';
import { NexusController } from './nexus.controller';
import { NexusCallbackController } from './nexus-callback.controller';
import { NexusCallbackService } from './nexus-callback.service';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { TurnoverModule } from '../turnover/turnover.module';

/**
 * Nexus GGR — seamless wallet aggregator.
 *
 * WalletModule provides WalletGateway (post-commit balance push) and
 * TurnoverModule the stake contribution the callback records inside its
 * transaction. AuthModule supplies the JwtService the guards need.
 */
@Module({
  imports: [
    forwardRef(() => AuthModule),
    forwardRef(() => WalletModule),
    TurnoverModule,
  ],
  controllers: [NexusController, NexusCallbackController],
  providers: [NexusClient, NexusService, NexusCallbackService],
  exports: [NexusClient, NexusService],
})
export class NexusModule {}
