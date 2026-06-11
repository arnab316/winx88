import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Read-only catalog feed for the admin UI.
 *
 *   - getCategories(): the fixed "verticals" that drive the Provider checkboxes
 *     on a promotion (BONUS AMOUNT PROVIDERS). These are the values stored in
 *     promotions.eligible_game_categories — keep this list in sync with
 *     GAME_CATEGORIES in src/promotion/dto/promotion.dto.ts.
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

  async getGames(opts: { search?: string; source?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const search = opts.search?.trim();
    const source = opts.source?.trim().toUpperCase();
    const like = search ? `%${search}%` : null;

    const games: Array<{
      key: string; code: string; name: string; category: string; source: string;
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

    return { total: games.length, data: games.slice(0, limit) };
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
