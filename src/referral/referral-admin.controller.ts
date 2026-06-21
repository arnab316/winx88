import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { ReferralAdminService } from './referral-admin.service';

/**
 * Admin dashboard + management for the refer-a-friend system.
 *
 *   GET   /admin/referrals/stats?from=&to=        → all dashboard KPIs
 *   GET   /admin/referrals/leaderboard?sort=&limit=
 *   GET   /admin/referrals/tree/:userId
 *   GET   /admin/referrals/config
 *   PATCH /admin/referrals/config                 → { wagering_multiplier: 8 }
 *   GET   /admin/referrals?status=&referrerId=&from=&to=&page=&limit=
 *   PATCH /admin/referrals/:id/disqualify         → { reason }
 *
 * Static segments (stats/leaderboard/tree/config) are declared before the
 * `:id` route so they resolve correctly.
 */
@Controller('admin/referrals')
@UseGuards(AdminGuard)
export class ReferralAdminController {
  constructor(private readonly admin: ReferralAdminService) {}

  @Get('stats')
  async stats(@Query('from') from?: string, @Query('to') to?: string) {
    return this.wrap(() => this.admin.getStats(from, to));
  }

  @Get('leaderboard')
  async leaderboard(
    @Query('sort') sort?: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    return this.wrap(() => this.admin.getLeaderboard(sort, limit));
  }

  @Get('tree/:userId')
  async tree(@Param('userId', ParseIntPipe) userId: number) {
    return this.wrap(() => this.admin.getTree(userId));
  }

  @Get('config')
  async getConfig() {
    return this.wrap(() => this.admin.getConfig());
  }

  @Patch('config')
  async updateConfig(@Req() req: any, @Body() body: Record<string, any>) {
    return this.wrap(() => this.admin.updateConfig(body, req.user?.sub));
  }

  @Post('fraud-scan')
  async fraudScan(@Query('dryRun') dryRun?: string) {
    return this.wrap(() => this.admin.fraudScan(dryRun === 'true'));
  }

  // Re-run completion for every eligible PENDING/ACTIVE referral (credits any
  // whose targets are all met but were never triggered by a deposit/bet event).
  @Post('recompute')
  async recomputeAll() {
    return this.wrap(() => this.admin.recompute());
  }

  @Post(':id/recompute')
  async recomputeOne(@Param('id', ParseIntPipe) id: number) {
    return this.wrap(() => this.admin.recompute(id));
  }

  @Get()
  async list(
    @Query('status') status?: string,
    @Query('referrerId') referrerId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    return this.wrap(() =>
      this.admin.listReferrals({
        status,
        referrerId:
          referrerId !== undefined && referrerId !== '' && !isNaN(Number(referrerId))
            ? Number(referrerId)
            : undefined,
        from,
        to,
        page,
        limit,
      }),
    );
  }

  @Patch(':id/disqualify')
  async disqualify(
    @Param('id', ParseIntPipe) id: number,
    @Body('reason') reason: string,
  ) {
    return this.wrap(() => this.admin.disqualify(id, reason));
  }

  private async wrap<T>(fn: () => Promise<T>) {
    try {
      return { success: true, data: await fn() };
    } catch (e: any) {
      throw new HttpException(
        { success: false, message: e?.message || 'Failed' },
        e?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
