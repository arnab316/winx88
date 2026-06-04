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
  UseGuards,
  ParseIntPipe,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { VipService } from './vip.service';
import { AdminGuard } from '../common/guards/admin.guard';
import { UpdateTierLimitsDto, SetTierBanksDto } from './dto/vip.dto';

@Controller('tiers')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class TierController {
  constructor(private readonly vipService: VipService) {}

  // GET /tiers/public — dashboard ladder (no auth)
  @Get('public')
  publicLadder() {
    return this.vipService.getPublicLadder();
  }

  // GET /tiers/admin — list tiers with banking-side fields
  @UseGuards(AdminGuard)
  @Get('admin')
  listAdmin() {
    return this.vipService.getTiersAdmin();
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
}
