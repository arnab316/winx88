import { Module, forwardRef } from '@nestjs/common';
import { NexusClient } from './nexus.client';
import { NexusService } from './nexus.service';
import { NexusController } from './nexus.controller';
import { NexusCallbackController } from './nexus-callback.controller';
import { NexusCallbackService } from './nexus-callback.service';
import { GameCurationService } from './game-curation.service';
import { MediaS3Service } from '../common/services/media-s3.service';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { TurnoverModule } from '../turnover/turnover.module';
import { GameLibraryModule } from '../game-library/game-library.module';

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
    // Reuses the shared catalog reader for the player-facing browse routes.
    GameLibraryModule,
  ],
  controllers: [NexusController, NexusCallbackController],
  providers: [
    NexusClient,
    NexusService,
    NexusCallbackService,
    GameCurationService,
    // Replacement game artwork goes to the shared media bucket.
    MediaS3Service,
  ],
  // Curation is catalog-wide, not Nexus-specific — exported so another
  // aggregator's sync can resolve against the same rules.
  exports: [NexusClient, NexusService, GameCurationService],
})
export class NexusModule {}
