import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { NexusService } from './nexus.service';
import { NexusClient } from './nexus.client';
import { GameCurationService } from './game-curation.service';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ActiveAccountGuard } from '../common/guards/active-account.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { GameLibraryService } from '../game-library/game-library.service';

/**
 * Admin + player routes for Nexus. The seamless money endpoint is separate
 * (NexusCallbackController, POST /gold_api) and deliberately unguarded.
 */
/**
 * Game tiles render small, so there is no reason to accept a large file —
 * and the catalog has thousands of games, which would add up.
 */
const artworkUpload = FileInterceptor('image', {
  storage: memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/webp', 'image/jpeg', 'image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new BadRequestException('Only PNG, WEBP, JPG or GIF allowed'), false);
  },
});

@Controller('nexus')
export class NexusController {
  constructor(
    private readonly nexus: NexusService,
    private readonly client: NexusClient,
    private readonly curation: GameCurationService,
    private readonly library: GameLibraryService,
  ) {}

  // ── Player-facing browse ──────────────────────────────────────────────
  // Public on purpose: a visitor must be able to look at the lobby before
  // they have an account. OptionalJwtAuthGuard attaches the player when a
  // token is present and never 401s, which is what makes `isFavourite` real
  // for a signed-in player and simply false for everyone else.

  /**
   * Every Nexus vendor that has playable games, with live counts.
   *
   *   GET /nexus/vendors
   */
  @UseGuards(OptionalJwtAuthGuard)
  @Get('vendors')
  vendors() {
    return this.nexus.listVendors();
  }

  /**
   * The same list keyed by category, matching the shape of
   * /oroplay/vendors/grouped so the existing vendor picker can render it.
   *
   *   GET /nexus/vendors/grouped
   */
  @UseGuards(OptionalJwtAuthGuard)
  @Get('vendors/grouped')
  vendorsGrouped() {
    return this.nexus.listVendorsGrouped();
  }

  /**
   * Nexus games, filtered by vendor and/or category.
   *
   *   GET /nexus/games?provider=PRAGMATIC&page=1&limit=24
   *   GET /nexus/games?type=roulette
   *   GET /nexus/games?provider=PGSOFT&search=fortune
   *
   * Delegates to the shared catalog reader rather than repeating the query,
   * so the identity triple (kind / providerRef / gameCode) is derived in one
   * place — favourites and continue-playing key on it, and a second
   * implementation would eventually disagree with the first.
   */
  @UseGuards(OptionalJwtAuthGuard)
  @Get('games')
  games(
    @Req() req: any,
    @Query('provider') provider?: string,
    @Query('providerCode') providerCode?: string,
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.library.browseCatalog(req.user?.sub ?? null, {
      aggregator: 'NEXUS',
      // Accept either spelling: the vendor list calls it `code`, the upstream
      // API calls it `provider_code`.
      provider: provider || providerCode,
      type,
      search,
      page: Number(page) || 1,
      limit: Number(limit) || 24,
    });
  }

  // ── Category curation ─────────────────────────────────────────────────
  // Rules and per-game overrides live outside the synced row, so a re-sync
  // cannot undo them. Precedence: override → first matching rule → derived.

  @UseGuards(AdminGuard)
  @Get('admin/curation/rules')
  listRules() {
    return this.curation.listRules();
  }

  /** Create when `id` is absent, update when present. */
  @UseGuards(AdminGuard)
  @Post('admin/curation/rules')
  saveRule(@Body() body: any) {
    return this.curation.upsertRule(body);
  }

  /** What this rule WOULD re-file, before it does it. */
  @UseGuards(AdminGuard)
  @Post('admin/curation/rules/preview')
  previewRule(@Body() body: any) {
    return this.curation.previewRule(body);
  }

  @UseGuards(AdminGuard)
  @Post('admin/curation/rules/delete')
  deleteRule(@Body() body: { id: number }) {
    return this.curation.deleteRule(Number(body?.id));
  }

  /** Pin or clear one game. Sending neither type nor name clears it. */
  @UseGuards(AdminGuard)
  @Post('admin/curation/override')
  setOverride(
    @Req() req: any,
    @Body()
    body: {
      gameUuid: string;
      type?: string;
      displayName?: string;
      note?: string;
      /** Replacement artwork; empty clears it back to the provider's. */
      imageUrl?: string;
    },
  ) {
    return this.curation.setOverride(body?.gameUuid, body, req.admin?.id ?? req.user?.sub);
  }

  /**
   * Upload replacement artwork for one game.
   *
   *   POST /nexus/admin/curation/override/image   (multipart: image, gameUuid)
   *
   * Hosts the file on our own bucket rather than asking an admin to find a
   * URL. The stored value is the same override a pasted URL produces, so
   * clearing it still reverts to the provider's picture.
   */
  @UseGuards(AdminGuard)
  @Post('admin/curation/override/image')
  @UseInterceptors(artworkUpload)
  uploadOverrideImage(
    @Req() req: any,
    @Body('gameUuid') gameUuid: string,
    @UploadedFile() image?: Express.Multer.File,
  ) {
    if (!gameUuid?.trim()) throw new BadRequestException('gameUuid is required');
    if (!image) throw new BadRequestException('No image uploaded');
    return this.curation.uploadOverrideImage(
      gameUuid.trim(),
      image,
      req.admin?.id ?? req.user?.sub,
    );
  }

  /**
   * Re-run rules and overrides over the catalog. No provider calls, so it is
   * the cheap way to apply a rule change to games already imported.
   */
  @UseGuards(AdminGuard)
  @Post('admin/curation/reapply')
  reapply(@Body() body: { aggregator?: string }) {
    return this.curation.reapply(body?.aggregator ?? 'NEXUS');
  }

  /** Catalog rows for the curation screen, with their curation state. */
  @UseGuards(AdminGuard)
  @Get('admin/curation/games')
  curationGames(
    @Query('provider') provider?: string,
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.nexus.listForCuration({
      provider,
      type,
      search,
      page: Number(page) || 1,
      limit: Number(limit) || 50,
    });
  }

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
  @UseGuards(JwtAuthGuard, ActiveAccountGuard)
  @Get('launch')
  launch(
    @Req() req: any,
    @Query('uuid') uuid: string,
    @Query('lang') lang?: string,
    @Query('rtp') rtp?: string,
  ) {
    // Optional per-launch RTP override. Left off, Nexus uses the RTP configured
    // for that player in the agent panel, which is the normal case.
    const n = Number(rtp);
    return this.nexus.getLaunchUrl(
      req.user.sub,
      uuid,
      lang ?? 'en',
      Number.isFinite(n) && n > 0 ? n : undefined,
    );
  }

  /**
   * Launch the sportsbook lobby. This is the endpoint behind a "Sports" nav
   * button — the sportsbook is one lobby, not a grid of game tiles, so it does
   * not appear in the game list and has no uuid.
   */
  @UseGuards(JwtAuthGuard, ActiveAccountGuard)
  @Get('sportsbook/launch')
  launchSportsbook(@Req() req: any, @Query('lang') lang?: string) {
    return this.nexus.launchSportsbook(req.user.sub, lang ?? 'en');
  }
}
