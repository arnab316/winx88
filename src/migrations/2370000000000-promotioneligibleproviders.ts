import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Which PROVIDERS a bonus's turnover may be cleared with.
 *
 * 2360 made the vertical checkboxes mean something ("only Live Casino play
 * clears this bonus"). A vertical is often too coarse: an admin funding a
 * slots bonus with one studio's free rounds needs "Slots, but only Pragmatic",
 * not every slot in the catalogue. This is that second axis.
 *
 *   promotions.eligible_providers   [] = every provider counts
 *
 * Each entry is "<VERTICAL>|<SOURCE>:<VENDOR>" — SLOT|NEXUS:PRAGMATIC,
 * LIVE|OROPLAY:EVOLUTION, SLOT|PALACE:12, LOTTERY|OWN:HOUSE,
 * SPORTS|SPORTS:HOUSE.
 *
 * Both halves are load-bearing:
 *
 *   the source  OroPlay and Nexus both carry a vendor called "Evolution",
 *               and Palace identifies providers by a numeric id, so a vendor
 *               code alone is not an identity
 *   the vertical a vertical named in the list is narrowed to the providers
 *               listed under it, and one absent from the list is left
 *               unrestricted. A flat list would make "Slots: Pragmatic only"
 *               silently shut off every Live Casino table the same promotion
 *               had just allowed.
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
