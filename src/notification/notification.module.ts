// src/notification/notification.module.ts
import { Global, Module, forwardRef } from '@nestjs/common';

import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { NotificationGateway } from './notification.gateway';
import { NotificationRelay } from './notification.relay';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AuthModule } from '../auth/auth.module';

/**
 * Global on purpose.
 *
 * Notifications are emitted from wallet, game, promotion, spin and auth code.
 * Making every one of those modules import this one would add a web of
 * forwardRef cycles for a single injected method; @Global mirrors what
 * LedgerModule already does for the same reason.
 */
@Global()
@Module({
  // JwtAuthGuard / AdminGuard and the gateway all need JwtService from
  // AuthModule; forwardRef keeps the existing Auth -> ... -> Auth cycle safe.
  imports: [forwardRef(() => AuthModule)],
  controllers: [NotificationController, PushController],
  providers: [
    NotificationService,
    NotificationGateway,
    NotificationRelay,
    PushService,
    JwtAuthGuard,
    AdminGuard,
  ],
  exports: [NotificationService, NotificationGateway, PushService],
})
export class NotificationModule {}
