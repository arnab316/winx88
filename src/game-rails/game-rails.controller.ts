import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';

import { AdminGuard } from 'src/common/guards/admin.guard';
import { OptionalJwtAuthGuard } from 'src/common/guards/optional-jwt-auth.guard';
import { GameRailsService, RAIL_MODES, type RailInput } from './game-rails.service';

/**
 * Admin-built game rows on the player home.
 *
 *   GET /game-rails/active          public — the home screen's rows + games
 *   GET /game-rails/:key/games      public — paged, for View All / infinite scroll
 *
 * Both are public so a signed-out visitor can browse the lobby; the optional
 * guard makes `isFavourite` real when a token is sent and never 401s.
 */
@Controller('game-rails')
export class GameRailsController {
  constructor(private readonly rails: GameRailsService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Get('active')
  active(@Req() req: any) {
    return this.rails.listActiveWithGames(req.user?.sub ?? null);
  }

  /** Before :id routes — a literal path must not be read as a parameter. */
  @UseGuards(AdminGuard)
  @Get('admin/modes')
  modes() {
    return RAIL_MODES;
  }

  @UseGuards(AdminGuard)
  @Get('admin')
  list() {
    return this.rails.listAll();
  }

  @UseGuards(AdminGuard)
  @Post('admin')
  create(@Body() body: RailInput) {
    return this.rails.create(body);
  }

  /** What the rail would show, before committing to it. */
  @UseGuards(AdminGuard)
  @Post('admin/preview')
  preview(@Body() body: Partial<RailInput>) {
    return this.rails.preview(body);
  }

  @UseGuards(AdminGuard)
  @Patch('admin/reorder')
  reorder(@Body() body: { ids: number[] }) {
    return this.rails.reorder(body?.ids);
  }

  @UseGuards(AdminGuard)
  @Patch('admin/:id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: Partial<RailInput>) {
    return this.rails.update(id, body);
  }

  @UseGuards(AdminGuard)
  @Delete('admin/:id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.rails.remove(id);
  }

  /**
   * Declared LAST: `:key` would otherwise swallow `active` and `admin`.
   * Nest matches in declaration order.
   */
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':key/games')
  games(
    @Req() req: any,
    @Param('key') key: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.rails.railGames(
      key, req.user?.sub ?? null, Number(page) || 1, Number(limit) || 24,
    );
  }
}
