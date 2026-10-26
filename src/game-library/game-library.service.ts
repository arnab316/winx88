import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** Which provider family a game belongs to. Mirrors the launch endpoints. */
export type GameKind = 'SLOT' | 'ORO' | 'NEXUS';

export const GAME_KINDS: GameKind[] = ['SLOT', 'ORO', 'NEXUS'];

export interface FavouriteKey {
  kind: GameKind;
  providerRef: string;
  gameCode: string;
}

export interface AddFavouriteInput extends FavouriteKey {
  gameName?: string;
  gameImage?: string;
  providerName?: string;
}

/**
 * How the player panel should launch a given game. Launching is per-vendor,
 * so the client needs to know which endpoint to call and with what.
 */
export interface LaunchDescriptor {
  kind: GameKind;
  providerRef: string;
  gameCode: string;
  /**
   * `casino_games.uuid`, present only when the game resolves to a catalog row.
   * NEXUS launches by uuid rather than by code, so a NEXUS game with a null
   * uuid cannot be launched and the client should hide its play button.
   */
  uuid: string | null;
}

@Injectable()
export class GameLibraryService {
  private readonly logger = new Logger(GameLibraryService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /* ───────────────────────── Favourites ───────────────────────── */

  async listFavourites(userId: number) {
    const rows = await this.dataSource.query(
      `SELECT f.kind, f.provider_ref, f.game_code, f.game_name, f.game_image,
              f.provider_name, f.created_at,
              cg.uuid AS catalog_uuid
         FROM public.user_favourite_games f
         LEFT JOIN LATERAL (
           SELECT c.uuid
             FROM public.casino_games c
            WHERE (f.kind = 'SLOT'  AND c.game_symbol = f.game_code
                                    AND c.provider_id::text = f.provider_ref)
               OR (f.kind <> 'SLOT' AND c.game_code   = f.game_code
                                    AND c.vendor_code = f.provider_ref)
            LIMIT 1
         ) cg ON TRUE
        WHERE f.user_id = $1
        ORDER BY f.created_at DESC`,
      [userId],
    );

    return {
      items: rows.map((r: any) => ({
        kind: r.kind as GameKind,
        providerRef: r.provider_ref,
        gameCode: r.game_code,
        gameName: r.game_name ?? r.game_code,
        gameImage: r.game_image ?? null,
        providerName: r.provider_name ?? null,
        favouritedAt: r.created_at,
        isFavourite: true as const,
        launch: {
          kind: r.kind as GameKind,
          providerRef: r.provider_ref,
          gameCode: r.game_code,
          uuid: r.catalog_uuid ?? null,
        } satisfies LaunchDescriptor,
      })),
      total: rows.length,
    };
  }

  /**
   * Idempotent: re-favouriting refreshes the display snapshot rather than
   * erroring, so a double-tap on the heart can never 500.
   */
  async addFavourite(userId: number, input: AddFavouriteInput) {
    const key = this.assertKey(input);

    await this.dataSource.query(
      `INSERT INTO public.user_favourite_games
         (user_id, kind, provider_ref, game_code, game_name, game_image, provider_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, kind, provider_ref, game_code)
       DO UPDATE SET
         game_name     = COALESCE(EXCLUDED.game_name,     public.user_favourite_games.game_name),
         game_image    = COALESCE(EXCLUDED.game_image,    public.user_favourite_games.game_image),
         provider_name = COALESCE(EXCLUDED.provider_name, public.user_favourite_games.provider_name)`,
      [
        userId,
        key.kind,
        key.providerRef,
        key.gameCode,
        input.gameName ?? null,
        input.gameImage ?? null,
        input.providerName ?? null,
      ],
    );

    return { ...key, isFavourite: true as const };
  }

  /** Also idempotent — removing a game that isn't favourited is a no-op. */
  async removeFavourite(userId: number, input: FavouriteKey) {
    const key = this.assertKey(input);

    // TypeORM returns [rows, affectedCount] for DELETE ... RETURNING.
    const result = await this.dataSource.query(
      `DELETE FROM public.user_favourite_games
        WHERE user_id = $1 AND kind = $2 AND provider_ref = $3 AND game_code = $4
        RETURNING id`,
      [userId, key.kind, key.providerRef, key.gameCode],
    );
    const removed = Array.isArray(result?.[0]) ? result[0].length : (result?.length ?? 0);

    return { ...key, isFavourite: false as const, removed: removed > 0 };
  }

  private assertKey<T extends FavouriteKey>(input: T): T {
    const kind = String(input.kind || '').toUpperCase() as GameKind;
    if (!GAME_KINDS.includes(kind)) {
      throw new BadRequestException(
        `kind must be one of ${GAME_KINDS.join(', ')}`,
      );
    }
    const providerRef = String(input.providerRef ?? '').trim();
    const gameCode = String(input.gameCode ?? '').trim();
    if (!providerRef) throw new BadRequestException('providerRef is required');
    if (!gameCode) throw new BadRequestException('gameCode is required');

    return { ...input, kind, providerRef, gameCode };
  }

  /* ─────────────────────── Continue Playing ───────────────────── */

  /**
   * The player's most recently played games, one row per distinct game.
   *
   * Sources are the three seamless-wallet logs. Display name/image come from
   * `casino_games` where they resolve — note the join is on `game_symbol`, NOT
   * `game_code`: Palace rows leave `game_code` empty, so joining on it matches
   * nothing. Roughly 10% of played slot codes have no catalog row at all, so
   * unmatched games fall back to the raw code and a null image rather than
   * being dropped (dropping them would leave some players an empty shelf).
   */
  async getContinuePlaying(userId: number, limit = 12) {
    const safeLimit = Math.min(Math.max(Number(limit) || 12, 1), 50);

    const rows = await this.dataSource.query(
      `
      WITH recent AS (
        SELECT 'SLOT'::text            AS kind,
               st.provider_id::text    AS provider_ref,
               st.game_code            AS game_code,
               MAX(st.created_at)      AS last_played
          FROM public.slot_transactions st
         WHERE st.user_id = $1
         GROUP BY 1, 2, 3

        UNION ALL

        SELECT 'ORO'::text,
               ot.vendor_code,
               ot.game_code,
               MAX(ot.created_at)
          FROM public.oroplay_transactions ot
         WHERE ot.user_id = $1
         GROUP BY 1, 2, 3

        UNION ALL

        SELECT 'NEXUS'::text,
               nt.provider_code,
               nt.game_code,
               MAX(nt.created_at)
          FROM public.nexus_transactions nt
         WHERE nt.user_id = $1
         GROUP BY 1, 2, 3
      ),
      resolved AS (
        SELECT r.*,
               cg.uuid     AS catalog_uuid,
               cg.name     AS catalog_name,
               cg.image    AS catalog_image,
               cg.provider AS catalog_provider
          FROM recent r
          LEFT JOIN LATERAL (
            SELECT c.uuid, c.name, c.image, c.provider
              FROM public.casino_games c
             WHERE (r.kind = 'SLOT'  AND c.game_symbol = r.game_code
                                     AND c.provider_id::text = r.provider_ref)
                OR (r.kind <> 'SLOT' AND c.game_code   = r.game_code
                                     AND c.vendor_code = r.provider_ref)
             LIMIT 1
          ) cg ON TRUE
      )
      SELECT res.kind,
             res.provider_ref,
             res.game_code,
             res.last_played,
             res.catalog_uuid                          AS uuid,
             COALESCE(res.catalog_name, res.game_code) AS game_name,
             res.catalog_image                         AS game_image,
             res.catalog_provider                      AS provider_name,
             (f.id IS NOT NULL)                        AS is_favourite
        FROM resolved res
        LEFT JOIN public.user_favourite_games f
               ON f.user_id      = $1
              AND f.kind         = res.kind
              AND f.provider_ref = res.provider_ref
              AND f.game_code    = res.game_code
       ORDER BY res.last_played DESC
       LIMIT $2
      `,
      [userId, safeLimit],
    );

    return {
      items: rows.map((r: any) => ({
        kind: r.kind as GameKind,
        providerRef: r.provider_ref,
        gameCode: r.game_code,
        gameName: r.game_name,
        gameImage: r.game_image ?? null,
        providerName: r.provider_name ?? null,
        lastPlayedAt: r.last_played,
        isFavourite: Boolean(r.is_favourite),
        launch: {
          kind: r.kind as GameKind,
          providerRef: r.provider_ref,
          gameCode: r.game_code,
          uuid: r.uuid ?? null,
        } satisfies LaunchDescriptor,
      })),
      total: rows.length,
    };
  }

  /**
   * Browse the shared game catalog (`casino_games`).
   *
   * The player panel previously had no way to list the catalog: game-content
   * serves only CMS-curated rows, and the category chips read OroPlay vendor
   * groups. Neither can show the 3,494 games the Nexus sync imports, which is
   * what this is for.
   *
   * `kind` is derived from `aggregator`, not stored, and must match the triple
   * favourites and continue-playing are keyed by — otherwise a game favourited
   * from this list would not match itself anywhere else:
   *   NEXUS  -> (NEXUS, vendor_code,        game_code)
   *   PALACE -> (SLOT,  provider_id::text,  game_symbol)
   */
  async browseCatalog(
    userId: number | null,
    q: {
      type?: string;
      provider?: string;
      /** Several vendors at once — a rail may combine PRAGMATIC + PGSOFT. */
      providers?: string[];
      /** Explicit games. When set, the result is ordered to match it. */
      uuids?: string[];
      search?: string;
      aggregator?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const limit = Math.min(Math.max(Number(q.limit) || 24, 1), 100);
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * limit;

    const where: string[] = ['c.under_maintenance = false'];
    const params: any[] = [];
    const add = (sql: string, v: any) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.type) add('c.type = ?', q.type);
    if (q.provider) add('c.vendor_code = ?', q.provider);
    if (q.providers?.length) add('c.vendor_code = ANY(?::text[])', q.providers);
    if (q.uuids?.length) add('c.uuid = ANY(?::text[])', q.uuids);
    if (q.aggregator) add('c.aggregator = ?', q.aggregator);
    if (q.search?.trim()) add('c.name ILIKE ?', `%${q.search.trim()}%`);
    const clause = `WHERE ${where.join(' AND ')}`;

    // Signed out, every game is simply not a favourite — no join, no user id in
    // the query at all.
    const favJoin = userId
      ? `LEFT JOIN public.user_favourite_games f
             ON f.user_id = $${params.length + 1}
            AND f.kind = CASE WHEN c.aggregator = 'NEXUS' THEN 'NEXUS' ELSE 'SLOT' END
            AND f.provider_ref = CASE WHEN c.aggregator = 'NEXUS'
                                      THEN c.vendor_code ELSE c.provider_id::text END
            AND f.game_code = CASE WHEN c.aggregator = 'NEXUS'
                                   THEN c.game_code ELSE c.game_symbol END`
      : '';
    const favSelect = userId ? '(f.user_id IS NOT NULL)' : 'false';
    const favParams = userId ? [userId] : [];

    const [rows, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT c.uuid, c.name,
                -- An admin's artwork wins over the provider's. Applied here
                -- rather than written into casino_games, because a re-sync
                -- upserts image from the provider and would revert it.
                COALESCE(ov.image_url, c.image) AS image,
                (ov.image_url IS NOT NULL)      AS "imageOverridden",
                c.provider, c.type, c.aggregator,
                CASE WHEN c.aggregator = 'NEXUS' THEN 'NEXUS' ELSE 'SLOT' END AS kind,
                CASE WHEN c.aggregator = 'NEXUS'
                     THEN c.vendor_code ELSE c.provider_id::text END          AS "providerRef",
                CASE WHEN c.aggregator = 'NEXUS'
                     THEN c.game_code ELSE c.game_symbol END                  AS "gameCode",
                ${favSelect} AS "isFavourite"
           FROM public.casino_games c
           LEFT JOIN public.casino_game_overrides ov ON ov.game_uuid = c.uuid
           ${favJoin}
           ${clause}
          ${
            q.uuids?.length
              ? `ORDER BY array_position($${params.length + favParams.length + 3}::text[], c.uuid)`
              : 'ORDER BY c.name'
          }
          LIMIT $${params.length + favParams.length + 1}
         OFFSET $${params.length + favParams.length + 2}`,
        q.uuids?.length
          ? [...params, ...favParams, limit, offset, q.uuids]
          : [...params, ...favParams, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM public.casino_games c ${clause}`,
        params,
      ),
    ]);

    return {
      data: rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
    };
  }

  /** Providers that actually have playable games, for a filter row. */
  async browseProviders(type?: string) {
    const params: any[] = [];
    let clause = 'WHERE c.under_maintenance = false AND c.vendor_code IS NOT NULL';
    if (type) {
      params.push(type);
      clause += ` AND c.type = $1`;
    }
    return this.dataSource.query(
      `SELECT c.vendor_code AS code, MAX(c.provider) AS name, COUNT(*)::int AS games
         FROM public.casino_games c ${clause}
        GROUP BY c.vendor_code
        ORDER BY 3 DESC`,
      params,
    );
  }

}
