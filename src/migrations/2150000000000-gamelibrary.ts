import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GAME LIBRARY — favourites + the indexes "Continue Playing" needs.
 *
 * FAVOURITES
 * ----------
 * A favourite can't be keyed on `casino_games.uuid`: slots and live-casino
 * games are served to the player panel straight from the Palace / OroPlay
 * APIs, and only ~90% of played slot codes resolve to a `casino_games` row at
 * all (Amusnet, EGT and Solidicon resolve to none). Keying on the catalog
 * would make those games silently un-favouritable.
 *
 * So the key is the same triple the launch endpoints already use:
 *   (kind, provider_ref, game_code)
 *     SLOT  -> provider_ref = slot_transactions.provider_id
 *     ORO   -> provider_ref = oroplay_transactions.vendor_code
 *     NEXUS -> provider_ref = nexus_transactions.provider_code
 *
 * `game_name` / `game_image` / `provider_name` are SNAPSHOTS taken when the
 * game is favourited. That is deliberate denormalisation: without it, rendering
 * a favourites list would mean fanning out to three third-party APIs on every
 * page load. A nightly catalog sync can refresh them; staleness here is
 * cosmetic, never functional, because launching uses the key triple only.
 *
 * INDEXES
 * -------
 * `slot_transactions` (1.7M+ rows) and `oroplay_transactions` only carry a
 * `user_id` index, so the per-user "most recent distinct game" aggregation
 * behind Continue Playing would sort every row a heavy player owns. The
 * composite (user_id, created_at DESC) lets it walk the newest rows and stop.
 * `nexus_transactions` already has the equivalent index.
 *
 * Idempotent.
 */
export class GameLibrary2150000000000 implements MigrationInterface {
  name = 'GameLibrary2150000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.user_favourite_games (
        id            BIGSERIAL PRIMARY KEY,
        user_id       INTEGER      NOT NULL,
        kind          VARCHAR(16)  NOT NULL,
        provider_ref  VARCHAR(100) NOT NULL,
        game_code     VARCHAR(150) NOT NULL,
        game_name     VARCHAR(255),
        game_image    VARCHAR(500),
        provider_name VARCHAR(150),
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_favourite_kind CHECK (kind IN ('SLOT','ORO','NEXUS'))
      );
    `);

    // One row per player per game; the service relies on this for ON CONFLICT.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_user_favourite_game
        ON public.user_favourite_games (user_id, kind, provider_ref, game_code);
    `);

    // Drives "my favourites, newest first".
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_user_favourite_user_created
        ON public.user_favourite_games (user_id, created_at DESC);
    `);

    // Continue Playing lookups.
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_slot_tx_user_created
        ON public.slot_transactions (user_id, created_at DESC);
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_oroplay_tx_user_created
        ON public.oroplay_transactions (user_id, created_at DESC);
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS public.idx_oroplay_tx_user_created;`);
    await q.query(`DROP INDEX IF EXISTS public.idx_slot_tx_user_created;`);
    await q.query(`DROP INDEX IF EXISTS public.idx_user_favourite_user_created;`);
    await q.query(`DROP INDEX IF EXISTS public.uq_user_favourite_game;`);
    await q.query(`DROP TABLE IF EXISTS public.user_favourite_games;`);
  }
}
