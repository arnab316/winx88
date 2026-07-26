import { Module } from '@nestjs/common';
import { AffiliateService } from './affiliate.service';
import { AffiliateRevShareService } from './affiliate-revshare.service';
import { AffiliateWeeklyService } from './affiliate-weekly.service';
import { AffiliateTransferService } from './affiliate-transfer.service';
import { AffiliateAdminService } from './affiliate-admin.service';
import { AffiliateController } from './affiliate.controller';
import { AffiliatePublicController } from './affiliate-public.controller';
import { AuthModule } from 'src/auth/auth.module';
import { WalletModule } from 'src/wallet/wallet.module';
import { VerificationModule } from 'src/verification/verification.module';
import { TurnoverModule } from 'src/turnover/turnover.module';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';

@Module({
  // TurnoverModule: approved affiliate→player transfers create a turnover
  // requirement on the credited amount (like the referral bonus flow).
  imports: [AuthModule, WalletModule, VerificationModule, TurnoverModule],
  providers: [
    AffiliateService,
    AffiliateRevShareService,
    AffiliateWeeklyService,
    AffiliateTransferService,
    AffiliateAdminService,
    JwtAuthGuard,
    AdminGuard,
  ],
  controllers: [AffiliateController, AffiliatePublicController],
  exports: [AffiliateService, AffiliateRevShareService, AffiliateWeeklyService],
})
export class AffiliateModule {}
