import { Module, forwardRef } from '@nestjs/common';
import { TurnoverService } from './turnover.service';
import { TurnoverController } from './turnover.controller';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthModule } from '../auth/auth.module';

@Module({
  // JwtAuthGuard needs JwtService (exported by AuthModule). forwardRef breaks the
  // cycle: AuthModule → PromotionModule → TurnoverModule → AuthModule.
  imports: [forwardRef(() => AuthModule)],
  providers: [TurnoverService, JwtAuthGuard],
  controllers: [TurnoverController],
  exports: [TurnoverService]
})
export class TurnoverModule {}
