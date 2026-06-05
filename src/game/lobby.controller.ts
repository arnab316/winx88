// src/game/lobby.controller.ts
//
// New READ endpoints. Shares the 'games' prefix; no route collisions
// with GameController or ScheduleController (verified).
//
//   PUBLIC (no guard — same as your other public listings):
//     GET /games/lobby                          -> live games + categories + hot numbers
//     GET /games/hot-numbers/by-category        -> hot numbers bucketed 1D/3D/4D/5D
//
//   ADMIN (AdminGuard):
//     GET /games/admin/rounds/awaiting-result   -> closed, no result yet
//     GET /games/admin/rounds/result-declared   -> result published/settled
//     GET /games/admin/rounds/:roundId/players  -> who bet on a round

import {
  Controller, Get, Param, Query, ParseIntPipe, DefaultValuePipe,
  HttpStatus, HttpException, UseGuards,
} from '@nestjs/common';
import { LobbyService } from './lobby.service';
import { AdminGuard } from '../common/guards/admin.guard';

@Controller('games')
export class LobbyController {
  constructor(private readonly lobbyService: LobbyService) {}

  // ── PUBLIC ──────────────────────────────────────────────────

  // GET /games/lobby
  @Get('lobby')
  async lobby() {
    try {
      const data = await this.lobbyService.lobby();
      return { statusCode: HttpStatus.OK, message: 'Lobby', data };
    } catch (e: any) {
      throw new HttpException(
        { statusCode: e?.status || 500, message: e?.message || 'Error' },
        e?.status || 500,
      );
    }
  }

  // GET /games/hot-numbers/by-category
  @Get('hot-numbers/by-category')
  async hotNumbersByCategory() {
    try {
      const data = await this.lobbyService.hotNumbersByCategory();
      return { statusCode: HttpStatus.OK, message: 'Hot numbers by category', data };
    } catch (e: any) {
      throw new HttpException(
        { statusCode: e?.status || 500, message: e?.message || 'Error' },
        e?.status || 500,
      );
    }
  }

  // ── ADMIN ───────────────────────────────────────────────────

  // GET /games/admin/rounds/awaiting-result?page=1&limit=20
  @UseGuards(AdminGuard)
  @Get('admin/rounds/awaiting-result')
  async awaitingResult(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    try {
      const result = await this.lobbyService.roundsAwaitingResult(page, limit);
      return {
        statusCode: HttpStatus.OK,
        message: 'Rounds awaiting result',
        ...result,
      };
    } catch (e: any) {
      throw new HttpException(
        { statusCode: e?.status || 500, message: e?.message || 'Error' },
        e?.status || 500,
      );
    }
  }

  // GET /games/admin/rounds/result-declared?page=1&limit=20
  @UseGuards(AdminGuard)
  @Get('admin/rounds/result-declared')
  async resultDeclared(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    try {
      const result = await this.lobbyService.roundsResultDeclared(page, limit);
      return {
        statusCode: HttpStatus.OK,
        message: 'Rounds with result declared',
        ...result,
      };
    } catch (e: any) {
      throw new HttpException(
        { statusCode: e?.status || 500, message: e?.message || 'Error' },
        e?.status || 500,
      );
    }
  }

  // GET /games/admin/rounds/:roundId/players
  @UseGuards(AdminGuard)
  @Get('admin/rounds/:roundId/players')
  async roundPlayers(@Param('roundId', ParseIntPipe) roundId: number) {
    try {
      const data = await this.lobbyService.roundPlayers(roundId);
      return {
        statusCode: HttpStatus.OK,
        message: 'Round players',
        count: data.length,
        data,
      };
    } catch (e: any) {
      throw new HttpException(
        { statusCode: e?.status || 500, message: e?.message || 'Error' },
        e?.status || 500,
      );
    }
  }
}