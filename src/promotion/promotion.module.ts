import { Module,forwardRef } from '@nestjs/common';
import { PromotionController } from './promotion.controller';
// import { PromotionService } from './promotion-engine.service';
import { PromotionEngineService } from './promotion-engine.service';
import { AuthModule } from 'src/auth/auth.module';
import { TurnoverModule } from 'src/turnover/turnover.module';
import { MemberGroupModule } from 'src/member-group/member-group.module';
import { PromotionStatsService } from './promotion-stats.service';

@Module({
  imports: [forwardRef(() => AuthModule), 
    TurnoverModule, MemberGroupModule],
  controllers: [PromotionController],
  providers: [PromotionEngineService, PromotionStatsService],
  exports: [PromotionEngineService, PromotionStatsService],


})
export class PromotionModule {}
