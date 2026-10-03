import { Module } from '@nestjs/common';

import { AuthModule } from 'src/auth/auth.module';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { OptionalJwtAuthGuard } from 'src/common/guards/optional-jwt-auth.guard';
import { MediaS3Service } from 'src/common/services/media-s3.service';
import { GameContentController } from './game-content.controller';
import { GameContentService } from './game-content.service';

/** Admin-authored game content + the collection screens (Hot Games) it drives. */
@Module({
  imports: [AuthModule],
  controllers: [GameContentController],
  providers: [GameContentService, MediaS3Service, AdminGuard, OptionalJwtAuthGuard],
  exports: [GameContentService],
})
export class GameContentModule {}
