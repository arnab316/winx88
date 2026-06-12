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
    @Query('settled') settled?: string,
    @Query('providerId') providerId?: string,
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
        settled: settled === undefined ? undefined : settled === 'true',
        providerId: providerId !== undefined && providerId !== '' && !isNaN(Number(providerId))
          ? Number(providerId)
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
   * Settled rounds only: wagers with a final outcome (WON / LOST / CANCELLED).
   *
   *   GET /me/game-history/settled?category=LOTTERY&from=2026-06-04&to=2026-06-11&page=1&limit=50
   */
  @Get('settled')
  async getSettled(
    @Req() req: any,
    @Query('category') category?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    return this.settledFeed(req, true, 'Settled game history', {
      category, from, to, page, limit,
    });
  }

  /**
   * Unsettled rounds only: wagers still awaiting a result (PLACED).
   *
   *   GET /me/game-history/unsettled?category=LOTTERY&from=2026-06-04&to=2026-06-11&page=1&limit=50
   */
  @Get('unsettled')
  async getUnsettled(
    @Req() req: any,
    @Query('category') category?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    return this.settledFeed(req, false, 'Unsettled game history', {
      category, from, to, page, limit,
    });
  }

  private async settledFeed(
    req: any,
    settled: boolean,
    message: string,
    q: { category?: string; from?: string; to?: string; page: number; limit: number },
  ) {
    try {
      const validCategories: GameCategory[] = ['LOTTERY', 'JACKPOT', 'SLOT'];
      const data = await this.history.getHistory(req.user.sub, {
        settled,
        category: q.category && validCategories.includes(q.category.toUpperCase() as GameCategory)
          ? (q.category.toUpperCase() as GameCategory)
          : undefined,
        from: q.from,
        to: q.to,
        page: q.page,
        limit: q.limit,
      });

      return { statusCode: HttpStatus.OK, message, ...data };
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
   * Combined feed: every product (LOTTERY + JACKPOT + SLOT) and every status
   * (WON / LOST / PLACED / CANCELLED) merged into one timeline, filtered only by
   * date range. No category/status filter is applied — it's the full picture.
   *
   *   GET /me/game-history/combine?from=2026-05-01&to=2026-06-01&page=1&limit=20
   */
  @Get('combine')
  async getCombinedHistory(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    try {
      const data = await this.history.getHistory(req.user.sub, {
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

  /**
   * Grouped view: one card per (provider, day) with totalGames, turnover,
   * totalWon and netPL — the "JILI · May 17 · ৳5" list. Drill into a card with
   * GET /me/game-history?providerId=&category=&from=&to= for the game rows.
   *
   *   GET /me/game-history/by-provider?category=SLOT&settled=true&from=&to=
   */
  @Get('by-provider')
  async getByProvider(
    @Req() req: any,
    @Query('category') category?: string,
    @Query('settled') settled?: string,
    @Query('providerId') providerId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    try {
      const validCategories: GameCategory[] = ['LOTTERY', 'JACKPOT', 'SLOT'];
      const data = await this.history.getHistoryByProvider(req.user.sub, {
        category: category && validCategories.includes(category.toUpperCase() as GameCategory)
          ? (category.toUpperCase() as GameCategory)
          : undefined,
        settled: settled === undefined ? undefined : settled === 'true',
        providerId: providerId !== undefined && providerId !== '' && !isNaN(Number(providerId))
          ? Number(providerId)
          : undefined,
        from,
        to,
      });

      return { statusCode: HttpStatus.OK, message: 'Game history by provider', ...data };
    } catch (error: any) {
      throw new HttpException(
        {
          statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to fetch grouped game history',
        },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
