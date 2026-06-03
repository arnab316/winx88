// src/jackpot/jackpot.controller.ts
import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, Req,
  UseGuards, ParseIntPipe, DefaultValuePipe,
  UsePipes, ValidationPipe, BadRequestException,
} from '@nestjs/common';
import { JackpotService } from './jackpot.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import {
  CreateJackpotSessionDto,
  UpdateJackpotSessionDto,
  AdjustJackpotPrizeDto,
  PublishJackpotResultDto,
  AddJackpotHotNumberDto,
  PlaceJackpotBetDto,
  ListJackpotSessionsQueryDto,
  ListJackpotBetsQueryDto,
} from './dto/jackpot.dto';

/**
 * Jackpot Number Game API
 *
 * Public endpoints (no auth):
 *   GET  /jackpot/active              – list active sessions
 *   GET  /jackpot/history             – past awarded sessions
 *   GET  /jackpot/:id/hot-numbers     – hot number suggestions for a session
 *
 * Authenticated user endpoints:
 *   POST /jackpot/:id/bet             – place a bet on a jackpot session
 *   GET  /jackpot/:id/my-bets         – user's own bets for a session
 *
 * Admin endpoints:
 *   POST   /jackpot/admin                        – create session (DRAFT)
 *   GET    /jackpot/admin                        – list all sessions
 *   GET    /jackpot/admin/:id                    – get session detail
 *   PATCH  /jackpot/admin/:id                    – update (DRAFT only)
 *   POST   /jackpot/admin/:id/activate           – DRAFT → ACTIVE
 *   POST   /jackpot/admin/:id/close              – ACTIVE → CLOSED
 *   POST   /jackpot/admin/:id/cancel             – any → CANCELLED
 *   POST   /jackpot/admin/:id/adjust-prize       – adjust prize amount
 *   POST   /jackpot/admin/:id/publish-result     – publish winning number + settle bets
 *   GET    /jackpot/admin/:id/stats              – bet stats for a session
 *   GET    /jackpot/admin/:id/bets               – all bets for a session
 *   POST   /jackpot/admin/:id/hot-numbers        – add hot number suggestion
 *   DELETE /jackpot/admin/:id/hot-numbers/:hnId  – remove hot number
 */
@Controller('jackpot')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class JackpotController {
  constructor(private readonly jackpotService: JackpotService) {}

  // ─── PUBLIC ───────────────────────────────────────────────────

  /** Active jackpot sessions visible to all users */
  @Get('active')
  activeSessions(@Query('lang') lang?: string) {
    return this.jackpotService.getActiveSessions(lang === 'bn' ? 'bn' : 'en');
  }

  /** Past awarded sessions — shows winning numbers */
  @Get('history')
  history(
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('lang') lang?: string,
  ) {
    return this.jackpotService.getPastSessions(limit, lang === 'bn' ? 'bn' : 'en');
  }

  /** Hot number suggestions for a specific session (public) */
  @Get(':id/hot-numbers')
  hotNumbers(@Param('id', ParseIntPipe) id: number) {
    return this.jackpotService.listHotNumbers(id);
  }

  // ─── AUTHENTICATED USER ──────────────────────────────────────

  /**
   * Place a bet on an active jackpot session.
   * Body: { betNumber: "897456", betAmount: 100 }
   */
  @UseGuards(JwtAuthGuard)
  @Post(':id/bet')
  placeBet(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PlaceJackpotBetDto,
  ) {
    return this.jackpotService.placeBet(id, req.user.sub, dto);
  }

  /** User's own bets for a session */
  @UseGuards(JwtAuthGuard)
  @Get(':id/my-bets')
  myBets(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.jackpotService.getUserBets(id, req.user.sub, page, limit);
  }

  // ─── ADMIN ────────────────────────────────────────────────────

  /**
   * Create a new jackpot session (starts as DRAFT).
   * Body: { nameEn, prizeAmount, digitLength: 6|7, periodType: WEEKLY|MONTHLY|CUSTOM, ... }
   */
  @UseGuards(AdminGuard)
  @Post('admin')
  create(@Req() req: any, @Body() dto: CreateJackpotSessionDto) {
    return this.jackpotService.createSession(dto, req.user.sub);
  }

  /** List all jackpot sessions with optional filters */
  @UseGuards(AdminGuard)
  @Get('admin')
  list(@Query() q: ListJackpotSessionsQueryDto) {
    return this.jackpotService.listSessions(q);
  }

  /** Get full details for one session (includes adjustments + round info) */
  @UseGuards(AdminGuard)
  @Get('admin/:id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.jackpotService.getSession(id);
  }

  /** Update session fields — only works in DRAFT status */
  @UseGuards(AdminGuard)
  @Patch('admin/:id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateJackpotSessionDto,
  ) {
    return this.jackpotService.updateSession(id, dto);
  }

  /**
   * Activate session: DRAFT → ACTIVE.
   * Creates the backing game_round; betting opens immediately.
   */
  @UseGuards(AdminGuard)
  @Post('admin/:id/activate')
  activate(@Param('id', ParseIntPipe) id: number) {
    return this.jackpotService.activateSession(id);
  }

  /**
   * Close session: ACTIVE → CLOSED.
   * Stops new bets. Admin must publish result to settle existing bets.
   */
  @UseGuards(AdminGuard)
  @Post('admin/:id/close')
  close(@Param('id', ParseIntPipe) id: number) {
    return this.jackpotService.closeSession(id);
  }

  /**
   * Cancel session (DRAFT, ACTIVE, or CLOSED → CANCELLED).
   * Cancels any open bets. Prize is NOT paid out.
   * Body: { reason: "string" }
   */
  @UseGuards(AdminGuard)
  @Post('admin/:id/cancel')
  cancel(
    @Param('id', ParseIntPipe) id: number,
    @Body('reason') reason: string,
  ) {
    if (!reason || reason.trim().length < 3) {
      throw new BadRequestException('reason is required (min 3 chars)');
    }
    return this.jackpotService.cancelSession(id, reason);
  }

  /**
   * Adjust prize pool mid-event (DRAFT or ACTIVE).
   * Body: { delta: 5000, reason: "Sponsored top-up" }
   */
  @UseGuards(AdminGuard)
  @Post('admin/:id/adjust-prize')
  adjustPrize(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AdjustJackpotPrizeDto,
  ) {
    return this.jackpotService.adjustPrize(id, dto, req.user.sub);
  }

  /**
   * Publish winning number: closes betting and settles all bets.
   * Status: ACTIVE|CLOSED → AWARDED.
   * Body: { resultNumber: "897456" }  (must match session digitLength)
   */
  @UseGuards(AdminGuard)
  @Post('admin/:id/publish-result')
  publishResult(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PublishJackpotResultDto,
  ) {
    return this.jackpotService.publishResult(id, dto, req.user.sub);
  }

  /**
   * Bet stats for a session: totals, unique bettors, top numbers.
   */
  @UseGuards(AdminGuard)
  @Get('admin/:id/stats')
  stats(@Param('id', ParseIntPipe) id: number) {
    return this.jackpotService.getSessionStats(id);
  }

  /**
   * All individual bets for a session (paginated).
   * ?resultStatus=WON|LOST|PLACED&page=1&limit=50
   */
  @UseGuards(AdminGuard)
  @Get('admin/:id/bets')
  bets(
    @Param('id', ParseIntPipe) id: number,
    @Query() q: ListJackpotBetsQueryDto,
  ) {
    return this.jackpotService.listBets(id, q);
  }

  /**
   * Add a hot number suggestion for this session's game.
   * Body: { number: "111111", note: "Lucky pick", priority: 10 }
   */
  @UseGuards(AdminGuard)
  @Post('admin/:id/hot-numbers')
  addHotNumber(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddJackpotHotNumberDto,
  ) {
    return this.jackpotService.addHotNumber(id, dto, req.user.sub);
  }

  /**
   * Remove a hot number suggestion by its ID.
   */
  @UseGuards(AdminGuard)
  @Delete('admin/:id/hot-numbers/:hnId')
  removeHotNumber(
    @Param('id', ParseIntPipe) id: number,
    @Param('hnId', ParseIntPipe) hnId: number,
  ) {
    return this.jackpotService.removeHotNumber(id, hnId);
  }
}
