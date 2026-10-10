import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../common/guards/admin.guard';
import { AdminActivityService } from './admin-activity.service';
import { ACTIVITY_RULES } from './admin-activity.rules';

/**
 * The Track log.
 *
 *   GET /admin/activity?userId=42                    everything done to player 42
 *   GET /admin/activity?adminId=7&from=2026-10-01    everything admin 7 did
 *   … &action=DEPOSIT_DECIDE&search=rejected&page=1&limit=20
 */
@Controller('admin/activity')
@UseGuards(AdminGuard)
export class AdminActivityController {
  constructor(private readonly activity: AdminActivityService) {}

  @Get()
  list(
    @Query('userId') userId?: string,
    @Query('adminId') adminId?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.activity.list({
      userId: userId ? Number(userId) : undefined,
      adminId: adminId ? Number(adminId) : undefined,
      action: action || undefined,
      from: from || undefined,
      to: to || undefined,
      search,
      page: Number(page) || 1,
      limit: Number(limit) || 20,
    });
  }

  /** Action keys for the filter dropdown. Unlisted routes are logged as OTHER. */
  @Get('actions')
  actions() {
    return [...new Set(ACTIVITY_RULES.map((r) => r.action)), 'OTHER'];
  }
}
