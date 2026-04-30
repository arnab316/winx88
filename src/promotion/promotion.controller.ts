// src/promotion/promotion.controller.ts
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { PromotionEngineService  } from './promotion-engine.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import {
  CreatePromotionDto,
  UpdatePromotionDto,
  ListPromotionsQueryDto,
  ClaimPromocodeDto,
  GrantManualBonusDto,
  CancelClaimDto,
  PromotionKind,
  PROMOTION_KINDS,
} from './dto/promotion.dto';
import { PromotionStatsService } from './promotion-stats.service';
import { StatsQueryDto } from './dto/promotion-stats.dto';
@Controller('promotion')
export class PromotionController {


    constructor(private readonly engine: PromotionEngineService
      ,   private readonly statsService: PromotionStatsService, 
    ) {}


    // ─── USER ────────────────────────────────────────────────────
 
  // GET /promotions/me/available?kind=DEPOSIT
  @UseGuards(JwtAuthGuard)
  @Get('me/available')
  available(@Req() req: any, @Query('kind') kind?: string) {
    const validKind = (PROMOTION_KINDS as readonly string[]).includes(kind ?? '')
      ? (kind as PromotionKind)
      : undefined;
    return this.engine.listAvailableForUser(req.user.sub, validKind);
  }
 
  // GET /promotions/me/claims?page=1
  @UseGuards(JwtAuthGuard)
  @Get('me/claims')
  myClaims(
    @Req() req: any,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(30), ParseIntPipe) limit: number,
  ) {
    return this.engine.getMyClaims(req.user.sub, page, limit);
  }
 
  // POST /promotions/me/claim-code
  // body: { code: 'WELCOME100' }
  @UseGuards(JwtAuthGuard)
  @Post('me/claim-code')
  claimCode(@Req() req: any, @Body() dto: ClaimPromocodeDto) {
    return this.engine.claimByCode(req.user.sub, dto.code);
  }
 
  // ─── ADMIN ───────────────────────────────────────────────────
   // GET /promotion/admin/stats/overview?preset=THIS_MONTH
  // Single-row dashboard summary
  @UseGuards(AdminGuard)
  @Get('admin/stats/overview')
  statsOverview(@Query() q: StatsQueryDto) {
    return this.statsService.getOverview(q);
  }
  
    // GET /promotion/admin/stats/summary?preset=LAST_MONTH&currency=BDT&status=ACTIVE
  // Per-promotion table — matches screenshot 5
  @UseGuards(AdminGuard)
  @Get('admin/stats/summary')
  statsSummary(@Query() q: StatsQueryDto) {
    return this.statsService.getStatsSummary(q);
  }

  @UseGuards(AdminGuard)
  @Get('admin/:id/stats')
  statsForPromotion(
    @Param('id', ParseIntPipe) id: number,
    @Query() q: StatsQueryDto,
  ) {
    return this.statsService.getPromotionStats(id, q);
  }
  // GET /promotions/admin?kind=DEPOSIT&isActive=true&page=1
  @UseGuards(AdminGuard)
  @Get('admin')
  list(@Query() q: ListPromotionsQueryDto) {
    return this.engine.listPromotions(q);
  }
 
  // POST /promotions/admin
  @UseGuards(AdminGuard)
  @Post('admin')
  create(@Req() req: any, @Body() dto: CreatePromotionDto) {
    return this.engine.createPromotion(dto, req.user.sub);
  }
 
  // PATCH /promotions/admin/:id
  @UseGuards(AdminGuard)
  @Patch('admin/:id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePromotionDto) {
    return this.engine.updatePromotion(id, dto);
  }
 
  // DELETE /promotions/admin/:id   → soft delete (deactivate; never hard-delete because of FK)
  @UseGuards(AdminGuard)
  @Delete('admin/:id')
  deactivate(@Param('id', ParseIntPipe) id: number) {
    return this.engine.deactivate(id);
  }
 
  // GET /promotions/admin/:id/claims?page=1
  @UseGuards(AdminGuard)
  @Get('admin/:id/claims')
  listClaims(
    @Param('id', ParseIntPipe) id: number,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.engine.listClaimsForPromotion(id, page, limit);
  }
 
  // POST /promotions/admin/grant-manual
  // body: { userId, amount, rolloverMultiplier?, reason, bonusTo? }
  @UseGuards(AdminGuard)
  @Post('admin/grant-manual')
  grantManual(@Req() req: any, @Body() dto: GrantManualBonusDto) {
    return this.engine.grantManualBonus(dto, req.user.sub);
  }
 
  // POST /promotions/admin/cancel-claim
  // body: { claimId, reason }
  @UseGuards(AdminGuard)
  @Post('admin/cancel-claim')
  cancelClaim(@Req() req: any, @Body() dto: CancelClaimDto) {
    return this.engine.cancelClaim(dto, req.user.sub);
  }
}
