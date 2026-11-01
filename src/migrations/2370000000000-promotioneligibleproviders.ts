import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Which PROVIDERS a bonus's turnover may be cleared with.
 *
 * 2360 made the vertical checkboxes mean something ("only Live Casino play
 * clears this bonus"). A vertical is often too coarse: an admin funding a
 * slots bonus with one studio's free rounds needs "Slots, but only Pragmatic",
 * not every slot in the catalogue. This is that second axis.
 *
 *   promotions.eligible_providers   [] = every provider counts, otherwise
 *                                   ONLY the listed ones do
 *
 * Each entry is "<SOURCE>:<VENDOR>" — NEXUS:PRAGMATIC, OROPLAY:EVOLUTION,
 * PALACE:12, OWN:HOUSE, SPORTS:HOUSE. The source prefix is load-bearing:
 * OroPlay and Nexus both carry a vendor called "Evolution", and Palace
 * identifies providers by a numeric id, so a vendor code alone is not an
 * identity.
 *
 * This list and eligible_game_categories are ORTHOGONAL and compose by AND —
 * "Slots" plus "NEXUS:PRAGMATIC" clears on Pragmatic's slots only.
 *
 * Snapshot onto the requirement for the same reason the other two rules are:
 * a player accepts a bonus on the terms shown at the time, and an edit to the
 * promotion must not retroactively narrow what a half-cleared requirement
 * accepts.
 *
 *   turnover_requirements.eligible_providers   NULL = every provider counts
 *
 * Existing rows get '[]' / NULL, so nothing in flight changes behaviour.
 *
 * Idempotent.
 */
export class PromotionEligibleProviders2370000000000
  implements MigrationInterface
{
  name = 'PromotionEligibleProviders2370000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.promotions
        ADD COLUMN IF NOT EXISTS eligible_providers JSONB NOT NULL DEFAULT '[]'::jsonb;
    `);

    await q.query(`
      ALTER TABLE public.turnover_requirements
        ADD COLUMN IF NOT EXISTS eligible_providers JSONB;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.turnover_requirements
        DROP COLUMN IF EXISTS eligible_providers;
    `);
    await q.query(`
      ALTER TABLE public.promotions
        DROP COLUMN IF EXISTS eligible_providers;
    `);
  }
}
