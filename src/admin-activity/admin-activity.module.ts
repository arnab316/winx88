import { Module, forwardRef } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { AdminActivityController } from './admin-activity.controller';
import { AdminActivityInterceptor } from './admin-activity.interceptor';
import { AdminActivityService } from './admin-activity.service';

@Module({
  // AdminGuard needs JwtService.
  imports: [forwardRef(() => AuthModule)],
  controllers: [AdminActivityController],
  providers: [
    AdminActivityService,
    // Global: every admin write anywhere in the app is recorded.
    { provide: APP_INTERCEPTOR, useClass: AdminActivityInterceptor },
  ],
  exports: [AdminActivityService],
})
export class AdminActivityModule {}
