import { Module, forwardRef } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ChannelsService } from './channels.service';
import { ChannelsPublicController } from './channels-public.controller';
import { ChannelsVendorController } from './channels-vendor.controller';
import { ChannelsAdminController } from './channels-admin.controller';
import { VendorThrottlerGuard } from './vendor-throttler.guard';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AuthModule } from '../auth/auth.module';

/**
 * Marketing channel tracking for third-party media buyers.
 *
 * AuthModule is imported for the JwtService that AdminGuard needs on the admin
 * controller. PermissionsGuard resolves from the @Global RbacModule.
 *
 * ThrottlerModule is registered here and applied per-controller via
 * @UseGuards — deliberately NOT as a global APP_GUARD, which would silently
 * start throttling every pre-existing route in the application.
 */
@Module({
  imports: [
    forwardRef(() => AuthModule),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
  ],
  controllers: [
    ChannelsPublicController,
    ChannelsVendorController,
    ChannelsAdminController,
  ],
  providers: [ChannelsService, ApiKeyGuard, AdminGuard, VendorThrottlerGuard],
  exports: [ChannelsService],
})
export class ChannelsModule {}
