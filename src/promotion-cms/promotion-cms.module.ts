import { Module,forwardRef } from '@nestjs/common';
import { PromotionCmsController } from './promotion-cms.controller';
import { PromotionCmsService } from './promotion-cms.service';
import { S3Service } from '../wallet/s3.service';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [PromotionCmsController],
  providers: [PromotionCmsService, S3Service],
  exports: [PromotionCmsService],
})
export class PromotionCmsModule {}
