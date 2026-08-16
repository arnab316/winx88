import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ChannelsService } from './channels.service';
import { AdminGuard } from '../common/guards/admin.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import {
  CreateVendorDto,
  UpdateVendorDto,
  CreateApiKeyDto,
  CreateChannelDto,
  UpdateChannelDto,
  ChannelListQueryDto,
  AdminChannelStatsQueryDto,
  UnknownClickQueryDto,
  CapiEventQueryDto,
} from './dto/channels.dto';
import { MetaCapiService } from '../meta/meta-capi.service';

/**
 * Admin management of marketing vendors, their campaign channels, and the
 * scoped API keys they use to pull reports.
 *
 * Permission resource is `marketing`, with `view` and `manage` actions. RBAC
 * creates permission rows on first grant, so no RBAC code change is needed —
 * just grant marketing.view / marketing.manage to a role.
 */
@Controller('admin/marketing')
@UseGuards(AdminGuard, PermissionsGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class ChannelsAdminController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly metaCapi: MetaCapiService,
  ) {}

  // ── Vendors ──────────────────────────────────────────────────
  @Get('vendors')
  @RequirePermissions('marketing', 'view')
  listVendors() {
    return this.channels.listVendors();
  }

  @Post('vendors')
  @RequirePermissions('marketing', 'manage')
  createVendor(@Req() req: any, @Body() dto: CreateVendorDto) {
    return this.channels.createVendor(dto, Number(req.user?.sub));
  }

  @Patch('vendors/:id')
  @RequirePermissions('marketing', 'manage')
  updateVendor(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateVendorDto) {
    return this.channels.updateVendor(id, dto);
  }

  // ── API keys ─────────────────────────────────────────────────
  @Get('vendors/:id/keys')
  @RequirePermissions('marketing', 'view')
  listKeys(@Param('id', ParseIntPipe) id: number) {
    return this.channels.listApiKeys(id);
  }

  /** Returns the plaintext key ONCE. It is not recoverable afterwards. */
  @Post('vendors/:id/keys')
  @RequirePermissions('marketing', 'manage')
  createKey(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateApiKeyDto,
  ) {
    return this.channels.createApiKey(id, dto, Number(req.user?.sub));
  }

  @Delete('vendors/:id/keys/:keyId')
  @RequirePermissions('marketing', 'manage')
  revokeKey(
    @Param('id', ParseIntPipe) id: number,
    @Param('keyId', ParseIntPipe) keyId: number,
  ) {
    return this.channels.revokeApiKey(id, keyId);
  }

  // ── Channels ─────────────────────────────────────────────────
  /**
   * Campaign performance: clicks → registrations → FTDs → deposits, per
   * channel. The same numbers the media buyer pulls from /partner/stats, so
   * the admin screen and the vendor's invoice never disagree.
   *
   *   GET /admin/marketing/stats?vendorId=&channel=&dateFrom=&dateTo=&granularity=
   *
   * vendorId omitted = all vendors. granularity=day needs dateFrom+dateTo.
   */
  @Get('stats')
  @RequirePermissions('marketing', 'view')
  stats(@Query() q: AdminChannelStatsQueryDto) {
    return this.channels.getAdminStats(q);
  }

  /**
   * Domains a channel may be published on — this is what the "Domain" dropdown
   * on the create-channel form reads. Returns the platform default first.
   */
  @Get('domains')
  @RequirePermissions('marketing', 'view')
  domains() {
    const domains = this.channels.allowedDomains();
    return { success: true, data: { domains, default: domains[0] } };
  }

  @Get('channels')
  @RequirePermissions('marketing', 'view')
  listChannels(@Query() q: ChannelListQueryDto) {
    return this.channels.listChannels(q);
  }

  @Post('channels')
  @RequirePermissions('marketing', 'manage')
  createChannel(@Req() req: any, @Body() dto: CreateChannelDto) {
    return this.channels.createChannel(dto, Number(req.user?.sub));
  }

  @Patch('channels/:id')
  @RequirePermissions('marketing', 'manage')
  updateChannel(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateChannelDto) {
    return this.channels.updateChannel(id, dto);
  }

  // ── Unknown codes (typo watch during a campaign launch) ──────
  /**
   * Removes a channel created by mistake. Refuses once it has clicks,
   * registrations or queued conversions — deactivate those instead, since the
   * FKs are ON DELETE SET NULL and a delete would detach the vendor's history
   * without raising anything.
   */
  @Delete('channels/:id')
  @RequirePermissions('marketing', 'manage')
  deleteChannel(@Param('id', ParseIntPipe) id: number) {
    return this.channels.deleteChannel(id);
  }

  @Get('clicks/unknown')
  @RequirePermissions('marketing', 'view')
  unknownClicks(@Query() q: UnknownClickQueryDto) {
    return this.channels.listUnknownClicks(q);
  }

  /**
   * Meta Conversions API outbox — the screen that answers "why has Facebook
   * stopped receiving our conversions". Pending/sent/failed counts, the last
   * error per event, and whether sending is enabled at all.
   */
  @Get('capi/events')
  @RequirePermissions('marketing', 'view')
  capiEvents(@Query() q: CapiEventQueryDto) {
    return this.metaCapi.listEvents(q);
  }
}
