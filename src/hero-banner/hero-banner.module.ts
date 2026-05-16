import { Module } from '@nestjs/common';
import { HeroBannerService } from './hero-banner.service';
import { HeroBannerController } from './hero-banner.controller';
import { HeroBannerS3Service } from 'src/common/services/hero-banner-s3.service';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports:[AuthModule],
  providers: [HeroBannerService, HeroBannerS3Service, AdminGuard],
  controllers: [HeroBannerController],
})
export class HeroBannerModule {}