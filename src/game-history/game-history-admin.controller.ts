import {
  Controller,
  DefaultValuePipe,
  Get,
  HttpException,
  HttpStatus,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from 'src/common/guards/admin.guard';
import {
  GameCategory,
  GameHistoryService,
} from './game-history.service';

/**
 * Admin view of any player's unified game history.
 *
 * Same normalised feed as the user-facing controller, but the target player is
 * supplied via `userId` instead of being taken from the JWT. Admin-only.
 *
 *   GET /admin/game-history?userId=42&category=SLOT&status=WON&from=2026-05-01&to=2026-06-01
 *   GET /admin/game-history/combine?userId=42&from=2026-05-01&to=2026-06-01
 */
@Controller('admin/game-history')
@UseGuards(AdminGuard)
export class GameHistoryAdminController {
  constructor(private readonly history: GameHistoryService) {}

  @Get()
  async getHistory(
    @Query('userId', ParseIntPipe) userId: number,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    try {
      const validCategories: GameCategory[] = ['LOTTERY', 'JACKPOT', 'SLOT', 'LIVE', 'SPORTS'];
      const validStatuses = ['WON', 'LOST', 'PLACED', 'CANCELLED'];

      const data = await this.history.getHistory(userId, {
        category: category && validCategories.includes(category.toUpperCase() as GameCategory)
          ? (category.toUpperCase() as GameCategory)
          : undefined,
        status: status && validStatuses.includes(status.toUpperCase())
          ? status.toUpperCase()
          : undefined,
        from,
        to,
        page,
        limit,
      });

      return { statusCode: HttpStatus.OK, message: 'Game history', ...data };
    } catch (error: any) {
      throw new HttpException(
        {
          statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to fetch game history',
        },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Combined feed for a player: every product (LOTTERY + JACKPOT + SLOT) and
   * every status (WON / LOST / PLACED / CANCELLED) merged into one timeline,
   * filtered only by date range.
   *
   *   GET /admin/game-history/combine?userId=42&from=2026-05-01&to=2026-06-01
   */
  @Get('combine')
  async getCombinedHistory(
    @Query('userId', ParseIntPipe) userId: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    try {
      const data = await this.history.getHistory(userId, {
        from,
        to,
        page,
        limit,
      });

      return { statusCode: HttpStatus.OK, message: 'Combined game history', ...data };
    } catch (error: any) {
      throw new HttpException(
        {
          statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to fetch combined game history',
        },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
