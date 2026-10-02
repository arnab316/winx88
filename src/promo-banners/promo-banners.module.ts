import { Module } from '@nestjs/common';

import { AuthModule } from 'src/auth/auth.module';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { MediaS3Service } from 'src/common/services/media-s3.service';
import { PromoBannersController } from './promo-banners.controller';
import { PromoBannersService } from './promo-banners.service';

/** Admin-managed promo tile strip on the player home screen. */
@Module({
  imports: [AuthModule],
  controllers: [PromoBannersController],
  providers: [PromoBannersService, MediaS3Service, AdminGuard],
  exports: [PromoBannersService],
})
export class PromoBannersModule {}
