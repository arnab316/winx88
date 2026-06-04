import { Module } from '@nestjs/common';
import { AffiliateService } from './affiliate.service';
import { AffiliateRevShareService } from './affiliate-revshare.service';
import { AffiliateController } from './affiliate.controller';
import { AuthModule } from 'src/auth/auth.module';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';

@Module({
  imports: [AuthModule],
  providers: [AffiliateService, AffiliateRevShareService, JwtAuthGuard, AdminGuard],
  controllers: [AffiliateController],
  exports: [AffiliateService, AffiliateRevShareService],
})
export class AffiliateModule {}
