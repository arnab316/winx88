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
}
