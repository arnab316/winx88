import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Admin curation of catalog categories and display names.
 *
 * The catalog sync rewrites `name` and `type` on every run, so curation cannot
 * live on the synced row. It lives here instead, and the sync asks this service
 * what the final values should be:
 *
 *   per-game override  ->  first matching rule  ->  derived_type
 *
 * Rules exist because the alternative is clicking through thousands of games:
 * PP_LIVE_PRO alone ships 200+ live tables that need splitting across roulette,
 * baccarat, blackjack and crash, and one rule keeps working as the provider
 * adds titles.
 */

export interface GameRule {
  id: number;
  priority: number;
  aggregator: string | null;
  provider_code: string | null;
  match_field: 'name' | 'game_code';
  pattern: string;
  is_regex: boolean;
  type: string;
  is_active: boolean;
}

export interface GameOverride {
  game_uuid: string;
  type: string | null;
  display_name: string | null;
  note: string | null;
  image_url: string | null;
}

/** Everything needed to decide one game's category, loaded once per sync. */
export interface CurationSet {
  rules: GameRule[];
  overrides: Map<string, GameOverride>;
}

/** The shape a rule is matched against. */
export interface CurationTarget {
  uuid: string;
  aggregator: string;
  providerCode: string;
  name: string;
  gameCode: string;
  derivedType: string;
}

@Injectable()
export class GameCurationService {
  private readonly logger = new Logger(GameCurationService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  // ── loading ─────────────────────────────────────────────────────────────

  /**
   * Load rules and overrides together.
   *
   * Loaded ONCE and matched in memory: a sync touches thousands of games, and
   * a query per game would dominate the run.
   */
  async load(): Promise<CurationSet> {
    const rules: GameRule[] = await this.dataSource.query(
      `SELECT id, priority, aggregator, provider_code, match_field, pattern,
              is_regex, type, is_active
         FROM casino_game_rules
        WHERE is_active
        ORDER BY priority ASC, id ASC`,
    );
    const rows: GameOverride[] = await this.dataSource.query(
      `SELECT game_uuid, type, display_name, note, image_url
         FROM casino_game_overrides`,
    );
    return { rules, overrides: new Map(rows.map((r) => [r.game_uuid, r])) };
  }

  // ── resolution ──────────────────────────────────────────────────────────

  private matches(rule: GameRule, t: CurationTarget): boolean {
    if (rule.aggregator && rule.aggregator !== t.aggregator) return false;
    if (rule.provider_code && rule.provider_code !== t.providerCode) return false;
    const subject = rule.match_field === 'game_code' ? t.gameCode : t.name;
    if (!subject) return false;
    if (!rule.is_regex) {
      return subject.toLowerCase().includes(rule.pattern.toLowerCase());
    }
    try {
      return new RegExp(rule.pattern, 'i').test(subject);
    } catch {
      // A rule saved with a broken pattern must not break the whole sync.
      this.logger.warn(`[Curation] rule ${rule.id} has an invalid regex — skipped`);
      return false;
    }
  }

  /** The category this game should end up in. */
  resolveType(set: CurationSet, t: CurationTarget): string {
    const override = set.overrides.get(t.uuid);
    if (override?.type) return override.type;
    const rule = set.rules.find((r) => this.matches(r, t));
    return rule ? rule.type : t.derivedType;
  }

  /** The name players should see. */
  resolveName(set: CurationSet, uuid: string, providerName: string): string {
    return set.overrides.get(uuid)?.display_name || providerName;
  }

  // ── re-apply, without touching the provider API ─────────────────────────

  /**
   * Recompute every catalog row from `derived_type` upward.
   *
   * Always starts from `derived_type`, never from the current `type`, so
   * deleting a rule or an override actually reverts the game instead of
   * leaving the last curated value stuck in place.
   */
  async reapply(aggregator?: string): Promise<{ scanned: number; changed: number }> {
    const set = await this.load();
    const games = await this.dataSource.query(
      `SELECT uuid, name, game_code, vendor_code, aggregator, type,
              COALESCE(derived_type, type) AS derived_type
         FROM casino_games
        ${aggregator ? 'WHERE aggregator = $1' : ''}`,
      aggregator ? [aggregator] : [],
    );

    const updates: Array<[string, string]> = [];
    for (const g of games) {
      const next = this.resolveType(set, {
        uuid: g.uuid,
        aggregator: g.aggregator ?? '',
        providerCode: g.vendor_code ?? '',
        name: g.name ?? '',
        gameCode: g.game_code ?? '',
        derivedType: g.derived_type,
      });
      if (next !== g.type) updates.push([g.uuid, next]);
    }

    // One statement per 500 rather than one per game.
    for (let i = 0; i < updates.length; i += 500) {
      const chunk = updates.slice(i, i + 500);
      await this.dataSource.query(
        `UPDATE casino_games AS c SET type = v.type, updated_at = NOW()
           FROM (VALUES ${chunk
             .map((_, k) => `($${k * 2 + 1}, $${k * 2 + 2})`)
             .join(',')}) AS v(uuid, type)
          WHERE c.uuid = v.uuid`,
        chunk.flat(),
      );
    }

    this.logger.log(
      `[Curation] re-applied${aggregator ? ` (${aggregator})` : ''}: ` +
        `${updates.length} of ${games.length} game(s) re-filed`,
    );
    return { scanned: games.length, changed: updates.length };
  }

  // ── admin CRUD ──────────────────────────────────────────────────────────

  listRules(): Promise<GameRule[]> {
    return this.dataSource.query(
      `SELECT * FROM casino_game_rules ORDER BY priority ASC, id ASC`,
    );
  }

  async upsertRule(dto: Partial<GameRule> & { type: string; pattern: string }) {
    if (!dto.pattern?.trim()) throw new BadRequestException('pattern is required');
    if (!dto.type?.trim()) throw new BadRequestException('type is required');
    if (dto.is_regex) {
      // Reject a broken regex at save time rather than letting it silently
      // match nothing for weeks.
      try {
        new RegExp(dto.pattern, 'i');
      } catch {
        throw new BadRequestException('pattern is not a valid regular expression');
      }
    }
    const params = [
      dto.priority ?? 100,
      dto.aggregator ?? null,
      dto.provider_code ?? null,
      dto.match_field ?? 'name',
      dto.pattern.trim(),
      dto.is_regex ?? false,
      dto.type.trim(),
      dto.is_active ?? true,
    ];
    if (dto.id) {
      const r = await this.dataSource.query(
        `UPDATE casino_game_rules
            SET priority=$1, aggregator=$2, provider_code=$3, match_field=$4,
                pattern=$5, is_regex=$6, type=$7, is_active=$8, updated_at=NOW()
          WHERE id=$9 RETURNING *`,
        [...params, dto.id],
      );
      // UPDATE ... RETURNING gives [rows, count]; the rows are the first element.
      const rows = Array.isArray(r[0]) ? r[0] : r;
      if (!rows.length) throw new BadRequestException('Rule not found');
      return rows[0];
    }
    const [row] = await this.dataSource.query(
      `INSERT INTO casino_game_rules
         (priority, aggregator, provider_code, match_field, pattern, is_regex, type, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      params,
    );
    return row;
  }

  async deleteRule(id: number) {
    const r = await this.dataSource.query(
      `DELETE FROM casino_game_rules WHERE id = $1 RETURNING id`,
      [id],
    );
    const rows = Array.isArray(r[0]) ? r[0] : r;
    if (!rows.length) throw new BadRequestException('Rule not found');
    return { success: true };
  }

  /** Set or clear a single game's override. Nulls clear that field. */
  async setOverride(
    gameUuid: string,
    dto: {
      type?: string | null;
      displayName?: string | null;
      note?: string | null;
      /** Replacement artwork. Empty string clears it back to the provider's. */
      imageUrl?: string | null;
    },
    adminId?: number,
  ) {
    const [game] = await this.dataSource.query(
      `SELECT uuid FROM casino_games WHERE uuid = $1 LIMIT 1`,
      [gameUuid],
    );
    if (!game) throw new BadRequestException('Game not found');

    const type = dto.type?.trim() || null;
    const name = dto.displayName?.trim() || null;
    const note = dto.note?.trim() || null;
    const image = dto.imageUrl?.trim() || null;

    // Nothing left to pin? Drop the row instead of keeping an empty one, so
    // "cleared" and "never set" look the same to the resolver — and so a game
    // whose artwork override is removed falls back to the provider's image
    // with nothing to undo.
    if (!type && !name && !image) {
      await this.dataSource.query(
        `DELETE FROM casino_game_overrides WHERE game_uuid = $1`,
        [gameUuid],
      );
    } else {
      await this.dataSource.query(
        `INSERT INTO casino_game_overrides
           (game_uuid, type, display_name, note, image_url, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (game_uuid) DO UPDATE SET
           type = EXCLUDED.type, display_name = EXCLUDED.display_name,
           note = EXCLUDED.note, image_url = EXCLUDED.image_url,
           updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [gameUuid, type, name, note, image, adminId ?? null],
      );
    }
    return this.reapplyOne(gameUuid);
  }

  /** Apply curation to one game immediately, so the admin sees the result. */
  private async reapplyOne(uuid: string) {
    const set = await this.load();
    const [g] = await this.dataSource.query(
      `SELECT uuid, name, game_code, vendor_code, aggregator,
              COALESCE(derived_type, type) AS derived_type
         FROM casino_games WHERE uuid = $1 LIMIT 1`,
      [uuid],
    );
    if (!g) throw new BadRequestException('Game not found');
    const type = this.resolveType(set, {
      uuid: g.uuid,
      aggregator: g.aggregator ?? '',
      providerCode: g.vendor_code ?? '',
      name: g.name ?? '',
      gameCode: g.game_code ?? '',
      derivedType: g.derived_type,
    });
    const name = set.overrides.get(uuid)?.display_name || null;
    await this.dataSource.query(
      `UPDATE casino_games
          SET type = $2, name = COALESCE($3, name), updated_at = NOW()
        WHERE uuid = $1`,
      [uuid, type, name],
    );
    return { success: true, uuid, type };
  }

  /**
   * What a rule WOULD do, without doing it. An admin should be able to see
   * that a pattern matches 14 games before it re-files 400.
   */
  async previewRule(dto: Partial<GameRule> & { pattern: string; type: string }) {
    const rule: GameRule = {
      id: 0,
      priority: dto.priority ?? 100,
      aggregator: dto.aggregator ?? null,
      provider_code: dto.provider_code ?? null,
      match_field: dto.match_field ?? 'name',
      pattern: dto.pattern,
      is_regex: dto.is_regex ?? false,
      type: dto.type,
      is_active: true,
    };
    const games = await this.dataSource.query(
      `SELECT uuid, name, game_code, vendor_code, aggregator, type
         FROM casino_games
        ${rule.aggregator ? 'WHERE aggregator = $1' : ''}`,
      rule.aggregator ? [rule.aggregator] : [],
    );
    const hits = games.filter((g: any) =>
      this.matches(rule, {
        uuid: g.uuid,
        aggregator: g.aggregator ?? '',
        providerCode: g.vendor_code ?? '',
        name: g.name ?? '',
        gameCode: g.game_code ?? '',
        derivedType: g.type,
      }),
    );
    return {
      matched: hits.length,
      sample: hits.slice(0, 20).map((g: any) => ({
        uuid: g.uuid,
        name: g.name,
        provider: g.vendor_code,
        currentType: g.type,
        newType: rule.type,
      })),
    };
  }
}
