import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  // SuperAdminGuard needs JwtService.
  imports: [forwardRef(() => AuthModule)],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
