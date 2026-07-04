// src/reports/reports.controller.ts
import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  UseGuards,
  ParseIntPipe,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { ReportsService } from './reports.service';
import { AdminGuard } from '../common/guards/admin.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import {
  PlayerReportQueryDto,
  PlayerDrillQueryDto,
  MemberSummaryQueryDto,
} from './dto/reports.dto';

@Controller('reports')
@UseGuards(AdminGuard, PermissionsGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  // GET /reports/member-summary — the admin Report page table
  //   ?dateFrom&dateTo&currency&memberGroup&username&page&limit
  @Get('member-summary')
  @RequirePermissions('reports', 'view')
  memberSummary(@Query() q: MemberSummaryQueryDto) {
    return this.reports.getMemberSummary(q);
  }

  // GET /reports/member-summary/export — CSV download (Export button)
  @Get('member-summary/export')
  @RequirePermissions('reports', 'export')
  async memberSummaryExport(
    @Query() q: MemberSummaryQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const csv = await this.reports.getMemberSummaryCsv(q);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="member-report-${stamp}.csv"`,
    );
    return csv;
  }

  // GET /reports/players
  @Get('players')
  players(@Query() q: PlayerReportQueryDto) {
    return this.reports.getPlayerReports(q);
  }

  // GET /reports/players/:userId
  @Get('players/:userId')
  player(@Param('userId', ParseIntPipe) userId: number, @Query() q: PlayerDrillQueryDto) {
    return this.reports.getPlayerReport(userId, q);
  }

  // GET /reports/players/:userId/bets
  @Get('players/:userId/bets')
  bets(@Param('userId', ParseIntPipe) userId: number, @Query() q: PlayerDrillQueryDto) {
    return this.reports.getPlayerBets(userId, q);
  }

  // GET /reports/players/:userId/transactions
  @Get('players/:userId/transactions')
  transactions(@Param('userId', ParseIntPipe) userId: number, @Query() q: PlayerDrillQueryDto) {
    return this.reports.getPlayerTransactions(userId, q);
  }
}
