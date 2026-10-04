import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SuperAdminGuard } from '../common/guards/super-admin.guard';
import { DashboardService } from './dashboard.service';

/**
 * Super-admin financial dashboard. The admin panel shows this page to super
 * admins only (everyone else gets the workspace launcher), so the API matches.
 *
 *   GET /admin/dashboard?range=today|7d|30d&bigWinMultiplier=10&bigWinMin=1000
 */
@Controller('admin/dashboard')
@UseGuards(SuperAdminGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  get(
    @Query('range') range?: string,
    @Query('bigWinMultiplier') bigWinMultiplier?: string,
    @Query('bigWinMin') bigWinMin?: string,
  ) {
    const num = (v?: string) => {
      const n = Number(v);
      return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    return this.dashboard.getDashboard({
      range,
      bigWinMultiplier: num(bigWinMultiplier),
      bigWinMin: num(bigWinMin),
    });
  }
}
