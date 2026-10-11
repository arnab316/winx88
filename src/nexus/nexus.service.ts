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

  /**
   * Nexus allows ONE `game_list` and ONE `provider_list` per second. A sync
   * that loops ~27 providers without pacing gets `7770429 Rate Limit Error`
   * for most of them — and because a failed provider is only pushed onto
   * `skipped` so one bad provider cannot abort the run, the sync reports
   * success while quietly importing almost nothing.
   *
   * 1100ms rather than exactly 1000ms: their window is wall-clock on their
   * side, and a request that leaves here exactly on the second can still
   * arrive inside the previous one.
   */
  private static readonly API_MIN_INTERVAL_MS = 1100;

  /** When the last rate-limited method was called, for pacing the next one. */
  private lastApiCallAt = 0;

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async pace(): Promise<void> {
    const wait = NexusService.API_MIN_INTERVAL_MS - (Date.now() - this.lastApiCallAt);
    if (wait > 0) await this.sleep(wait);
    this.lastApiCallAt = Date.now();
  }

  /** `msg` is written for humans, so match loosely and on the code too. */
  private isRateLimited(error?: string): boolean {
    const s = String(error ?? '').toLowerCase();
    return s.includes('rate limit') || s.includes('7770429');
  }

  /** `game_list` for one provider, paced, with one retry if we still raced. */
  private async gameListPaced(providerCode: string) {
    await this.pace();
    let res = await this.client.gameList(providerCode);
    if (!res.ok && this.isRateLimited(res.error)) {
      this.logger.warn(`[Nexus] rate limited on ${providerCode} — backing off 2s`);
      await this.sleep(2000);
      this.lastApiCallAt = Date.now();
      res = await this.client.gameList(providerCode);
    }
    return res;
  }

  /** Games per upsert statement. 10 params each, well inside Postgres' limit. */
  private static readonly UPSERT_CHUNK = 200;

  /** One multi-row upsert. Each row is the 10 params the column list expects. */
  private async upsertGames(rows: any[][]): Promise<void> {
    if (!rows.length) return;
    const COLS = 10;
    const values = rows
      .map((_, r) => {
        const b = r * COLS;
        return (
          `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},` +
          `false,$${b + 9},1,'HTML5',0,1,0,0,0,$${b + 10},'[]','[]','[]',false,'NEXUS')`
        );
      })
      .join(',');

    await this.dataSource.query(
      `INSERT INTO casino_games
         (uuid, name, image, type, provider, vendor_code, game_code, slug,
          under_maintenance, game_symbol, lang, technology, has_lobby, is_mobile,
          has_freespins, has_tables, freespin_valid_until_full_day,
          parameters, tags, images, related_games, is_new, aggregator)
       VALUES ${values}
       ON CONFLICT (uuid) DO UPDATE SET
         name       = EXCLUDED.name,
         image      = EXCLUDED.image,
         type       = EXCLUDED.type,
         provider   = EXCLUDED.provider,
         game_code  = EXCLUDED.game_code,
         aggregator = 'NEXUS',
         updated_at = NOW()`,
      rows.flat(),
    );
  }

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

    await this.pace();
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

      const gamesRes = await this.gameListPaced(p.code);
      if (!gamesRes.ok) {
        // One bad provider must not abort the whole sync.
        skipped.push(`${p.code} (${gamesRes.error})`);
        continue;
      }
      providerCount++;
      let imported = 0;

      // Batched, not one statement per game: a provider like PRAGMATIC has 600+
      // games, and a round trip each makes the sync minutes long and far more
      // likely to be cut off partway by a proxy timeout.
      const batch: any[][] = [];
      // A uuid repeated inside ONE multi-row upsert makes Postgres raise
      // "ON CONFLICT DO UPDATE command cannot affect row a second time", so a
      // provider listing the same game_code twice must not reach the statement.
      const seen = new Set<string>();

      for (const g of gamesRes.games) {
        if (!g.game_code) continue;
        // Games carry their own status; skip anything the provider has
        // disabled rather than listing a game that will not launch.
        if (g.status != null && Number(g.status) !== 1) continue;
        const uuid = this.uuidFor(p.code, g.game_code);
        if (seen.has(uuid)) continue;
        seen.add(uuid);
        batch.push([
          uuid,
          g.game_name ?? g.game_code,
          g.banner ?? '',
          this.deriveType(g, String(p.type ?? '')),
          p.name ?? p.code,
          p.code,
          g.game_code,
          g.game_code,
          g.game_code,
          JSON.stringify({ rtp: 95, volatility: null, reels_count: null, lines_count: null }),
        ]);
      }

      for (let i = 0; i < batch.length; i += NexusService.UPSERT_CHUNK) {
        const chunk = batch.slice(i, i + NexusService.UPSERT_CHUNK);
        await this.upsertGames(chunk);
        gameCount += chunk.length;
        imported += chunk.length;
      }

      // Per provider, because pacing makes a full sync take ~30s+ and an admin
      // proxy may time out the HTTP call long before it finishes. The sync
      // itself carries on server-side, so this log is the record of what
      // actually landed.
      this.logger.log(
        `[Nexus] synced ${p.code} (${p.type}): ${imported} game(s)`,
      );
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
  /** Catalog types that come from a `live` or `SB` provider. */
  private static readonly RTP_IGNORED_TYPES = new Set([
    'live', 'roulette', 'baccarat', 'blackjack', 'table', 'sportsbook',
  ]);

  async getLaunchUrl(
    userId: number,
    uuid: string,
    lang = 'en',
    rtp?: number,
  ): Promise<{ url: string }> {
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
      // Nexus ignores rtp for live and sportsbook. Dropping it here rather
      // than sending a field that does nothing keeps the request honest and
      // the logs readable.
      rtp: NexusService.RTP_IGNORED_TYPES.has(String(game.type)) ? undefined : rtp,
    });
    if (!res.ok) throw new BadRequestException(`Nexus launch failed: ${res.error}`);
    return { url: res.launchUrl };
  }

  /**
   * Launch the Nexus sportsbook.
   *
   * Unlike slots and live tables, the sportsbook is a single LOBBY, not a
   * catalog of games: `game_list` returns nothing for it, and it launches with
   * `provider_code: SPORTSBOOK` and an EMPTY `game_code`. So it has no
   * casino_games row and is surfaced as a dedicated "Sports" entry rather than
   * a game tile — this is the endpoint behind that button.
   *
   * Bets already settle through the same /gold_api callback (game_type "SB");
   * this only produces the URL to open.
   *
   * The Login URL / Deposit URL the sportsbook needs when a player is logged
   * out or short of funds are configured in the NEXUS BACK OFFICE, not here.
   */
  async launchSportsbook(userId: number, lang = 'en'): Promise<{ url: string }> {
    const [user] = await this.dataSource.query(
      `SELECT username FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (!user?.username) throw new NotFoundException('User not found');

    const res = await this.client.gameLaunch({
      userCode: user.username,
      providerCode: 'SPORTSBOOK',
      // Empty game_code = the whole sportsbook lobby, per Nexus docs.
      lang,
      lobbyUrl: process.env.PUBLIC_SITE_URL ?? process.env.LOBBY_URL ?? 'https://winx-88.com',
    });
    if (!res.ok) throw new BadRequestException(`Nexus sportsbook launch failed: ${res.error}`);
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
