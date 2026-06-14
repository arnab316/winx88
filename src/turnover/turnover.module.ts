import { Module, forwardRef } from '@nestjs/common';
import { TurnoverService } from './turnover.service';
import { TurnoverController, TurnoverAdminController } from './turnover.controller';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AuthModule } from '../auth/auth.module';

@Module({
  // JwtAuthGuard / AdminGuard need JwtService (exported by AuthModule). forwardRef
  // breaks the cycle: AuthModule → PromotionModule → TurnoverModule → AuthModule.
  imports: [forwardRef(() => AuthModule)],
  providers: [TurnoverService, JwtAuthGuard, AdminGuard],
  controllers: [TurnoverController, TurnoverAdminController],
  exports: [TurnoverService]
})
export class TurnoverModule {}
