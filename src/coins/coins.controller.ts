import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Query,
  Req,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { CoinsService } from './coins.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AdminAdjustCoinsDto, UpdateCoinSettingsDto } from './dto/index';

@Controller('coins')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class CoinsController {
  constructor(private readonly coinsService: CoinsService) {}

  // ─── USER ────────────────────────────────────────────────────

  // GET /coins/me
  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMyCoins(@Req() req: any) {
    return this.coinsService.getMyCoins(req.user.sub);
  }

  // GET /coins/me/history?page=1&limit=20
  @UseGuards(JwtAuthGuard)  
  @Get('me/history')
  getMyCoinHistory(
    @Req() req: any,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.coinsService.getCoinHistory(req.user.sub, page, limit);
  }

  // ─── ADMIN ───────────────────────────────────────────────────

  // GET /coins/admin/settings
  @UseGuards(AdminGuard)
  @Get('admin/settings')
  getSettings() {
    return this.coinsService.getSettings();
  }

  // PATCH /coins/admin/settings
  @UseGuards(AdminGuard)
  @Patch('admin/settings')
  updateSettings(@Req() req: any, @Body() dto: UpdateCoinSettingsDto) {
    return this.coinsService.updateSettings(dto, req.user.sub);
  }

  // POST /coins/admin/adjust
  // body: { userId, amount (signed), reason }
  @UseGuards(AdminGuard)
  @Post('admin/adjust')
  adjust(@Req() req: any, @Body() dto: AdminAdjustCoinsDto) {
    return this.coinsService.adminAdjustCoins(dto, req.user.sub);
  }

  // GET /coins/admin/user/:userId/history
  @UseGuards(AdminGuard)
  @Get('admin/user/:userId/history')
  getUserHistory(
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('userId', ParseIntPipe) userId: number,
  ) {
    return this.coinsService.getCoinHistory(userId, page, limit);
  }
}