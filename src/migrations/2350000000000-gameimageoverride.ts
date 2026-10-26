import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-game artwork override.
 *
 * Providers ship the banner, and some of them ship a bad one — wrong aspect,
 * stale branding, or nothing at all. An admin can now point a game at their
 * own image.
 *
 * Stored alongside the category override rather than written into
 * casino_games.image, and applied at READ time, for two reasons:
 *
 *   - a catalog re-sync upserts image from the provider, so anything written
 *     into the catalog row would be silently reverted on the next sync
 *   - clearing the override then reverts the game to the provider's artwork
 *     by itself, with nothing to undo
 *
 * Idempotent.
 */
export class GameImageOverride2350000000000 implements MigrationInterface {
  name = 'GameImageOverride2350000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.casino_game_overrides
        ADD COLUMN IF NOT EXISTS image_url TEXT;
    `);

    // No index needed: casino_game_overrides_pkey is already a unique btree on
    // game_uuid, which is exactly what the catalog read joins on.
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.casino_game_overrides
        DROP COLUMN IF EXISTS image_url;
    `);
  }
}
