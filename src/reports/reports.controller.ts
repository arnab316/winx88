// src/reports/reports.controller.ts
import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ReportsService } from './reports.service';
import { AdminGuard } from '../common/guards/admin.guard';
import { PlayerReportQueryDto, PlayerDrillQueryDto } from './dto/reports.dto';

@Controller('reports')
@UseGuards(AdminGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

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
