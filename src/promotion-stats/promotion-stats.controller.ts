// src/promotion-stats/promotion-stats.controller.ts
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
import { PromotionStatsService } from './promotion-stats.service';
import { AdminGuard } from '../common/guards/admin.guard';
import { StatsQueryDto } from './dto/promotion-stats.dto';

@Controller('promotion-stats')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@UseGuards(AdminGuard)
export class PromotionStatsController {
  constructor(private readonly stats: PromotionStatsService) {}

  // GET /promotion-stats/overview?currency=BDT&range=THIS_WEEK
  @Get('overview')
  overview(@Query() q: StatsQueryDto) {
    return this.stats.overview(q);
  }

  // GET /promotion-stats/:promotionId?range=LAST_MONTH
  @Get(':promotionId')
  drilldown(
    @Param('promotionId', ParseIntPipe) promotionId: number,
    @Query() q: StatsQueryDto,
  ) {
    return this.stats.drilldown(promotionId, q);
  }
}