import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NexusClient } from './nexus.client';
import { GameCurationService } from './game-curation.service';

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
    private readonly curation: GameCurationService,
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

  /** One multi-row upsert. Each row is the 11 params the column list expects. */
  private async upsertGames(rows: any[][]): Promise<void> {
    if (!rows.length) return;
    const COLS = 11;
    const values = rows
      .map((_, r) => {
        const b = r * COLS;
        return (
          `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},` +
          `false,$${b + 9},1,'HTML5',0,1,0,0,0,$${b + 10},'[]','[]','[]',false,'NEXUS',$${b + 11})`
        );
      })
      .join(',');

    await this.dataSource.query(
      `INSERT INTO casino_games
         (uuid, name, image, type, provider, vendor_code, game_code, slug,
          under_maintenance, game_symbol, lang, technology, has_lobby, is_mobile,
          has_freespins, has_tables, freespin_valid_until_full_day,
          parameters, tags, images, related_games, is_new, aggregator, derived_type)
       VALUES ${values}
       ON CONFLICT (uuid) DO UPDATE SET
         name       = EXCLUDED.name,
         image      = EXCLUDED.image,
         type       = EXCLUDED.type,
         provider   = EXCLUDED.provider,
         game_code  = EXCLUDED.game_code,
         aggregator = 'NEXUS',
         -- What the sync itself worked out, kept apart from the curated
         -- type column so removing a rule or override can restore it.
         derived_type = EXCLUDED.derived_type,
         updated_at = NOW()`,
      rows.flat(),
    );
  }

  /**
   * Nexus vendors a player can browse, with live game counts.
   *
   * Counts come from `casino_games`, NOT from Nexus — a vendor the sync has
   * not imported yet would otherwise show in the picker and open empty. A
   * vendor with zero playable games is simply absent.
   *
   * `category` is the catalog type most of that vendor's games land in, which
   * is what decides the tab they appear under, so a vendor curated into a new
   * category follows automatically.
   */
  async listVendors(): Promise<
    Array<{ code: string; name: string; category: string; games: number }>
  > {
    // Grouped by (vendor, type) first so each vendor's dominant category can
    // be picked with ROW_NUMBER, then totalled across its types with a window.
    // Window functions run AFTER grouping, which is what makes this legal —
    // referencing c.provider inside the window directly is not.
    return this.dataSource.query(
      `SELECT code, name, category, games
         FROM (
           SELECT c.vendor_code                                        AS code,
                  MAX(c.provider)                                      AS name,
                  c.type                                               AS category,
                  SUM(COUNT(*)) OVER (PARTITION BY c.vendor_code)::int AS games,
                  ROW_NUMBER() OVER (PARTITION BY c.vendor_code
                                     ORDER BY COUNT(*) DESC)           AS rn
             FROM public.casino_games c
            WHERE c.aggregator = 'NEXUS'
              AND c.under_maintenance = false
              AND c.vendor_code IS NOT NULL
            GROUP BY c.vendor_code, c.type
         ) t
        WHERE rn = 1
        ORDER BY games DESC, name`,
    );
  }

  /**
   * The same vendors keyed by category, mirroring /oroplay/vendors/grouped so
   * the player panel's existing vendor picker can render either source without
   * a second code path.
   */
  async listVendorsGrouped(): Promise<Record<string, any[]>> {
    const rows = await this.listVendors();
    const out: Record<string, any[]> = {};
    for (const v of rows) (out[v.category] ??= []).push(v);
    return out;
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

    // Loaded once for the whole run, not per game.
    const curation = await this.curation.load();

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

        // What the sync derives, before curation.
        const derivedType = this.deriveType(g, String(p.type ?? ''));
        const providerName = g.game_name ?? g.game_code;
        // Curation is resolved HERE, so the upsert writes the final values and
        // an admin's work survives every re-sync.
        const target = {
          uuid,
          aggregator: 'NEXUS',
          providerCode: p.code,
          name: providerName,
          gameCode: g.game_code,
          derivedType,
        };

        batch.push([
          uuid,
          this.curation.resolveName(curation, uuid, providerName),
          g.banner ?? '',
          this.curation.resolveType(curation, target),
          p.name ?? p.code,
          p.code,
          g.game_code,
          g.game_code,
          g.game_code,
          JSON.stringify({ rtp: 95, volatility: null, reels_count: null, lines_count: null }),
          derivedType,
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
  /**
   * Catalog rows for the curation screen, each carrying its curation state:
   * what the sync derived, what it is now, and whether a human pinned it.
   */
  async listForCuration(q: {
    provider?: string;
    type?: string;
    search?: string;
    page: number;
    limit: number;
  }) {
    const limit = Math.min(Math.max(q.limit, 1), 200);
    const offset = (Math.max(q.page, 1) - 1) * limit;
    const where: string[] = [`g.aggregator = 'NEXUS'`];
    const params: any[] = [];
    if (q.provider) {
      params.push(q.provider);
      where.push(`g.vendor_code = $${params.length}`);
    }
    if (q.type) {
      params.push(q.type);
      where.push(`g.type = $${params.length}`);
    }
    if (q.search?.trim()) {
      params.push(`%${q.search.trim()}%`);
      where.push(`(g.name ILIKE $${params.length} OR g.game_code ILIKE $${params.length})`);
    }
    const clause = `WHERE ${where.join(' AND ')}`;

    const [rows, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT g.uuid, g.name, g.game_code, g.vendor_code, g.provider,
                -- The EFFECTIVE picture, matching what players and the rail
                -- preview see. Selecting g.image here left this screen showing
                -- the provider's artwork after an admin had replaced it.
                COALESCE(o.image_url, g.image) AS image,
                (o.image_url IS NOT NULL)      AS "imageOverridden",
                g.type, COALESCE(g.derived_type, g.type) AS derived_type,
                o.type AS override_type, o.display_name AS override_name, o.note
           FROM casino_games g
           LEFT JOIN casino_game_overrides o ON o.game_uuid = g.uuid
           ${clause}
          ORDER BY g.provider, g.name
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM casino_games g ${clause}`,
        params,
      ),
    ]);

    // The distinct values the screen's filters offer, so the UI never shows a
    // category that does not exist in the catalog.
    const [providers, types] = await Promise.all([
      this.dataSource.query(
        `SELECT DISTINCT vendor_code AS code, provider AS name FROM casino_games
          WHERE aggregator = 'NEXUS' ORDER BY 2`,
      ),
      this.dataSource.query(
        `SELECT DISTINCT type FROM casino_games WHERE aggregator = 'NEXUS' ORDER BY 1`,
      ),
    ]);

    return {
      data: rows,
      total,
      page: Math.max(q.page, 1),
      limit,
      totalPages: Math.ceil(total / limit) || 0,
      filters: { providers, types: types.map((t: any) => t.type) },
    };
  }

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
