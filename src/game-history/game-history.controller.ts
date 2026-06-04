import {
  Controller,
  DefaultValuePipe,
  Get,
  HttpException,
  HttpStatus,
  ParseIntPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import {
  GameCategory,
  GameHistoryService,
} from './game-history.service';

/**
 * Unified game history for the logged-in user.
 *
 *   GET /me/game-history?category=SLOT&status=WON&from=2026-05-01&to=2026-06-01&page=1&limit=20
 *
 * Merges lottery + jackpot wagers (bets table) and Palace slot rounds
 * (slot_transactions) into one paginated, normalised feed.
 */
@Controller('me/game-history')
@UseGuards(JwtAuthGuard)
export class GameHistoryController {
  constructor(private readonly history: GameHistoryService) {}

  @Get()
  async getHistory(
    @Req() req: any,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    try {
      const validCategories: GameCategory[] = ['LOTTERY', 'JACKPOT', 'SLOT'];
      const validStatuses = ['WON', 'LOST', 'PLACED', 'CANCELLED'];

      const data = await this.history.getHistory(req.user.sub, {
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
}
