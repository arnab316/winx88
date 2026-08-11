import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NexusClient } from './nexus.client';

/**
 * Nexus catalog sync + game launch.
 *
 * Games are stored in the EXISTING `casino_games` table so the current game
 * list and launch endpoints keep working with no frontend change — a Nexus game
 * simply appears alongside the others. They are distinguished by
 * `aggregator = 'NEXUS'`, which is also what protects them from the Palace and
 * OroPlay sync jobs, both of which clear the catalog by `type` before reloading.
 */
@Injectable()
export class NexusService {
  private readonly logger = new Logger(NexusService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly client: NexusClient,
  ) {}

  /** Stable, collision-proof id for a Nexus game inside the shared catalog. */
  private uuidFor(providerCode: string, gameCode: string): string {
    return `NEXUS_${providerCode}_${gameCode}`.slice(0, 190);
  }

  /**
   * Map a Nexus game to the `type` the existing catalog filters use.
   *
   * Those filters are long-established: `type='slots'` is the slots tab, and
   * live is "vendor_code IS NOT NULL AND type NOT IN ('slots','instant')". So
   * the value chosen here decides which tab a game lands in.
   *
   * The AUTHORITY is the PROVIDER's type, not the game's — Nexus's game_list
   * returns only `{ id, game_code, game_name, banner, status }` with no type at
   * all. Deriving from the game alone would file all 614 Pragmatic slots as
   * live games.
   *
   * Provider types seen on the live account: slot, live, SB, MN, FH.
   */
  private deriveType(game: { game_name?: string }, providerType: string): string {
    switch (providerType) {
      case 'slot':
        return 'slots';
      case 'MN':
        // Mini/instant games (Spribe — Aviator and similar).
        return 'instant';
      case 'FH':
        return 'fishing';
      case 'SB':
        return 'sportsbook';
    }
    // Live: refine by name so roulette/baccarat/blackjack land in the right
    // sub-tab, exactly as the OroPlay sync does.
    const n = (game.game_name ?? '').toLowerCase();
    if (n.includes('roulette')) return 'roulette';
    if (n.includes('baccarat')) return 'baccarat';
    if (n.includes('blackjack')) return 'blackjack';
    if (n.includes('poker') || n.includes('holdem')) return 'table';
    return 'live';
  }

  /**
   * Pull providers and their games into `casino_games`.
   *
   * UPSERTS rather than delete-and-reload: a failed pull partway through must
   * not leave the catalog empty and the site with no games. Stale rows are
   * deactivated by a later `under_maintenance` pass rather than deleted.
   *
   * Admin-triggered, matching how the existing syncs are run.
   */
  async syncGames(providerFilter?: string): Promise<{
    providers: number;
    games: number;
    skipped: string[];
  }> {
    if (!this.client.configured) {
      throw new BadRequestException(
        'Nexus is not configured — set NEXUS_AGENT_CODE and NEXUS_AGENT_TOKEN',
      );
    }

    const provRes = await this.client.providerList();
    if (!provRes.ok) {
      throw new BadRequestException(`Nexus provider_list failed: ${provRes.error}`);
    }

    const skipped: string[] = [];
    let gameCount = 0;
    let providerCount = 0;

    for (const p of provRes.providers) {
      if (providerFilter && p.code !== providerFilter) continue;
      if (p.status !== 1) {
        skipped.push(`${p.code} (provider disabled)`);
        continue;
      }

      const gamesRes = await this.client.gameList(p.code);
      if (!gamesRes.ok) {
        // One bad provider must not abort the whole sync.
        skipped.push(`${p.code} (${gamesRes.error})`);
        continue;
      }
      providerCount++;

      for (const g of gamesRes.games) {
        if (!g.game_code) continue;
        // Games carry their own status; skip anything the provider has
        // disabled rather than listing a game that will not launch.
        if (g.status != null && Number(g.status) !== 1) continue;
        const type = this.deriveType(g, String(p.type ?? ''));
        await this.dataSource.query(
          `INSERT INTO casino_games
             (uuid, name, image, type, provider, vendor_code, game_code, slug,
              under_maintenance, game_symbol, lang, technology, has_lobby, is_mobile,
              has_freespins, has_tables, freespin_valid_until_full_day,
              parameters, tags, images, related_games, is_new, aggregator)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,$9,1,'HTML5',0,1,0,0,0,
                   $10,'[]','[]','[]',false,'NEXUS')
           ON CONFLICT (uuid) DO UPDATE SET
             name       = EXCLUDED.name,
             image      = EXCLUDED.image,
             type       = EXCLUDED.type,
             provider   = EXCLUDED.provider,
             game_code  = EXCLUDED.game_code,
             aggregator = 'NEXUS',
             updated_at = NOW()`,
          [
            this.uuidFor(p.code, g.game_code),
            g.game_name ?? g.game_code,
            g.banner ?? '',
            type,
            p.name ?? p.code,
            p.code,
            g.game_code,
            g.game_code,
            g.game_code,
            JSON.stringify({ rtp: 95, volatility: null, reels_count: null, lines_count: null }),
          ],
        );
        gameCount++;
      }
    }

    this.logger.log(
      `[Nexus] catalog sync: ${providerCount} provider(s), ${gameCount} game(s)` +
        (skipped.length ? `, skipped: ${skipped.join('; ')}` : ''),
    );
    return { providers: providerCount, games: gameCount, skipped };
  }

  /**
   * Launch URL for a Nexus game.
   *
   * `user_code` MUST be the player's username: it is the identity Nexus echoes
   * back on every /gold_api callback, and the callback resolves the wallet by
   * `users.username`. Sending anything else means bets arrive for a user we
   * cannot find.
   */
  async getLaunchUrl(userId: number, uuid: string, lang = 'en'): Promise<{ url: string }> {
    const [game] = await this.dataSource.query(
      `SELECT vendor_code, game_code, type FROM casino_games
        WHERE uuid = $1 AND aggregator = 'NEXUS' LIMIT 1`,
      [uuid],
    );
    if (!game) throw new NotFoundException('Nexus game not found');

    const [user] = await this.dataSource.query(
      `SELECT username FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (!user?.username) throw new NotFoundException('User not found');

    const res = await this.client.gameLaunch({
      userCode: user.username,
      providerCode: game.vendor_code,
      gameCode: game.game_code,
      lang,
      lobbyUrl: process.env.PUBLIC_SITE_URL ?? process.env.LOBBY_URL ?? 'https://winx-88.com',
    });
    if (!res.ok) throw new BadRequestException(`Nexus launch failed: ${res.error}`);
    return { url: res.launchUrl };
  }

  /** Admin view: what is in the catalog from Nexus, by provider. */
  async listSynced() {
    const rows = await this.dataSource.query(
      `SELECT vendor_code AS provider_code, provider, type, COUNT(*)::int AS games
         FROM casino_games
        WHERE aggregator = 'NEXUS'
        GROUP BY vendor_code, provider, type
        ORDER BY provider, type`,
    );
    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM casino_games WHERE aggregator = 'NEXUS'`,
    );
    return { success: true, total, data: rows };
  }
}
