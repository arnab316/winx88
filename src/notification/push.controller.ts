import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PushService, type PushSubscriptionInput } from './push.service';

/**
 * Browser push subscription management.
 *
 *   GET    /notifications/push/key          public — the VAPID public key
 *   GET    /notifications/push/status       is this player subscribed anywhere
 *   POST   /notifications/push/subscribe    store this browser's subscription
 *   DELETE /notifications/push/unsubscribe  remove it
 *
 * The public key is intentionally unauthenticated: it is public by design (the
 * browser needs it to build a subscription) and the panel asks for it before
 * the player has necessarily done anything else.
 */
@Controller('notifications/push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('key')
  key() {
    return {
      statusCode: HttpStatus.OK,
      enabled: this.push.isConfigured(),
      publicKey: this.push.getPublicKey(),
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('status')
  async status(@Req() req: any) {
    const devices = await this.push.countForUser(req.user.sub);
    return {
      statusCode: HttpStatus.OK,
      enabled: this.push.isConfigured(),
      devices,
      subscribed: devices > 0,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('subscribe')
  @HttpCode(HttpStatus.OK)
  async subscribe(@Req() req: any, @Body() body: PushSubscriptionInput) {
    // Validated in the service rather than a DTO: the payload shape is dictated
    // by the browser's PushSubscription.toJSON(), and the global
    // ValidationPipe's whitelist would strip the nested `keys` object.
    const data = await this.push.subscribe(
      req.user.sub,
      body,
      req.headers?.['user-agent'],
    );
    return { statusCode: HttpStatus.OK, message: 'Push subscription saved', ...data };
  }

  @UseGuards(JwtAuthGuard)
  @Delete('unsubscribe')
  @HttpCode(HttpStatus.OK)
  async unsubscribe(@Req() req: any, @Body() body: { endpoint: string }) {
    const data = await this.push.unsubscribe(req.user.sub, body?.endpoint);
    return { statusCode: HttpStatus.OK, message: 'Push subscription removed', ...data };
  }
}
