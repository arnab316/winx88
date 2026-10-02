import { Module } from '@nestjs/common';

import { AuthModule } from 'src/auth/auth.module';
import { GameLibraryController } from './game-library.controller';
import { GameLibraryService } from './game-library.service';

/** Favourites + Continue Playing for the signed-in player. */
@Module({
  imports: [AuthModule],
  controllers: [GameLibraryController],
  providers: [GameLibraryService],
  exports: [GameLibraryService],
})
export class GameLibraryModule {}
