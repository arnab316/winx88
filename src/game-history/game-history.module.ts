import { Module } from '@nestjs/common';

import { AuthModule } from 'src/auth/auth.module';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { GameHistoryController } from './game-history.controller';
import { GameHistoryService } from './game-history.service';

/**
 * Unified user game history.
 *
 * Reads directly from the shared `bets` and `slot_transactions` tables via the
 * default DataSource — no dependency on GameModule / JackpotModule /
 * PalaceCasinoModule, so it stays decoupled and the existing per-product
 * endpoints keep working unchanged.
 *
 * Depends on JwtAuthGuard (exported by AuthModule).
 */
@Module({
  imports: [AuthModule],
  controllers: [GameHistoryController],
  providers: [GameHistoryService, JwtAuthGuard],
})
export class GameHistoryModule {}
