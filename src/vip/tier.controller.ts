// src/vip/tier.controller.ts
//
// Banking-side ("Member Group" screen) + public-ladder view over the
// single canonical tier entity (vip_level_config). The loyalty-side editor
// lives in VipController; both edit the same rows.
import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Body,
  Param,
  Req,
  UseGuards,
  ParseIntPipe,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { VipService } from './vip.service';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import {
  UpdateTierLimitsDto,
  CreateMemberGroupDto,
  UpdateMemberGroupDto,
  SetTierBanksDto,
  UpdateBankingTogglesDto,
} from './dto/vip.dto';

@Controller('tiers')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class TierController {
  constructor(private readonly vipService: VipService) {}

  // GET /tiers/public — dashboard ladder (no auth)
  @Get('public')
  publicLadder() {
    return this.vipService.getPublicLadder();
  }

  // GET /tiers/admin — list tiers with banking-side fields (raw)
  @UseGuards(AdminGuard)
  @Get('admin')
  listAdmin() {
    return this.vipService.getTiersAdmin();
  }

  // GET /tiers/admin/member-groups — withdrawal-limits table, grouped by currency
  @UseGuards(AdminGuard)
  @Get('admin/member-groups')
  memberGroupList() {
    return this.vipService.getMemberGroupList();
  }

  // POST /tiers/admin — create a member group / tier (with banking limits)
  @UseGuards(AdminGuard)
  @Post('admin')
  createMemberGroup(@Body() dto: CreateMemberGroupDto) {
    return this.vipService.createMemberGroup(dto);
  }

  // PATCH /tiers/admin/:level — edit a member group in one call
  //   (name + withdrawal limits + status + currency + default flag)
  @UseGuards(AdminGuard)
  @Patch('admin/:level')
  updateMemberGroup(
    @Param('level', ParseIntPipe) level: number,
    @Body() dto: UpdateMemberGroupDto,
  ) {
    return this.vipService.updateMemberGroup(level, dto);
  }

  // PATCH /tiers/admin/:level/limits — deposit/withdrawal limits, turnover, etc.
  @UseGuards(AdminGuard)
  @Patch('admin/:level/limits')
  updateLimits(
    @Param('level', ParseIntPipe) level: number,
    @Body() dto: UpdateTierLimitsDto,
  ) {
    return this.vipService.updateTierLimits(level, dto);
  }

  // GET /tiers/admin/:level/banks — allowed payment channels
  @UseGuards(AdminGuard)
  @Get('admin/:level/banks')
  getBanks(@Param('level', ParseIntPipe) level: number) {
    return this.vipService.getTierBanks(level);
  }

  // PUT /tiers/admin/:level/banks — replace the channel set
  @UseGuards(AdminGuard)
  @Put('admin/:level/banks')
  setBanks(
    @Param('level', ParseIntPipe) level: number,
    @Body() dto: SetTierBanksDto,
  ) {
    return this.vipService.setTierBanks(level, dto);
  }

  // POST /tiers/admin/:level/set-default — default tier for new players
  @UseGuards(AdminGuard)
  @Post('admin/:level/set-default')
  setDefault(@Param('level', ParseIntPipe) level: number) {
    return this.vipService.setDefaultTier(level);
  }

  // ─── Banking toggles: 2 master + deposit/withdrawal per channel ──

  // GET /tiers/admin/:level/banking — the tier's 10 toggle states
  @UseGuards(AdminGuard)
  @Get('admin/:level/banking')
  getBankingToggles(@Param('level', ParseIntPipe) level: number) {
    return this.vipService.getBankingToggles(level);
  }

  // PATCH /tiers/admin/:level/banking
  //   body: { depositEnabled?, withdrawalEnabled?,
  //           channels?: [{ channel, depositEnabled?, withdrawalEnabled? }] }
  @UseGuards(AdminGuard)
  @Patch('admin/:level/banking')
  updateBankingToggles(
    @Param('level', ParseIntPipe) level: number,
    @Body() dto: UpdateBankingTogglesDto,
  ) {
    return this.vipService.updateBankingToggles(level, dto);
  }

  // GET /tiers/me/banking — effective toggles for the logged-in player
  // (deposit/withdraw pages use this to hide disabled methods).
  @UseGuards(JwtAuthGuard)
  @Get('me/banking')
  myBankingToggles(@Req() req: any) {
    return this.vipService.getMyBankingToggles(req.user.sub);
  }
}
