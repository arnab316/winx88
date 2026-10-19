import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * game_rails — admin-built game rows on the player home.
 *
 * The home screen's rails were hardcoded: "Featured Games" is Pragmatic Play
 * via `/slot/games` with provider_id 1 baked into the component. Adding a row
 * for another provider meant a frontend release. An admin can now build as
 * many rails as they like — A, B, C — each with its own heading and ordering.
 *
 * TWO MODES, because the two things admins want are genuinely different:
 *
 *   FILTER   "everything by these providers, in this category" — stays
 *            current as the catalog grows, which is what a provider rail
 *            should do.
 *   CURATED  an explicit, ordered list of games, possibly mixing vendors.
 *            `game_uuids` IS the order; a hand-picked row where the games
 *            reshuffle themselves is not hand-picked.
 *
 * `providers` is an ARRAY so one rail can combine vendors ("Top Slots" =
 * PRAGMATIC + PGSOFT + HACKSAW) without three near-identical rails.
 *
 * The existing hardcoded Featured Games row is NOT replaced by this. Rails are
 * additional, so nothing on the home screen changes until an admin adds one.
 *
 * Idempotent.
 */
export class GameRails2310000000000 implements MigrationInterface {
  name = 'GameRails2310000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.game_rails (
        id             SERIAL       PRIMARY KEY,
        -- Stable slug used in the View All URL (/rail/top-slots), so a rail
        -- can be renamed without breaking a link someone shared.
        key            VARCHAR(40)  NOT NULL UNIQUE,

        title_en       VARCHAR(80)  NOT NULL,
        title_bn       VARCHAR(80),
        subtitle_en    VARCHAR(140),
        subtitle_bn    VARCHAR(140),

        mode           VARCHAR(10)  NOT NULL DEFAULT 'FILTER',

        -- FILTER mode. Empty array / NULL means "no restriction".
        providers      TEXT[]       NOT NULL DEFAULT '{}',
        category       VARCHAR(40),
        aggregator     VARCHAR(20),

        -- CURATED mode: the games, in display order.
        game_uuids     TEXT[]       NOT NULL DEFAULT '{}',

        -- How many appear in the row before "View All".
        row_limit      SMALLINT     NOT NULL DEFAULT 12,
        show_view_all  BOOLEAN      NOT NULL DEFAULT TRUE,

        sort_order     INTEGER      NOT NULL DEFAULT 0,
        is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

        CONSTRAINT chk_game_rail_mode CHECK (mode IN ('FILTER', 'CURATED')),
        CONSTRAINT chk_game_rail_limit CHECK (row_limit BETWEEN 1 AND 50),
        -- A curated rail with no games is an empty row on the home screen.
        CONSTRAINT chk_game_rail_curated
          CHECK (mode <> 'CURATED' OR array_length(game_uuids, 1) > 0)
      );
    `);

    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_game_rails_active_order
        ON public.game_rails (sort_order, id) WHERE is_active;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS public.game_rails;`);
  }
}
