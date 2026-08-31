import {
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OroplayClient } from './oroplay.client';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { ActiveAccountGuard } from 'src/common/guards/active-account.guard';

/**
 * User-facing OroPlay endpoints.
 *
 * Mirrors the same shape as palace-casino.controller.ts —
 * frontend hits these, we translate to OroPlay API calls,
 * we lazy-create the OroPlay user on first launch.
 */
@UseGuards(JwtAuthGuard)
@Controller('oroplay')
export class OroplayController {
  private readonly logger = new Logger(OroplayController.name);

  constructor(
    private readonly oroplay: OroplayClient,
    private readonly dataSource: DataSource,
  ) {}

  // ─── List vendors ────────────────────────────────────────────
  @Get('vendors')
  async vendors() {
    const res = await this.oroplay.vendorList();
    return res.message;
  }

  // ─── GET /oroplay/vendors/grouped ────────────────────────────
@Get('vendors/grouped')
async vendorsGrouped() {
  const res = await this.oroplay.vendorList();

  const typeMap: Record<number, string> = {
    1: 'Live Casino',
    2: 'Slot',
    3: 'Crash',
    4: 'Fishing',
    5: 'Sports',
    6: 'Poker',
  };

  // Logo base URL pattern from OroPlay admin
  const LOGO_BASE = 'https://static3.pgf-asu2nd.com/logo';

  // These don't follow the vendorCode pattern — manual overrides
  const logoOverrides: Record<string, string | null> = {
    'fishing-fungaming': 'https://www.gamingsoft.com/Content/v2/images/new-provider/the-online-casino-product-from-fun-gaming-gamingsoft.png',
    'fishing-cq9':       'https://www.gamingsoft.com/Content/v2/images/new-provider/the-online-casino-product-from-fun-gaming-gamingsoft.png',
    'sports':            'https://sports.eyq8vmw3.com/image/thumb.jpg',
    'board-poker':       null, // no logo available
  };

  const grouped = (res.message as any[]).reduce((acc, item) => {
    const groupName = typeMap[item.type] ?? 'Other';
    if (!acc[groupName]) acc[groupName] = [];

    const logo = item.vendorCode in logoOverrides
      ? logoOverrides[item.vendorCode]
      : `${LOGO_BASE}/${item.vendorCode}.png`;

    acc[groupName].push({
      vendorCode: item.vendorCode,
      type:       item.type,
      name:       item.name,
      logo,
    });
    return acc;
  }, {} as Record<string, any[]>);

  return grouped;
}

  // ─── List games for a vendor ─────────────────────────────────
  @Post('games')
  async games(@Body() body: { vendorCode: string; language?: string }) {
    const res = await this.oroplay.gameList(body.vendorCode, body.language ?? 'en');
    return res.message;
  }

  // ─── Game detail ─────────────────────────────────────────────
  @Post('game-detail')
  async gameDetail(@Body() body: { vendorCode: string; gameCode: string }) {
    const res = await this.oroplay.gameDetail(body.vendorCode, body.gameCode);
    return res.message;
  }

  // ─── Launch game ─────────────────────────────────────────────
  @UseGuards(ActiveAccountGuard)
  @Post('launch')
  async launchGame(
    @Req() req: any,
    @Body() body: {
      vendorCode: string;
      gameCode: string;
      language?: string;
      lobbyUrl?: string;
      theme?: number;
    },
  ) {
    const userId: number = req.user?.sub;
    const userCode = await this.ensureOroplayUser(userId);

    const res = await this.oroplay.getLaunchUrl({
      vendorCode: body.vendorCode,
      gameCode: body.gameCode,
      userCode,
      language: body.language ?? 'en',
      lobbyUrl: body.lobbyUrl,
      theme: body.theme,
    });

    return { gameUrl: res.message };
  }

  // ─── Betting history (proxied from OroPlay) ──────────────────
  @Get('history')
  async historyByDate(
    @Query('startDate') startDate: string,
    @Query('limit') limit?: string,
  ) {
    const res = await this.oroplay.getHistoryByDate(
      startDate,
      limit ? Math.min(Number(limit), 5000) : 5000,
    );
    return res.message;
  }

  // ─── Internal helpers ────────────────────────────────────────
  /**
   * Returns the OroPlay userCode (= our username) for this user.
   * Creates the user on OroPlay's side on first call, then flags
   * the local user row so we don't call again.
   *
   * Idempotent: errorCode=1 (USER_ALREADY_EXISTS) is treated as success.
   */
  private async ensureOroplayUser(userId: number): Promise<string> {
    const rows = await this.dataSource.query(
      `SELECT username, oroplay_registered FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (!rows.length) throw new Error('User not found');

    const { username, oroplay_registered } = rows[0];
    if (oroplay_registered) return username;

    try {
      await this.oroplay.createUser(username);
    } catch (err: any) {
      // If OroPlay says user already exists, that's fine — flag and move on
      const msg = err?.message ?? '';
      if (!msg.includes('errorCode=1')) {
        this.logger.error(`OroPlay createUser failed for ${username}: ${msg}`);
        throw err;
      }
      this.logger.warn(`OroPlay user already existed for ${username}, flagging locally`);
    }

    await this.dataSource.query(
      `UPDATE users SET oroplay_registered = TRUE WHERE id = $1`,
      [userId],
    );
    return username;
  }
}
