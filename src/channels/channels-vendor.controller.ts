import {
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ChannelsService } from './channels.service';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { VendorThrottlerGuard } from './vendor-throttler.guard';
import { ChannelStatsQueryDto } from './dto/channels.dto';

/**
 * Third-party media-buyer reporting API.
 *
 * Authenticated by a scoped API key (`x-api-key: <prefix>.<secret>`), NOT a JWT
 * — the vendor must never hold an admin token. ApiKeyGuard resolves the key to
 * `req.vendor`, and every query binds that vendor id, so a vendor can only ever
 * see their own channels.
 *
 * Responses are aggregates only: no IP, user agent, username or user id ever
 * crosses this boundary.
 *
 *   GET /partner/channels  the vendor's channels + tracking URLs
 *   GET /partner/stats     clicks / registrations / FTDs / deposits
 */
@Controller('partner')
// ApiKeyGuard first so req.vendor exists for the throttler's per-key tracking.
@UseGuards(ApiKeyGuard, VendorThrottlerGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class ChannelsVendorController {
  constructor(private readonly channels: ChannelsService) {}

  @Get('channels')
  listChannels(@Req() req: any) {
    return this.channels.getVendorChannels(req.vendor.id);
  }

  // GET /partner/stats?dateFrom=&dateTo=&channel=&granularity=day|total
  @Get('stats')
  stats(@Req() req: any, @Query() q: ChannelStatsQueryDto) {
    return this.channels.getVendorStats(req.vendor.id, q);
  }
}
