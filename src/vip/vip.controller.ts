// src/vip/vip.controller.ts
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
import { VipService } from './vip.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import {
  CreateVipLevelConfigDto,
  UpdateVipLevelConfigDto,
  AdminSetVipLevelDto,
} from './dto/vip.dto';

@Controller('vip')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class VipController {
  constructor(private readonly vipService: VipService) {}

  // ─── USER ────────────────────────────────────────────────────

  // GET /vip/me — current level + progress to next
  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMyVip(@Req() req: any) {
    return this.vipService.getMyVip(req.user.sub);
  }

  // GET /vip/levels — public list (also useful for the user's tier UI)
  @UseGuards(JwtAuthGuard)
  @Get('levels')
  getAllLevels() {
    return this.vipService.getAllLevels();
  }

  // ─── ADMIN ───────────────────────────────────────────────────

  // GET /vip/admin/stats — dashboard summary cards
  @UseGuards(AdminGuard)
  @Get('admin/stats')
  getDashboardStats() {
    return this.vipService.getDashboardStats();
  }

  // GET /vip/admin/config
  @UseGuards(AdminGuard)
  @Get('admin/config')
  getConfig() {
    return this.vipService.getConfig();
  }

  // POST /vip/admin/config — create a new VIP level / tier
  @UseGuards(AdminGuard)
  @Post('admin/config')
  createConfig(@Body() dto: CreateVipLevelConfigDto) {
    return this.vipService.createLevel(dto);
  }

  // PATCH /vip/admin/config/:level
  @UseGuards(AdminGuard)
  @Patch('admin/config/:level')
  updateConfig(
    @Param('level', ParseIntPipe) level: number,
    @Body() dto: UpdateVipLevelConfigDto,
  ) {
    return this.vipService.updateConfig(level, dto);
  }

  // DELETE /vip/admin/config/:level — remove a VIP level / tier
  @UseGuards(AdminGuard)
  @Delete('admin/config/:level')
  deleteConfig(@Param('level', ParseIntPipe) level: number) {
    return this.vipService.deleteLevel(level);
  }

  // POST /vip/admin/set-level
  // body: { userId, level, reason }
  @UseGuards(AdminGuard)
  @Post('admin/set-level')
  setLevel(@Req() req: any, @Body() dto: AdminSetVipLevelDto) {
    return this.vipService.adminSetLevel(dto, req.user.sub);
  }

  // GET /vip/admin/users — ALL users across every tier (optional ?level= & ?search=)
  @UseGuards(AdminGuard)
  @Get('admin/users')
  allUsersByLevel(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('level') level?: string,
    @Query('search') search?: string,
  ) {
    const lvl =
      level !== undefined && level !== '' && !isNaN(Number(level))
        ? Number(level)
        : undefined;
    return this.vipService.getAllUsersByLevel(page, limit, lvl, search);
  }

  // GET /vip/admin/levels/summary — every tier with its player count (grouped)
  @UseGuards(AdminGuard)
  @Get('admin/levels/summary')
  levelsSummary() {
    return this.vipService.getLevelsUserCounts();
  }

  // GET /vip/admin/users/:level — players currently in a tier (modal list)
  //   Optional ?search= (username / member ID / email)
  @UseGuards(AdminGuard)
  @Get('admin/users/:level')
  usersInTier(
    @Param('level', ParseIntPipe) level: number,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('search') search?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.vipService.getUsersInTier(level, page, limit, search, dateFrom, dateTo);
  }
}