import { Module } from '@nestjs/common';

import { AuthModule } from 'src/auth/auth.module';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { GameLibraryModule } from 'src/game-library/game-library.module';
import { GameRailsController } from './game-rails.controller';
import { GameRailsService } from './game-rails.service';

/**
 * Admin-built game rows on the player home.
 *
 * Reuses GameLibraryService so rails resolve games through the same reader as
 * the catalog browser — one place deriving the identity triple favourites
 * depend on.
 */
@Module({
  imports: [AuthModule, GameLibraryModule],
  controllers: [GameRailsController],
  providers: [GameRailsService, AdminGuard],
  exports: [GameRailsService],
})
export class GameRailsModule {}
