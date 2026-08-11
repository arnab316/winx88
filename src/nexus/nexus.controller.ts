import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { NexusService } from './nexus.service';
import { NexusClient } from './nexus.client';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

/**
 * Admin + player routes for Nexus. The seamless money endpoint is separate
 * (NexusCallbackController, POST /gold_api) and deliberately unguarded.
 */
@Controller('nexus')
export class NexusController {
  constructor(
    private readonly nexus: NexusService,
    private readonly client: NexusClient,
  ) {}

  /**
   * Connectivity check. Nexus enforces an IP allowlist, so this failing with
   * INVALID_IP means the server's address is not registered with them — the
   * first thing to check when nothing works.
   */
  @UseGuards(AdminGuard)
  @Get('admin/providers')
  async providers() {
    const res = await this.client.providerList();
    return res.ok
      ? { success: true, data: res.providers }
      : { success: false, message: res.error };
  }

  /** Pull the catalog into casino_games. Safe to re-run; it upserts. */
  @UseGuards(AdminGuard)
  @Post('admin/sync')
  async sync(@Body() body: { providerCode?: string }) {
    const result = await this.nexus.syncGames(body?.providerCode);
    return { success: true, ...result };
  }

  /** What is currently in the catalog from Nexus. */
  @UseGuards(AdminGuard)
  @Get('admin/games')
  listSynced() {
    return this.nexus.listSynced();
  }

  /**
   * Player launch. Kept here as well as in the shared getGameUrl so the
   * frontend can call Nexus directly if it prefers an explicit route.
   */
  @UseGuards(JwtAuthGuard)
  @Get('launch')
  launch(@Req() req: any, @Query('uuid') uuid: string, @Query('lang') lang?: string) {
    return this.nexus.getLaunchUrl(req.user.sub, uuid, lang ?? 'en');
  }
}
