import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Which games a bonus's turnover may be cleared with.
 *
 * `promotions.eligible_game_categories` has existed since 1700 but was only
 * ever STORED — nothing read it, so every bet counted toward every
 * requirement whatever the admin ticked. This makes it mean something, and
 * adds the exclude list that sits beside it on the promotion form.
 *
 *   promotions.excluded_game_keys        games that never count, as the
 *                                        "SOURCE:code" keys CatalogService
 *                                        already hands the admin UI
 *
 * The rules are SNAPSHOT onto the requirement when it is created rather than
 * read live from the promotion:
 *
 *   turnover_requirements.eligible_categories   NULL = every category counts
 *   turnover_requirements.excluded_game_keys    [] = nothing is excluded
 *
 * A player accepts a bonus on the terms shown at the time. Reading the
 * promotion live would let an edit retroactively narrow what a half-cleared
 * requirement accepts — the player would have wagered against rules that no
 * longer exist, with no way to tell why their progress stopped.
 *
 * Existing requirements get NULL / '[]', so nothing already in flight changes
 * behaviour.
 *
 * Idempotent.
 */
export class TurnoverGameEligibility2360000000000 implements MigrationInterface {
  name = 'TurnoverGameEligibility2360000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.promotions
        ADD COLUMN IF NOT EXISTS excluded_game_keys JSONB NOT NULL DEFAULT '[]'::jsonb;
    `);

    await q.query(`
      ALTER TABLE public.turnover_requirements
        ADD COLUMN IF NOT EXISTS eligible_categories JSONB,
        ADD COLUMN IF NOT EXISTS excluded_game_keys  JSONB NOT NULL DEFAULT '[]'::jsonb;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.turnover_requirements
        DROP COLUMN IF EXISTS excluded_game_keys,
        DROP COLUMN IF EXISTS eligible_categories;
    `);
    await q.query(`
      ALTER TABLE public.promotions
        DROP COLUMN IF EXISTS excluded_game_keys;
    `);
  }
}
