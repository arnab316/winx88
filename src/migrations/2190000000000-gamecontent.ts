import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GAME CONTENT — admin-authored content for a game, plus the curation that
 * drives the Hot Games screen.
 *
 * WHY THIS TABLE EXISTS
 * ---------------------
 * The provider catalog gives us almost nothing: `casino_games.tags`, `images`,
 * `related_games` and `is_new` are empty for every row, there is no RTP column,
 * and OroPlay games are not in the catalog at all. So About / Features /
 * Screenshots / badges can only come from an admin. This is that store.
 *
 * IDENTITY
 * --------
 * The same (kind, provider_ref, game_code) triple used by
 * `user_favourite_games`, because games are served from three different
 * provider APIs and ~10% of played slot codes resolve to no catalog row:
 *   SLOT  -> provider_ref = Palace provider_id
 *   ORO   -> provider_ref = OroPlay vendor_code
 *   NEXUS -> provider_ref = Nexus provider_code
 *
 * `display_name` / `provider_name` / `cover_image` are optional OVERRIDES. They
 * matter most for OroPlay, where nothing else can supply a name or artwork, so
 * without them the listing would show a raw code like "60106-1".
 *
 * CURATION VIA BADGES
 * -------------------
 * `badges` (e.g. ["HOT","POPULAR"]) is what puts a game on a collection screen:
 * Hot Games lists games badged HOT, ordered by `sort_order`. Adding any future
 * game to Hot Games is just adding the badge — no schema or code change — and
 * the same mechanism powers a New Games screen (badge NEW) later. The listing's
 * Popular / New filter chips map to the POPULAR / NEW badges, while the Slots /
 * Live Casino chips filter on `kind`.
 *
 * `features` holds the small stat chips under the title, as
 * [{labelEn, labelBn}]. Deliberately free-text: the provider supplies no
 * structured metadata, and RTP is excluded by product decision.
 *
 * Idempotent.
 */
export class GameContent2190000000000 implements MigrationInterface {
  name = 'GameContent2190000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.game_content (
        id            SERIAL PRIMARY KEY,
        kind          VARCHAR(16)  NOT NULL,
        provider_ref  VARCHAR(100) NOT NULL,
        game_code     VARCHAR(150) NOT NULL,

        display_name  VARCHAR(255),
        provider_name VARCHAR(150),
        cover_image   VARCHAR(500),

        about_en      TEXT,
        about_bn      TEXT,
        features      JSONB NOT NULL DEFAULT '[]'::jsonb,
        screenshots   JSONB NOT NULL DEFAULT '[]'::jsonb,
        badges        JSONB NOT NULL DEFAULT '[]'::jsonb,

        sort_order    INTEGER     NOT NULL DEFAULT 0,
        is_active     BOOLEAN     NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT chk_game_content_kind CHECK (kind IN ('SLOT','ORO','NEXUS'))
      );
    `);

    // One content row per game; the service relies on this for ON CONFLICT.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_game_content_identity
        ON public.game_content (kind, provider_ref, game_code);
    `);

    // Collection screens read "active games carrying badge X, in order".
    // GIN over badges makes the ? containment test an index lookup.
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_game_content_badges
        ON public.game_content USING GIN (badges);
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_game_content_active_order
        ON public.game_content (sort_order, id) WHERE is_active;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS public.idx_game_content_active_order;`);
    await q.query(`DROP INDEX IF EXISTS public.idx_game_content_badges;`);
    await q.query(`DROP INDEX IF EXISTS public.uq_game_content_identity;`);
    await q.query(`DROP TABLE IF EXISTS public.game_content;`);
  }
}
