import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { CoinsService } from './coins.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';

@Controller('coins')
export class CoinsController {
  constructor(private readonly coinsService: CoinsService) {}

  // ─────────────────────────────────────────────────────────────
  // USER ROUTES
  // ─────────────────────────────────────────────────────────────

  // GET /coins/summary
  @UseGuards(JwtAuthGuard)
  @Get('summary')
  getMySummary(@Req() req: any) {
    return this.coinsService.getMyCoinSummary(req.user.sub);
  }

  // GET /coins/history?page=1&limit=20
  @UseGuards(JwtAuthGuard)
  @Get('history')
  getCoinHistory(
    @Req() req: any,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.coinsService.getCoinHistory(req.user.sub, page, limit);
  }

  // GET /coins/levels
  @UseGuards(JwtAuthGuard)
  @Get('levels')
  getAllLevels() {
    return this.coinsService.getAllVipLevels();
  }

  // ─────────────────────────────────────────────────────────────
  // ADMIN ROUTES
  // ─────────────────────────────────────────────────────────────

  // GET /coins/admin/settings
  @UseGuards(AdminGuard)
  @Get('admin/settings')
  getCoinSettings() {
    return this.coinsService.getCoinSettings();
  }

  // PATCH /coins/admin/settings
  // body: { coinsPerUnit, depositUnit, minDepositAmount, maxDepositAmount? }
  @UseGuards(AdminGuard)
  @Patch('admin/settings')
  updateCoinSettings(@Req() req: any, @Body() body: any) {
    return this.coinsService.updateCoinSettings({
      adminId:          req.user.sub,
      coinsPerUnit:     parseFloat(body.coinsPerUnit),
      depositUnit:      parseFloat(body.depositUnit),
      minDepositAmount: parseFloat(body.minDepositAmount),
      maxDepositAmount: body.maxDepositAmount ? parseFloat(body.maxDepositAmount) : undefined,
    });
  }

  // POST /coins/admin/levels
  // body: { level, levelName, groupName?, coinsRequired, badgeIconUrl?, benefits? }
  @UseGuards(AdminGuard)
  @Post('admin/levels')
  upsertVipLevel(@Req() req: any, @Body() body: any) {
    return this.coinsService.upsertVipLevel({
      adminId:       req.user.sub,
      level:         parseInt(body.level),
      levelName:     body.levelName,
      groupName:     body.groupName,
      coinsRequired: parseFloat(body.coinsRequired),
      badgeIconUrl:  body.badgeIconUrl,
      benefits:      body.benefits,
    });
  }

  // GET /coins/admin/levels
  @UseGuards(AdminGuard)
  @Get('admin/levels')
  getAdminLevels() {
    return this.coinsService.getAllVipLevels();
  }
}