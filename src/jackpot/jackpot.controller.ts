// src/jackpot/jackpot.controller.ts
import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, Req,
  UseGuards, ParseIntPipe, DefaultValuePipe,
  UsePipes, ValidationPipe, BadRequestException,
} from '@nestjs/common';
import { JackpotService } from './jackpot.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import {
  CreateJackpotPoolDto,
  UpdateJackpotPoolDto,
  AdjustPrizeDto,
  PickWinnerDto,
  ListJackpotPoolsQueryDto,
} from './dto/jackpot.dto';

@Controller('jackpot')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class JackpotController {
  constructor(private readonly jackpotService: JackpotService) {}

  // ─── PUBLIC ───────────────────────────────────────────────────

  // GET /jackpot/active?lang=en
  @Get('active')
  activePools(@Query('lang') lang?: string) {
    const safeLang = lang === 'bn' ? 'bn' : 'en';
    return this.jackpotService.getActivePoolsPublic(safeLang);
  }

  // GET /jackpot/winners?limit=20&lang=en
  @Get('winners')
  pastWinners(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('lang') lang?: string,
  ) {
    const safeLang = lang === 'bn' ? 'bn' : 'en';
    return this.jackpotService.getPastWinners(limit, safeLang);
  }

  // ─── ADMIN ────────────────────────────────────────────────────

  // GET /jackpot/admin?status=ACTIVE&page=1
  @UseGuards(AdminGuard)
  @Get('admin')
  list(@Query() q: ListJackpotPoolsQueryDto) {
    return this.jackpotService.listPools(q);
  }

  // GET /jackpot/admin/:id
  @UseGuards(AdminGuard)
  @Get('admin/:id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.jackpotService.getPool(id);
  }

  // POST /jackpot/admin
  @UseGuards(AdminGuard)
  @Post('admin')
  create(@Req() req: any, @Body() dto: CreateJackpotPoolDto) {
    return this.jackpotService.createPool(dto, req.user.sub);
  }

  // PATCH /jackpot/admin/:id  (DRAFT only)
  @UseGuards(AdminGuard)
  @Patch('admin/:id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateJackpotPoolDto,
  ) {
    return this.jackpotService.updatePool(id, dto);
  }

  // POST /jackpot/admin/:id/activate  (DRAFT → ACTIVE)
  @UseGuards(AdminGuard)
  @Post('admin/:id/activate')
  activate(@Param('id', ParseIntPipe) id: number) {
    return this.jackpotService.activatePool(id);
  }

  // POST /jackpot/admin/:id/close  (ACTIVE → CLOSED)
  @UseGuards(AdminGuard)
  @Post('admin/:id/close')
  close(@Param('id', ParseIntPipe) id: number) {
    return this.jackpotService.closePool(id);
  }

  // POST /jackpot/admin/:id/cancel  (any status → CANCELLED)
  // body: { reason }
  @UseGuards(AdminGuard)
  @Post('admin/:id/cancel')
  cancel(
    @Param('id', ParseIntPipe) id: number,
    @Body('reason') reason: string,
  ) {
    if (!reason || reason.trim().length < 3) {
      throw new BadRequestException('reason is required (min 3 chars)');
    }
    return this.jackpotService.cancelPool(id, reason);
  }

  // POST /jackpot/admin/:id/adjust-prize
  // body: { delta, reason }
  @UseGuards(AdminGuard)
  @Post('admin/:id/adjust-prize')
  adjustPrize(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AdjustPrizeDto,
  ) {
    return this.jackpotService.adjustPrize(id, dto, req.user.sub);
  }

  // GET /jackpot/admin/:id/participants?page=1&limit=100
  // Lists all eligible users — admin uses this to pick a winner
  @UseGuards(AdminGuard)
  @Get('admin/:id/participants')
  participants(
    @Param('id', ParseIntPipe) id: number,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ) {
    return this.jackpotService.getParticipants(id, page, limit);
  }

  // POST /jackpot/admin/:id/pick-winner
  // body: { userId, reason }
  @UseGuards(AdminGuard)
  @Post('admin/:id/pick-winner')
  pickWinner(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PickWinnerDto,
  ) {
    return this.jackpotService.pickWinner(id, dto, req.user.sub);
  }
}