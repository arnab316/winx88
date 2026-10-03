// src/spin/spin.module.ts
import { Module, forwardRef } from '@nestjs/common';

import { SpinController } from './spin.controller';
import { SpinService } from './spin.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AuthModule } from '../auth/auth.module';
import { TurnoverModule } from '../turnover/turnover.module';
import { MemberGroupModule } from '../member-group/member-group.module';

@Module({
  // JwtAuthGuard / AdminGuard need JwtService from AuthModule; forwardRef keeps
  // the existing Auth -> ... -> Turnover -> Auth cycle from biting.
  // FinancialLedgerService comes from the @Global LedgerModule, so it needs no
  // import here.
  imports: [
    forwardRef(() => AuthModule),
    TurnoverModule,
    MemberGroupModule,
  ],
  controllers: [SpinController],
  providers: [SpinService, JwtAuthGuard, AdminGuard],
  exports: [SpinService],
})
export class SpinModule {}
