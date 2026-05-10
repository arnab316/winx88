// src/game/game.controller.ts
//
// Full file. Endpoints:
//
//   PUBLIC GETs:
//     GET  /games                        — list (filterable)
//     GET  /games/hot                    — hot games
//     GET  /games/jackpot                — jackpot-badged games
//     GET  /games/by-type/:digitLength   — 1D / 3D / 4D / 5D
//     GET  /games/:id                    — single game detail
//     GET  /games/:gameId/hot-numbers    — hot numbers
//     GET  /games/:gameId/rounds         — list rounds (filterable by status)
//     GET  /games/:gameId/active-rounds  — currently OPEN rounds
//     GET  /games/:gameId/results        — recent results history
//     GET  /games/round/:roundId/result  — single round result
//
//   ORIGINAL POSTS:
//     POST /games/bet, /games/settle/:round_id, /games/create,
//     POST /games/round, /games/hot-number, /games/result/:round_id
//
//   ADMIN:
//     PATCH /games/admin/:id/flags
//     GET   /games/admin/:gameId/hot-numbers
//     POST  /games/admin/hot-numbers
//     PATCH /games/admin/hot-numbers/:id
//     DELETE /games/admin/hot-numbers/:id
//     POST  /games/admin/hot-numbers/:id/toggle
//     POST  /games/admin/hot-numbers/reorder

import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, Req,
  HttpException, HttpStatus, ParseIntPipe, DefaultValuePipe,
  UseGuards, UsePipes, ValidationPipe, BadRequestException,
} from '@nestjs/common';
import { GameService } from './game.service';
import { AdminGuard } from '../common/guards/admin.guard';
import {
  UpdateGameFlagsDto,
  CreateHotNumberDto,
  UpdateHotNumberDto,
  ReorderHotNumbersDto,
  ListGamesQueryDto,
  ListRoundsQueryDto,
  VALID_DIGIT_LENGTHS,
  DigitLength,
} from './dto/game.dto';

@Controller('games')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class GameController {
  constructor(private readonly gameService: GameService) {}

  // ╔═══════════════════════════════════════════════════════════╗
  // ║                  PUBLIC LISTING ENDPOINTS                 ║
  // ╚═══════════════════════════════════════════════════════════╝

  // GET /games?isActive=true&isHot=true&category=JACKPOT&digitLength=3
  @Get()
  async list(@Query() q: ListGamesQueryDto) {
    try {
      const data = await this.gameService.listGames(q);
      return { statusCode: HttpStatus.OK, message: 'Games fetched', count: data.length, data };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to fetch games' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // GET /games/hot
  @Get('hot')
  async hotGames() {
    try {
      const data = await this.gameService.listHotGames();
      return { statusCode: HttpStatus.OK, message: 'Hot games', count: data.length, data };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to fetch hot games' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // GET /games/jackpot
  @Get('jackpot')
  async jackpotGames() {
    try {
      const data = await this.gameService.listJackpotGames();
      return { statusCode: HttpStatus.OK, message: 'Jackpot games', count: data.length, data };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to fetch jackpot games' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // GET /games/by-type/:digitLength    where digitLength ∈ {1, 3, 4, 5}
  @Get('by-type/:digitLength')
  async gamesByType(@Param('digitLength', ParseIntPipe) digitLength: number) {
    try {
      if (!VALID_DIGIT_LENGTHS.includes(digitLength as DigitLength)) {
        throw new BadRequestException(
          `digitLength must be one of: ${VALID_DIGIT_LENGTHS.join(', ')} (1D, 3D, 4D, 5D)`,
        );
      }
      const data = await this.gameService.listGamesByDigitLength(digitLength as DigitLength);
      return {
        statusCode: HttpStatus.OK,
        message: `${digitLength}D games`,
        digitLength,
        count: data.length,
        data,
      };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to fetch games by type' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // GET /games/:id   (single game detail page)
  @Get(':id')
  async getOne(@Param('id', ParseIntPipe) id: number) {
    try {
      const data = await this.gameService.getGameById(id);
      return { statusCode: HttpStatus.OK, message: 'Game detail', data };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to fetch game' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // GET /games/:gameId/hot-numbers
  @Get(':gameId/hot-numbers')
  async hotNumbers(@Param('gameId', ParseIntPipe) gameId: number) {
    try {
      const data = await this.gameService.listHotNumbersForGame(gameId);
      return { statusCode: HttpStatus.OK, message: 'Hot numbers', count: data.length, data };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to fetch hot numbers' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // GET /games/:gameId/rounds?status=OPEN&limit=20
  @Get(':gameId/rounds')
  async listRounds(
    @Param('gameId', ParseIntPipe) gameId: number,
    @Query() q: ListRoundsQueryDto,
  ) {
    try {
      const data = await this.gameService.listRoundsForGame(gameId, q);
      return { statusCode: HttpStatus.OK, message: 'Rounds', count: data.length, data };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to fetch rounds' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // GET /games/:gameId/active-rounds   (only OPEN rounds with future close_time)
  @Get(':gameId/active-rounds')
  async activeRounds(@Param('gameId', ParseIntPipe) gameId: number) {
    try {
      const data = await this.gameService.getActiveRoundsForGame(gameId);
      return { statusCode: HttpStatus.OK, message: 'Active rounds', count: data.length, data };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to fetch active rounds' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // GET /games/:gameId/results?limit=20
  @Get(':gameId/results')
  async recentResults(
    @Param('gameId', ParseIntPipe) gameId: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    try {
      const data = await this.gameService.getRecentResultsForGame(gameId, limit);
      return { statusCode: HttpStatus.OK, message: 'Recent results', count: data.length, data };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to fetch results' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // GET /games/round/:roundId/result   (single round result)
  @Get('round/:roundId/result')
  async roundResult(@Param('roundId', ParseIntPipe) roundId: number) {
    try {
      const data = await this.gameService.getRoundResult(roundId);
      return { statusCode: HttpStatus.OK, message: 'Round result', data };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to fetch round result' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ╔═══════════════════════════════════════════════════════════╗
  // ║                  ORIGINAL POSTS (kept)                    ║
  // ╚═══════════════════════════════════════════════════════════╝

  @Post('bet')
  async placeBet(@Body() body: any) {
    try {
      const result = await this.gameService.placeBet(body);
      return { statusCode: HttpStatus.CREATED, message: 'Bet placed successfully', data: result };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to place bet',
          ...(error?.response && typeof error.response === 'object' ? error.response : {}) },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('settle/:round_id')
  async settleRound(
    @Param('round_id', ParseIntPipe) round_id: number,
    @Body() body: { result_number: string },
  ) {
    try {
      const result = await this.gameService.settleRound(round_id, body.result_number);
      return { statusCode: HttpStatus.OK, message: 'Round settled successfully', data: result };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to settle round' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('create')
  async createGame(@Body() body: any) {
    try {
      const result = await this.gameService.createGame(body);
      return { statusCode: HttpStatus.CREATED, message: 'Game created successfully', data: result };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to create game' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('round')
  async createRound(@Body() body: any) {
    try {
      const result = await this.gameService.createRound(body);
      return { statusCode: HttpStatus.CREATED, message: 'Round created successfully', data: result };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to create round' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('hot-number')
  async addHotNumber(@Body() body: any) {
    try {
      const result = await this.gameService.addHotNumber(body);
      return { statusCode: HttpStatus.CREATED, message: 'Hot number added', data: result };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to add hot number' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('result/:round_id')
  async publishResult(
    @Param('round_id', ParseIntPipe) round_id: number,
    @Body() body: { result_number: string },
  ) {
    try {
      const result = await this.gameService.publishResult(round_id, body.result_number);
      return { statusCode: HttpStatus.OK, message: 'Result published', data: result };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to publish result' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ╔═══════════════════════════════════════════════════════════╗
  // ║                    ADMIN ENDPOINTS                        ║
  // ╚═══════════════════════════════════════════════════════════╝

  @UseGuards(AdminGuard)
  @Patch('admin/:id/flags')
  async updateFlags(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateGameFlagsDto,
  ) {
    try {
      const result = await this.gameService.updateGameFlags(id, dto);
      return { statusCode: HttpStatus.OK, message: 'Game flags updated', data: result };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to update flags' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @UseGuards(AdminGuard)
  @Get('admin/:gameId/hot-numbers')
  async adminListHotNumbers(
    @Param('gameId', ParseIntPipe) gameId: number,
    @Query('includeInactive') includeInactive?: string,
  ) {
    try {
      const data = await this.gameService.adminListHotNumbers(gameId, includeInactive === 'true');
      return { statusCode: HttpStatus.OK, message: 'Hot numbers', count: data.length, data };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to fetch hot numbers' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @UseGuards(AdminGuard)
  @Post('admin/hot-numbers')
  async createHotNumber(@Req() req: any, @Body() dto: CreateHotNumberDto) {
    try {
      const result = await this.gameService.createHotNumber(dto, req.user?.sub);
      return { statusCode: HttpStatus.CREATED, message: 'Hot number created', data: result };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to create hot number' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @UseGuards(AdminGuard)
  @Patch('admin/hot-numbers/:id')
  async updateHotNumber(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateHotNumberDto,
  ) {
    try {
      const result = await this.gameService.updateHotNumber(id, dto);
      return { statusCode: HttpStatus.OK, message: 'Hot number updated', data: result };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to update hot number' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @UseGuards(AdminGuard)
  @Delete('admin/hot-numbers/:id')
  async deleteHotNumber(@Param('id', ParseIntPipe) id: number) {
    try {
      const result = await this.gameService.deleteHotNumber(id);
      return { statusCode: HttpStatus.OK, message: result.message };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to delete hot number' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @UseGuards(AdminGuard)
  @Post('admin/hot-numbers/:id/toggle')
  async toggleHotNumber(@Param('id', ParseIntPipe) id: number) {
    try {
      const result = await this.gameService.toggleHotNumber(id);
      return { statusCode: HttpStatus.OK, message: 'Hot number toggled', data: result };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to toggle hot number' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @UseGuards(AdminGuard)
  @Post('admin/hot-numbers/reorder')
  async reorderHotNumbers(@Body() dto: ReorderHotNumbersDto) {
    try {
      const result = await this.gameService.reorderHotNumbers(dto);
      return { statusCode: HttpStatus.OK, message: result.message, count: result.count };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to reorder hot numbers' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }


  
  // ═════════════════════════════════════════════════════════════
  // ADMIN: ROUND STATS (number breakdown before publishing result)
  //   GET /games/admin/rounds/:roundId/stats
  //
  //   Returns every bet number with:
  //     - total bets on it
  //     - total amount staked
  //     - potential payout liability (amount × multiplier)
  //     - whether it's a hot number
  //   Sorted highest liability first.
  //   Includes safest/riskiest number hint.
  // ═════════════════════════════════════════════════════════════
  @UseGuards(AdminGuard)
  @Get('admin/rounds/:roundId/stats')
  async roundStats(@Param('roundId', ParseIntPipe) roundId: number) {
    try {
      const data = await this.gameService.getRoundStats(roundId);
      return { statusCode: HttpStatus.OK, message: 'Round stats', data };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to fetch round stats' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
 
  // ═════════════════════════════════════════════════════════════
  // ADMIN: GAME ROUNDS OVERVIEW (list of rounds with summaries)
  //   GET /games/admin/:gameId/rounds-overview?status=CLOSED
  //
  //   Returns last 50 rounds for a game with betting summary.
  //   Filter by status: OPEN | CLOSED | RESULT_PUBLISHED | SETTLED
  //   Admin picks which round to inspect via the stats endpoint above.
  // ═════════════════════════════════════════════════════════════
  @UseGuards(AdminGuard)
  @Get('admin/:gameId/rounds-overview')
  async gameRoundsOverview(
    @Param('gameId', ParseIntPipe) gameId: number,
    @Query('status') status?: string,
  ) {
    try {
      const data = await this.gameService.getGameRoundsOverview(gameId, status);
      return { statusCode: HttpStatus.OK, message: 'Rounds overview', data };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to fetch rounds overview' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }


   // ═════════════════════════════════════════════════════════════
  // ADMIN: LIST ALL GAMES WITH ROUND INFO
  //   GET /games/admin/list
  //
  //   Returns all games. Each game includes:
  //     - latestRound: { id, roundCode, status, openTime, closeTime,
  //                      bets, staked, uniqueNumbers }
  //     - rounds: { total, active, closed }
  //     - allTime: { totalBets, totalStaked }
  //
  //   The latestRound.id is what admin passes to
  //   GET /games/admin/rounds/:roundId/stats to see full breakdown.
  // ═════════════════════════════════════════════════════════════
  @UseGuards(AdminGuard)
  @Get('admin/list')
  async adminListGames() {
    try {
      const data = await this.gameService.adminListGames();
      return {
        statusCode: HttpStatus.OK,
        message: 'Games list',
        count: data.length,
        data,
      };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to fetch games list' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
 
  // ═════════════════════════════════════════════════════════════
  // ADMIN: CREATE GAME + FIRST ROUND (single call)
  //   POST /games/admin/create-with-round
  //
  //   Body:
  //   {
  //     // Game
  //     "code": "WX3D",
  //     "name": "WinX 3-Digit",
  //     "digit_length": 3,
  //     "min_bet": 10,
  //     "max_bet": 5000,
  //     "payout_multiplier": 90,
  //     "display_category": "REGULAR",       // optional
  //     "max_payout_per_round": 100000,      // optional
  //     "description": "Pick 3 digits",      // optional
  //     // Round
  //     "round_code": "R20260510-001",
  //     "open_time": "2026-05-10T00:00:00Z",
  //     "close_time": "2026-05-10T23:59:00Z",
  //     "draw_time": "2026-05-11T00:30:00Z"
  //   }
  //
  //   Returns: { game: {...}, round: {...} }
  // ═════════════════════════════════════════════════════════════
  @UseGuards(AdminGuard)
  @Post('admin/create-with-round')
  async createGameWithRound(@Body() body: any) {
    try {
      if (!body.code || !body.name || !body.digit_length) {
        throw new BadRequestException('code, name, digit_length are required');
      }
      if (!body.round_code || !body.open_time || !body.close_time || !body.draw_time) {
        throw new BadRequestException('round_code, open_time, close_time, draw_time are required');
      }
 
      const result = await this.gameService.createGameWithRound({
        code:                body.code,
        name:                body.name,
        digit_length:        Number(body.digit_length),
        min_bet:             Number(body.min_bet    ?? 10),
        max_bet:             Number(body.max_bet    ?? 10000),
        payout_multiplier:   Number(body.payout_multiplier ?? 90),
        description:         body.description,
        thumbnail_url:       body.thumbnail_url,
        display_category:    body.display_category,
        max_payout_per_round: body.max_payout_per_round
          ? Number(body.max_payout_per_round) : undefined,
        round_code:  body.round_code,
        open_time:   body.open_time,
        close_time:  body.close_time,
        draw_time:   body.draw_time,
      });
 
      return {
        statusCode: HttpStatus.CREATED,
        message: 'Game and first round created successfully',
        data: result,
      };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to create game with round' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
 
  // ═════════════════════════════════════════════════════════════
  // ADMIN: CREATE ADDITIONAL ROUND FOR EXISTING GAME
  //   POST /games/admin/create-round
  //
  //   Body:
  //   {
  //     "game_id": 1,
  //     "round_code": "R20260511-001",
  //     "open_time": "2026-05-11T00:00:00Z",
  //     "close_time": "2026-05-11T23:59:00Z",
  //     "draw_time": "2026-05-12T00:30:00Z"
  //   }
  //
  //   Returns: { game: { id, name }, round: {...} }
  // ═════════════════════════════════════════════════════════════
  @UseGuards(AdminGuard)
  @Post('admin/create-round')
  async adminCreateRound(@Body() body: any) {
    try {
      if (!body.game_id || !body.round_code || !body.open_time ||
          !body.close_time || !body.draw_time) {
        throw new BadRequestException(
          'game_id, round_code, open_time, close_time, draw_time are required',
        );
      }
 
      const result = await this.gameService.adminCreateRound({
        game_id:    Number(body.game_id),
        round_code: body.round_code,
        open_time:  body.open_time,
        close_time: body.close_time,
        draw_time:  body.draw_time,
      });
 
      return {
        statusCode: HttpStatus.CREATED,
        message: 'Round created successfully',
        data: result,
      };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to create round' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════
// PATCH: Add to game.controller.ts (before closing })
// ═══════════════════════════════════════════════════════════════
 
  // DELETE /games/admin/:id           → soft delete (deactivate)
  // DELETE /games/admin/:id?hard=true → hard delete (only if no bets)
  @UseGuards(AdminGuard)
  @Delete('admin/:id')
  async deleteGame(
    @Param('id', ParseIntPipe) id: number,
    @Query('hard') hard?: string,
  ) {
    try {
      const result = await this.gameService.deleteGame(id, hard === 'true');
      return { statusCode: HttpStatus.OK, ...result };
    } catch (error: any) {
      throw new HttpException(
        { statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to delete game' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}