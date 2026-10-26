import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { unwrapReturning } from 'src/common/link-target';
import { GameLibraryService } from 'src/game-library/game-library.service';

export const RAIL_MODES = ['FILTER', 'CURATED'] as const;
export type RailMode = (typeof RAIL_MODES)[number];

export interface RailInput {
  key: string;
  titleEn: string;
  titleBn?: string | null;
  subtitleEn?: string | null;
  subtitleBn?: string | null;
  mode: RailMode;
  providers?: string[];
  category?: string | null;
  aggregator?: string | null;
  gameUuids?: string[];
  rowLimit?: number;
  showViewAll?: boolean;
  sortOrder?: number;
  isActive?: boolean;
}

/**
 * Admin-built game rows on the player home.
 *
 * Games are always resolved through GameLibraryService.browseCatalog — the
 * same reader the catalog browser and /nexus/games use. That is deliberate:
 * it derives `kind` / `providerRef` / `gameCode` in one place, and favourites
 * key on exactly that triple. A second query here would eventually disagree,
 * and a game favourited from a rail would stop matching itself elsewhere.
 */
@Injectable()
export class GameRailsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly library: GameLibraryService,
  ) {}

  private readonly SELECT = `
    SELECT id, key, title_en AS "titleEn", title_bn AS "titleBn",
           subtitle_en AS "subtitleEn", subtitle_bn AS "subtitleBn",
           mode, providers, category, aggregator,
           game_uuids AS "gameUuids", row_limit AS "rowLimit",
           show_view_all AS "showViewAll", sort_order AS "sortOrder",
           is_active AS "isActive", created_at AS "createdAt"
      FROM game_rails`;

  // ── read ────────────────────────────────────────────────────────────

  /** The filter a rail resolves to, in the shape browseCatalog expects. */
  private queryFor(rail: any, page: number, limit: number) {
    return rail.mode === 'CURATED'
      ? { uuids: rail.gameUuids ?? [], page, limit }
      : {
          providers: rail.providers?.length ? rail.providers : undefined,
          type: rail.category || undefined,
          aggregator: rail.aggregator || undefined,
          page,
          limit,
        };
  }

  /**
   * Every active rail WITH its games, for the home screen.
   *
   * Rails are resolved in parallel but each is independent: one rail whose
   * provider has no games must not blank the whole home screen, so a failure
   * yields an empty rail and the rest still render.
   */
  async listActiveWithGames(userId: number | null) {
    const rails = await this.dataSource.query(
      `${this.SELECT} WHERE is_active ORDER BY sort_order, id`,
    );

    const resolved = await Promise.all(
      rails.map(async (rail: any) => {
        try {
          const page = await this.library.browseCatalog(
            userId,
            this.queryFor(rail, 1, rail.rowLimit),
          );
          return { ...rail, games: page.data, totalGames: page.total };
        } catch {
          return { ...rail, games: [], totalGames: 0 };
        }
      }),
    );

    // An empty rail is a heading with nothing under it. Drop it rather than
    // render a row the player cannot use.
    return resolved.filter((r: any) => r.games.length > 0);
  }

  /** One rail's games, paged — what "View All" scrolls through. */
  async railGames(key: string, userId: number | null, page = 1, limit = 24) {
    const [rail] = await this.dataSource.query(
      `${this.SELECT} WHERE key = $1 AND is_active LIMIT 1`,
      [key],
    );
    if (!rail) throw new NotFoundException('Rail not found');

    const res = await this.library.browseCatalog(
      userId,
      this.queryFor(rail, page, limit),
    );
    return {
      rail: {
        key: rail.key,
        titleEn: rail.titleEn,
        titleBn: rail.titleBn,
        subtitleEn: rail.subtitleEn,
        subtitleBn: rail.subtitleBn,
      },
      ...res,
    };
  }

  listAll() {
    return this.dataSource.query(`${this.SELECT} ORDER BY sort_order, id`);
  }

  // ── write (admin) ───────────────────────────────────────────────────

  private validate(input: Partial<RailInput>, requireAll: boolean) {
    if (input.key !== undefined && !/^[a-z0-9-]{2,40}$/.test(input.key)) {
      throw new BadRequestException(
        'key must be 2-40 characters of lowercase letters, digits or -',
      );
    }
    if ((requireAll || input.mode !== undefined) &&
        !RAIL_MODES.includes(input.mode as RailMode)) {
      throw new BadRequestException(`mode must be one of ${RAIL_MODES.join(', ')}`);
    }
    // A curated rail with no games renders an empty row; the DB refuses it
    // too, but a clear message beats a constraint violation.
    if (input.mode === 'CURATED' && requireAll && !input.gameUuids?.length) {
      throw new BadRequestException('A curated rail needs at least one game');
    }
    if (input.rowLimit != null && (input.rowLimit < 1 || input.rowLimit > 50)) {
      throw new BadRequestException('rowLimit must be between 1 and 50');
    }
  }

  async create(input: RailInput) {
    this.validate(input, true);
    const [row] = await this.dataSource
      .query(
        `INSERT INTO game_rails
           (key, title_en, title_bn, subtitle_en, subtitle_bn, mode,
            providers, category, aggregator, game_uuids, row_limit,
            show_view_all, sort_order, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9,$10::text[],$11,$12,$13,$14)
         RETURNING id`,
        [
          input.key.trim(),
          input.titleEn.trim(),
          input.titleBn?.trim() || null,
          input.subtitleEn?.trim() || null,
          input.subtitleBn?.trim() || null,
          input.mode,
          input.providers ?? [],
          input.category?.trim() || null,
          input.aggregator?.trim() || null,
          input.gameUuids ?? [],
          input.rowLimit ?? 12,
          input.showViewAll ?? true,
          input.sortOrder ?? 0,
          input.isActive ?? true,
        ],
      )
      .catch((e: any) => {
        if (e?.code === '23505') throw new BadRequestException('That key is already used');
        throw e;
      });
    return this.byId(row.id);
  }

  async update(id: number, input: Partial<RailInput>) {
    this.validate(input, false);
    const sets: string[] = [];
    const params: any[] = [];
    const set = (col: string, v: any, cast = '') => {
      params.push(v);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    if (input.key !== undefined) set('key', input.key.trim());
    if (input.titleEn !== undefined) set('title_en', input.titleEn.trim());
    if (input.titleBn !== undefined) set('title_bn', input.titleBn?.trim() || null);
    if (input.subtitleEn !== undefined) set('subtitle_en', input.subtitleEn?.trim() || null);
    if (input.subtitleBn !== undefined) set('subtitle_bn', input.subtitleBn?.trim() || null);
    if (input.mode !== undefined) set('mode', input.mode);
    if (input.providers !== undefined) set('providers', input.providers, '::text[]');
    if (input.category !== undefined) set('category', input.category?.trim() || null);
    if (input.aggregator !== undefined) set('aggregator', input.aggregator?.trim() || null);
    if (input.gameUuids !== undefined) set('game_uuids', input.gameUuids, '::text[]');
    if (input.rowLimit !== undefined) set('row_limit', input.rowLimit);
    if (input.showViewAll !== undefined) set('show_view_all', input.showViewAll);
    if (input.sortOrder !== undefined) set('sort_order', input.sortOrder);
    if (input.isActive !== undefined) set('is_active', input.isActive);
    if (!sets.length) return this.byId(id);

    params.push(id);
    const result = await this.dataSource
      .query(
        `UPDATE game_rails SET ${sets.join(', ')}, updated_at = NOW()
          WHERE id = $${params.length} RETURNING id`,
        params,
      )
      .catch((e: any) => {
        if (e?.code === '23505') throw new BadRequestException('That key is already used');
        throw e;
      });
    // UPDATE ... RETURNING hands back [rows, count] in this stack.
    if (!unwrapReturning(result).length) throw new NotFoundException('Rail not found');
    return this.byId(id);
  }

  async remove(id: number) {
    const result = await this.dataSource.query(
      `DELETE FROM game_rails WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!unwrapReturning(result).length) throw new NotFoundException('Rail not found');
    return { success: true };
  }

  async reorder(ids: number[]) {
    if (!Array.isArray(ids) || !ids.length) {
      throw new BadRequestException('ids must be a non-empty array');
    }
    await this.dataSource.query(
      `UPDATE game_rails AS r SET sort_order = v.ord, updated_at = NOW()
         FROM (VALUES ${ids.map((_, i) => `($${i + 1}::int, ${(i + 1) * 10})`).join(',')})
              AS v(id, ord)
        WHERE r.id = v.id`,
      ids.map(Number),
    );
    return this.listAll();
  }

  /** What a rail WOULD show, before saving it. */
  async preview(
    input: Partial<RailInput> & { page?: number; limit?: number },
  ) {
    const rail = {
      mode: input.mode ?? 'FILTER',
      providers: input.providers ?? [],
      category: input.category ?? null,
      aggregator: input.aggregator ?? null,
      gameUuids: input.gameUuids ?? [],
    };

    // The admin is choosing what to publish, so the preview shows EVERY
    // matching game, paged — not the row's own `rowLimit`. That limit is how
    // many fit on the home screen, which is a different question from how
    // many the filter actually caught.
    const page = Math.max(Number(input.page) || 1, 1);
    const limit = Math.min(Math.max(Number(input.limit) || 60, 1), 200);

    const res = await this.library.browseCatalog(
      null,
      this.queryFor(rail, page, limit),
    );

    return {
      total: res.total,
      page: res.page,
      limit: res.limit,
      totalPages: res.totalPages,
      /** How many of these the home screen will actually show. */
      rowLimit: input.rowLimit ?? 12,
      sample: res.data,
      diagnostics: await this.explainEmpty(rail, res.total),
    };
  }

  /**
   * Why a filter matched nothing.
   *
   * "0 games match" is useless on its own: the usual cause is a provider and
   * a category that cannot both be true — Reel Kingdom ships 216 slots and no
   * live tables, so picking it alongside `live` is always empty. Telling the
   * admin that, with the number they would get by dropping the category, is
   * the difference between a dead end and one click.
   *
   * Null when there is nothing to explain.
   */
  private async explainEmpty(rail: any, total: number) {
    if (total > 0 || rail.mode === 'CURATED') return null;
    if (!rail.providers?.length) return null;

    const withoutCategory = await this.library.browseCatalog(null, {
      providers: rail.providers,
      aggregator: rail.aggregator || undefined,
      page: 1,
      limit: 1,
    });
    if (!withoutCategory.total) return null;

    // What those providers DO have, so the admin can pick a category that exists.
    const available = await this.dataSource.query(
      `SELECT c.type, COUNT(*)::int AS games
         FROM public.casino_games c
        WHERE c.under_maintenance = false
          AND c.vendor_code = ANY($1::text[])
        GROUP BY c.type
        ORDER BY games DESC`,
      [rail.providers],
    );

    return {
      reason: 'CATEGORY_EXCLUDES_PROVIDERS' as const,
      category: rail.category,
      withoutCategory: withoutCategory.total,
      availableCategories: available.map((r: any) => ({
        category: r.type,
        games: Number(r.games),
      })),
    };
  }

  private async byId(id: number) {
    const [row] = await this.dataSource.query(`${this.SELECT} WHERE id = $1`, [id]);
    if (!row) throw new NotFoundException('Rail not found');
    return row;
  }
}
