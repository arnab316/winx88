// src/spin/spin.controller.ts
import {
  Controller, Get, Post, Patch, Put, Delete,
  Body, Param, Query, Req, UseGuards,
  ParseIntPipe, UsePipes, ValidationPipe,
} from '@nestjs/common';

import { SpinService } from './spin.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import {
  CreateSpinWheelDto, UpdateSpinWheelDto, ReplaceSegmentsDto,
  ListSpinWheelsQueryDto, ListSpinResultsQueryDto,
  PlayerSpinQueryDto, MySpinHistoryQueryDto, SpinNowDto,
} from './dto/spin.dto';

@Controller('spin')
@UsePipes(new ValidationPipe({
  whitelist: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
}))
export class SpinController {
  constructor(private readonly spin: SpinService) {}

  // ─── PUBLIC (GUEST) ───────────────────────────────────────────
  /**
   * The wheel a logged-out visitor sees. Same payload as `me`, but with
   * `canSpin: false` — a guest can look at the prizes, not take them.
   */
  @Get('public')
  publicWheel(@Query() q: PlayerSpinQueryDto) {
    return this.spin.getStateForUser(null, q.currency ?? 'BDT');
  }

  // ─── PLAYER ───────────────────────────────────────────────────
  /**
   * Everything the wheel screen needs in one call: the slices to draw, the
   * schedule, when the window opens and closes, how many spins are left, and
   * a single `canSpin` flag for the button.
   */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  myWheel(@Req() req: any, @Query() q: PlayerSpinQueryDto) {
    return this.spin.getStateForUser(req.user.sub, q.currency ?? 'BDT');
  }

  /**
   * Spin.
   *
   * The body carries no prize — the winning slice is drawn server-side and
   * returned as `segmentPosition` for the client to animate to. Anything the
   * client sent about which slice it "landed on" would be worthless.
   */
  @UseGuards(JwtAuthGuard)
  @Post('me/spin')
  spinNow(@Req() req: any, @Body() dto: SpinNowDto) {
    return this.spin.spin(req.user.sub, dto, {
      ipAddress: req.ip ?? req.headers?.['x-forwarded-for'],
      deviceFingerprint: req.headers?.['x-device-fingerprint'],
    });
  }

  @UseGuards(JwtAuthGuard)
  @Get('me/history')
  myHistory(@Req() req: any, @Query() q: MySpinHistoryQueryDto) {
    return this.spin.getMyHistory(req.user.sub, q);
  }

  // ─── ADMIN ────────────────────────────────────────────────────
  // NOTE: the static admin routes are declared before `admin/:id`, or Nest
  // matches "results" as an :id and ParseIntPipe rejects it with a 400.

  @UseGuards(AdminGuard)
  @Get('admin')
  list(@Query() q: ListSpinWheelsQueryDto) {
    return this.spin.list(q);
  }

  /** Every spin across every wheel — the payout audit. */
  @UseGuards(AdminGuard)
  @Get('admin/results')
  results(@Query() q: ListSpinResultsQueryDto) {
    return this.spin.listResults(q);
  }

  @UseGuards(AdminGuard)
  @Post('admin')
  create(@Req() req: any, @Body() dto: CreateSpinWheelDto) {
    return this.spin.create(dto, req.user.sub);
  }

  /**
   * One wheel with its slices, each carrying the admin-only `weight` plus the
   * `chance` it implies, and the wheel's `expectedCostPerSpin`.
   */
  @UseGuards(AdminGuard)
  @Get('admin/:id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.spin.getOne(id);
  }

  /** Spins, players, amount paid, and configured-vs-actual odds per slice. */
  @UseGuards(AdminGuard)
  @Get('admin/:id/stats')
  stats(@Param('id', ParseIntPipe) id: number) {
    return this.spin.stats(id);
  }

  @UseGuards(AdminGuard)
  @Patch('admin/:id')
  update(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSpinWheelDto,
  ) {
    return this.spin.update(id, dto, req.user.sub);
  }

  /**
   * Replace the whole slice set in one call — the shape the wheel editor sends
   * on save. Must contain exactly `segmentCount` segments covering every
   * position once.
   */
  @UseGuards(AdminGuard)
  @Put('admin/:id/segments')
  replaceSegments(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReplaceSegmentsDto,
  ) {
    return this.spin.replaceSegments(id, dto, req.user.sub);
  }

  /** Soft delete — sets `is_active = false`. Spin history is kept. */
  @UseGuards(AdminGuard)
  @Delete('admin/:id')
  deactivate(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.spin.deactivate(id, req.user.sub);
  }
}
