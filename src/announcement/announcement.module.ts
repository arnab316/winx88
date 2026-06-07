import { Module } from '@nestjs/common';
import { AnnouncementService } from './announcement.service';
import { AnnouncementController } from './announcement.controller';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [AnnouncementService, AdminGuard],
  controllers: [AnnouncementController],
})
export class AnnouncementModule {}
