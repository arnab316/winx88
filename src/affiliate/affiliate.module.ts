import { Module } from '@nestjs/common';
import { AffiliateService } from './affiliate.service';
import { AffiliateController } from './affiliate.controller';
import { AuthModule } from 'src/auth/auth.module';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';

@Module({
  imports: [AuthModule],
  providers: [AffiliateService, JwtAuthGuard, AdminGuard],
  controllers: [AffiliateController]
  ,
    exports: [AffiliateService],

})
export class AffiliateModule {}
