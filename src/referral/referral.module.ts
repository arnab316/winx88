import { Module } from '@nestjs/common';
import { AuthModule } from 'src/auth/auth.module';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { ReferralController } from './referral.controller';
import { ReferralService } from './referral.service';
import { ReferralAdminController } from './referral-admin.controller';
import { ReferralAdminService } from './referral-admin.service';
import { ReferralInfoStatController } from './referral-info-stat.controller';
import { ReferralInfoStatService } from './referral-info-stat.service';

/**
 * Refer-a-friend referral system — Phase 1 (signup linking + referrer panel)
 * and Phase 3 (admin dashboard KPIs + management). The Phase 2 lifecycle engine
 * lives in ReferralEngineModule (global).
 *
 * Reads/writes the referral_* tables via the default DataSource. The signup
 * hook itself lives in AuthService (inside the registration flow), so this
 * module does NOT need to be imported by AuthModule — avoiding a cycle.
 * Imports AuthModule only for JwtModule (Jwt/Admin guards).
 */
@Module({
  imports: [AuthModule],
  controllers: [ReferralController, ReferralAdminController, ReferralInfoStatController],
  providers: [ReferralService, ReferralAdminService, ReferralInfoStatService, JwtAuthGuard, AdminGuard],
  exports: [ReferralService],
})
export class ReferralModule {}
