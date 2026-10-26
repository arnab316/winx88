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

  /**
   * Where the period's NEW REGISTRATIONS came from, grouped channel type ->
   * source, for the merged-cell breakdown behind that card.
   *
   *   GET /admin/dashboard/registrations?range=today&channelType=Affiliate
   */
  @Get('registrations')
  registrations(
    @Query('range') range?: string,
    @Query('channelType') channelType?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.dashboard.getRegistrationBreakdown({
      range,
      channelType: channelType?.trim() || undefined,
      page: Number(page) || 1,
      limit: Number(limit) || 50,
    });
  }

  /**
   * The drill-down behind the DEPOSITS card.
   *
   *   GET /admin/dashboard/deposits?range=today&source=MANUAL&page=1&limit=25
   *
   * Same range values as the card itself, so the totals reconcile with the
   * figure the admin clicked. `source` narrows the LIST only; the summary and
   * the breakdown tables always cover the whole range.
   */
  @Get('deposits')
  deposits(
    @Query('range') range?: string,
    @Query('source') source?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.dashboard.getDepositBreakdown({
      range,
      source: source?.trim() || undefined,
      page: Number(page) || 1,
      limit: Number(limit) || 25,
    });
  }
}
