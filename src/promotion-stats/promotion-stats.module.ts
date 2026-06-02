import { Module } from '@nestjs/common';
import { PromotionStatsService } from './promotion-stats.service';
import { PromotionStatsController } from './promotion-stats.controller';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [PromotionStatsService],
  controllers: [PromotionStatsController]
})
export class PromotionStatsModule {}
