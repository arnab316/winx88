import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { toVertical, oroplayVertical } from '../common/game-vertical';

/**
 * Read-only catalog feed for the admin UI.
 *
 *   - getCategories(): the fixed "verticals" that drive the Provider checkboxes
 *     on a promotion (BONUS AMOUNT PROVIDERS). These are the values stored in
 *     promotions.eligible_game_categories — keep this list in sync with
 *     GAME_CATEGORIES in src/promotion/dto/promotion.dto.ts.
 *
 *   - getProviders(): every provider behind those verticals, across all four
 *     integrations, each tagged with the verticals it offers so the form can
 *     list a vertical's providers when it is expanded.
 *
 *   - getGames(): every game the admin can reference (e.g. for the Exclude Game
 *     List), unified from three physical sources:
 *       OWN     → our own lottery/jackpot games (games table)
 *       PALACE  → distinct slot game codes seen in slot_transactions
 *       OROPLAY → distinct game codes seen in oroplay_transactions
 *     Each row carries a stable `key` ("<SOURCE>:<id|code>") the frontend can
 *     persist in an exclude list.
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(private readonly dataSource: DataSource) {}

  // Canonical vertical list (code + display label). Single source of truth for
  // the Provider checkboxes. Codes must be a subset of GAME_CATEGORIES.
  private readonly CATEGORIES: { code: string; label: string }[] = [
    { code: 'LIVE',      label: 'Live Casino' },
    { code: 'SLOT',      label: 'Slots' },
    { code: 'FISH',      label: 'Fishing' },
    { code: 'EGAMES',    label: 'E-Games' },
    { code: 'HORSE',     label: 'Horse Racing' },
    { code: 'COCKFIGHT', label: 'Cockfight' },
    { code: 'SPORTS',    label: 'Sports' },
    { code: 'LOTTERY',   label: 'Lottery' },
    { code: 'TABLE',     label: 'Table Games' },
    { code: 'ARCADE',    label: 'Arcade' },
    { code: 'CRASH',     label: 'Crash' },
    { code: 'OTHER',     label: 'Other' },
  ];

  getCategories() {
    return { data: this.CATEGORIES };
  }

  async getGames(
    opts: {
      search?: string;
      source?: string;
      /** Vendor code — narrows the NEXUS list to one provider. */
      provider?: string;
      limit?: number;
    } = {},
  ) {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const search = opts.search?.trim();
    const source = opts.source?.trim().toUpperCase();
    const provider = opts.provider?.trim() || null;
    const like = search ? `%${search}%` : null;

    const games: Array<{
      key: string; code: string; name: string; category: string; source: string;
      provider?: string | null;
    }> = [];

    // ── OWN: lottery/jackpot games we run ourselves ───────────────────────
    if (!source || source === 'OWN') {
      try {
        const rows = await this.dataSource.query(
          `SELECT 'OWN:' || g.id AS key, g.code, g.name, 'LOTTERY' AS category, 'OWN' AS source
             FROM games g
            WHERE g.is_active = true
              ${like ? `AND (g.name ILIKE $1 OR g.code ILIKE $1)` : ``}
            ORDER BY g.name
            LIMIT ${limit}`,
          like ? [like] : [],
        );
        games.push(...rows);
      } catch (e: any) {
        this.logger.warn(`catalog OWN games query failed: ${e.message}`);
      }
    }

    // ── PALACE: distinct slot game codes from transaction history ─────────
    if (!source || source === 'PALACE') {
      try {
        const rows = await this.dataSource.query(
          `SELECT DISTINCT 'PALACE:' || st.game_code AS key,
                  st.game_code AS code, st.game_code AS name,
                  'SLOT' AS category, 'PALACE' AS source
             FROM slot_transactions st
            WHERE st.game_code IS NOT NULL
              ${like ? `AND st.game_code ILIKE $1` : ``}
            ORDER BY st.game_code
            LIMIT ${limit}`,
          like ? [like] : [],
        );
        games.push(...rows);
      } catch (e: any) {
        this.logger.warn(`catalog PALACE games query failed: ${e.message}`);
      }
    }

    // ── OROPLAY: distinct game codes; map game_type → vertical ────────────
    if (!source || source === 'OROPLAY') {
      try {
        const rows = await this.dataSource.query(
          `SELECT DISTINCT 'OROPLAY:' || o.game_code AS key,
                  o.game_code AS code, o.game_code AS name,
                  CASE o.game_type
                    WHEN 1 THEN 'LIVE'
                    WHEN 2 THEN 'SLOT'
                    WHEN 4 THEN 'FISH'
                    ELSE 'OTHER'
                  END AS category,
                  'OROPLAY' AS source
             FROM oroplay_transactions o
            WHERE o.game_code IS NOT NULL
              ${like ? `AND o.game_code ILIKE $1` : ``}
            ORDER BY o.game_code
            LIMIT ${limit}`,
          like ? [like] : [],
        );
        games.push(...rows);
      } catch (e: any) {
        this.logger.warn(`catalog OROPLAY games query failed: ${e.message}`);
      }
    }

    // ── NEXUS: the synced catalogue — by far the largest source, and the
    //    only one with real game names and a provider to group by. The other
    //    three are derived from transaction history, so they only ever list
    //    games somebody has already played.
    if (!source || source === 'NEXUS') {
      try {
        const rows = await this.dataSource.query(
          `SELECT 'NEXUS:' || c.game_code AS key,
                  c.game_code AS code,
                  c.name,
                  CASE
                    WHEN c.type IN ('slots','slot')                   THEN 'SLOT'
                    WHEN c.type IN ('live','baccarat','blackjack',
                                    'roulette','poker')               THEN 'LIVE'
                    WHEN c.type IN ('fishing','fish')                 THEN 'FISH'
                    WHEN c.type IN ('instant','crash')                THEN 'CRASH'
                    ELSE 'OTHER'
                  END AS category,
                  'NEXUS' AS source,
                  c.provider
             FROM casino_games c
            WHERE c.aggregator = 'NEXUS'
              AND c.game_code IS NOT NULL
              AND c.under_maintenance = false
              ${provider ? `AND c.vendor_code = $${like ? 2 : 1}` : ``}
              ${like ? `AND (c.name ILIKE $1 OR c.game_code ILIKE $1)` : ``}
            ORDER BY c.provider, c.name
            LIMIT ${limit}`,
          [...(like ? [like] : []), ...(provider ? [provider] : [])],
        );
        games.push(...rows);
      } catch (e: any) {
        this.logger.warn(`catalog NEXUS games query failed: ${e.message}`);
      }
    }

    return { total: games.length, data: games.slice(0, limit) };
  }

  /**
   * Every provider an admin can target, from every integration, with the
   * verticals each one actually offers.
   *
   * `casino_games` is the SHARED catalogue — all three integrations sync into
   * it and are told apart by the same markers the player-facing browse uses:
   *
   *   aggregator = 'NEXUS'   Nexus, keyed by vendor_code (slots, live, fishing,
   *                          instant and the SB sportsbook)
   *   type = 'slots'         Palace slots, keyed by the numeric provider_id
   *   anything else          OroPlay live/table vendors, keyed by vendor_code
   *
   * Driven off the catalogue rather than transaction history, so a newly
   * synced vendor is pickable immediately — an admin should not have to wait
   * for a player to try a game before being able to target its provider.
   *
   * Two sources sit outside that table and are added by hand, because both
   * can take a bet that must be targetable:
   *
   *   OWN:HOUSE      our own draw games (the `games` table)
   *   SPORTS:HOUSE   the standalone sportsbook, whose slips are not catalogue
   *                  games at all
   *
   * `category`, when given, narrows the list to providers offering that
   * vertical — which is what the promotion form asks for when a vertical is
   * expanded.
   */
  async getProviders(category?: string) {
    const wanted = category?.trim().toUpperCase() || null;

    type Row = {
      code: string;
      name: string;
      source: string;
      games: number;
      categories: string[];
    };
    const byCode = new Map<string, Row & { cats: Set<string> }>();

    const add = (
      source: string,
      ref: string | null,
      name: string,
      games: number,
      vertical: string,
    ) => {
      const id = String(ref ?? '').trim();
      if (!id) return;
      const code = `${source}:${id.toUpperCase()}`;
      let row = byCode.get(code);
      if (!row) {
        row = { code, name, source, games: 0, categories: [], cats: new Set() };
        byCode.set(code, row);
      }
      row.games += games;
      row.cats.add(vertical);
    };

    // ── The shared catalogue: Nexus + Palace + OroPlay in one pass ────────
    try {
      const rows = await this.dataSource.query(
        `SELECT CASE WHEN c.aggregator = 'NEXUS' THEN 'NEXUS'
                     WHEN c.type = 'slots'       THEN 'PALACE'
                     ELSE 'OROPLAY' END                       AS source,
                COALESCE(NULLIF(c.vendor_code, ''),
                         c.provider_id::text,
                         NULLIF(c.provider, ''))              AS ref,
                MAX(c.provider)                               AS name,
                c.type                                        AS type,
                COUNT(*)::int                                 AS games
           FROM public.casino_games c
          WHERE c.under_maintenance = false
          GROUP BY 1, 2, c.type`,
      );
      for (const r of rows) {
        add(
          r.source,
          r.ref,
          r.name || String(r.ref ?? ''),
          r.games,
          // The one mapping from a catalogue type to a promotion vertical.
          // Unknown types land in OTHER rather than vanishing — a provider
          // missing from the list cannot be targeted at all.
          toVertical(r.type) ?? 'OTHER',
        );
      }
    } catch (e: any) {
      this.logger.warn(`catalog providers query failed: ${e.message}`);
    }

    // ── OROPLAY vendors the catalogue sync does not cover ────────────────
    // `updateLiveCasinoGames` only syncs OroPlay's LIVE vendors, so its
    // fishing and mini/crash vendors never reach casino_games and would be
    // untargetable. Their vertical is carried by the vendor-code prefix, the
    // same split the betting-history report uses. Merged by code, so a vendor
    // the sync does cover is not listed twice.
    try {
      const rows = await this.dataSource.query(
        `SELECT DISTINCT o.vendor_code AS code
           FROM public.oroplay_transactions o
          WHERE o.vendor_code IS NOT NULL AND o.vendor_code <> ''`,
      );
      for (const r of rows) {
        add('OROPLAY', r.code, r.code, 0, oroplayVertical(r.code));
      }
    } catch (e: any) {
      this.logger.warn(`catalog OROPLAY providers query failed: ${e.message}`);
    }

    // ── OWN: the draw games we run ourselves ──────────────────────────────
    try {
      const [own] = await this.dataSource.query(
        `SELECT COUNT(*)::int AS games FROM public.games WHERE is_active = true`,
      );
      if (own?.games) add('OWN', 'HOUSE', 'In-House Games', own.games, 'LOTTERY');
    } catch (e: any) {
      this.logger.warn(`catalog OWN providers query failed: ${e.message}`);
    }

    // ── The two sportsbooks ───────────────────────────────────────────────
    // Listed unconditionally: neither is a synced catalogue, so there are no
    // rows to discover them from, and leaving them out would make a sports
    // promotion impossible to scope.
    //
    // Nexus's is a single LOBBY: `game_list` returns nothing for it, so it has
    // no casino_games row at all, and its bets come back on the shared
    // callback with provider_code 'SPORTSBOOK'. `add` merges by code, so this
    // is harmless if the sync ever does start producing rows for it.
    add('NEXUS', 'SPORTSBOOK', 'Nexus Sportsbook', 0, 'SPORTS');
    add('SPORTS', 'HOUSE', 'Sportsbook', 0, 'SPORTS');

    const data = [...byCode.values()]
      .map(({ cats, ...row }) => ({ ...row, categories: [...cats].sort() }))
      .filter((p) => !wanted || p.categories.includes(wanted))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { total: data.length, data };
  }

  // Convenience: everything the bonus form needs in one call.
  async getAll(search?: string) {
    const [categories, games] = await Promise.all([
      Promise.resolve(this.getCategories()),
      this.getGames({ search }),
    ]);
    return { categories: categories.data, games: games.data };
  }
}
