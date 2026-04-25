// src/vip/vip.controller.ts
import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Req,
  UseGuards,
  ParseIntPipe,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { VipService } from './vip.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import {
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

  // GET /vip/admin/config
  @UseGuards(AdminGuard)
  @Get('admin/config')
  getConfig() {
    return this.vipService.getConfig();
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

  // POST /vip/admin/set-level
  // body: { userId, level, reason }
  @UseGuards(AdminGuard)
  @Post('admin/set-level')
  setLevel(@Req() req: any, @Body() dto: AdminSetVipLevelDto) {
    return this.vipService.adminSetLevel(dto, req.user.sub);
  }
}