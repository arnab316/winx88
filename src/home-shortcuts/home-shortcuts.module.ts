import { Module } from '@nestjs/common';

import { AuthModule } from 'src/auth/auth.module';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { MediaS3Service } from 'src/common/services/media-s3.service';
import { HomeShortcutsController } from './home-shortcuts.controller';
import { HomeShortcutsService } from './home-shortcuts.service';

/** Admin-managed round shortcut row on the player home screen. */
@Module({
  imports: [AuthModule],
  controllers: [HomeShortcutsController],
  providers: [HomeShortcutsService, MediaS3Service, AdminGuard],
  exports: [HomeShortcutsService],
})
export class HomeShortcutsModule {}
