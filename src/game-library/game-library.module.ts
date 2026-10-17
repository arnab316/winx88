import { Module } from '@nestjs/common';

import { AuthModule } from 'src/auth/auth.module';
import { GameLibraryController } from './game-library.controller';
import { CatalogBrowseController } from './catalog-browse.controller';
import { GameLibraryService } from './game-library.service';

/** Favourites + Continue Playing for the signed-in player, and catalog
 *  browsing, which also works signed out. */
@Module({
  imports: [AuthModule],
  controllers: [GameLibraryController, CatalogBrowseController],
  providers: [GameLibraryService],
  exports: [GameLibraryService],
})
export class GameLibraryModule {}
