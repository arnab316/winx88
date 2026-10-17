import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';

import { OptionalJwtAuthGuard } from 'src/common/guards/optional-jwt-auth.guard';
import { GameLibraryService } from './game-library.service';

/**
 * Browsing the shared game catalog, for the player panel.
 *
 * Works signed OUT — a visitor must be able to look at the lobby before they
 * have an account. The optional guard attaches the player when a token is
 * present and never 401s, which is what lets `isFavourite` be real for a
 * signed-in player and simply `false` for everyone else.
 *
 *   GET /catalog/games?type=slots&provider=PRAGMATIC&search=bonanza&page=1
 *   GET /catalog/providers?type=slots
 */
@Controller('catalog')
@UseGuards(OptionalJwtAuthGuard)
export class CatalogBrowseController {
  constructor(private readonly library: GameLibraryService) {}

  @Get('games')
  games(
    @Req() req: any,
    @Query('type') type?: string,
    @Query('provider') provider?: string,
    @Query('search') search?: string,
    @Query('aggregator') aggregator?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.library.browseCatalog(req.user?.sub ?? null, {
      type,
      provider,
      search,
      aggregator,
      page: Number(page) || 1,
      limit: Number(limit) || 24,
    });
  }

  @Get('providers')
  providers(@Query('type') type?: string) {
    return this.library.browseProviders(type);
  }
}
