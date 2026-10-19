import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Who finished a turnover requirement.
 *
 * The admin "Promotion Turnover Report" has an APPROVED BY column that was
 * joined on `created_by_admin_id` — the admin who CREATED the requirement.
 * Two things followed from that, both wrong:
 *
 *   - a requirement still PENDING showed an admin's name, as though someone
 *     had approved something that has not happened yet;
 *   - a genuine admin force-completion of a system-created requirement showed
 *     a dash, so an override was indistinguishable from a player finishing it
 *     by wagering.
 *
 * A requirement can finish four ways, and the report needs to tell them apart:
 *
 *   PLAYER  the player wagered it off           (contributeFromSettledBet)
 *   SYSTEM  written off when the wallet emptied (completeAllIfWalletDepleted)
 *   ADMIN   force-completed, or adjusted past its target
 *   null    not finished yet, or finished before this column existed
 *
 * `completed_by_admin_id` is NOT backfilled from `created_by_admin_id`: that
 * would re-state the very error this fixes. Historic rows stay unknown, which
 * is the truth about them.
 *
 * Idempotent.
 */
export class TurnoverCompletionSource2300000000000 implements MigrationInterface {
  name = 'TurnoverCompletionSource2300000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.turnover_requirements
        ADD COLUMN IF NOT EXISTS completion_source    VARCHAR(16),
        ADD COLUMN IF NOT EXISTS completed_by_admin_id BIGINT;
    `);

    await q.query(`
      ALTER TABLE public.turnover_requirements
        DROP CONSTRAINT IF EXISTS chk_turnover_completion_source;
    `);
    await q.query(`
      ALTER TABLE public.turnover_requirements
        ADD CONSTRAINT chk_turnover_completion_source
        CHECK (completion_source IS NULL
               OR completion_source IN ('PLAYER', 'SYSTEM', 'ADMIN'));
    `);

    // An ADMIN completion must name the admin; anything else must not.
    await q.query(`
      ALTER TABLE public.turnover_requirements
        DROP CONSTRAINT IF EXISTS chk_turnover_completed_by;
    `);
    await q.query(`
      ALTER TABLE public.turnover_requirements
        ADD CONSTRAINT chk_turnover_completed_by
        CHECK ((completion_source = 'ADMIN' AND completed_by_admin_id IS NOT NULL)
               OR (completion_source IS DISTINCT FROM 'ADMIN'
                   AND completed_by_admin_id IS NULL));
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.turnover_requirements
        DROP CONSTRAINT IF EXISTS chk_turnover_completed_by,
        DROP CONSTRAINT IF EXISTS chk_turnover_completion_source;
    `);
    await q.query(`
      ALTER TABLE public.turnover_requirements
        DROP COLUMN IF EXISTS completed_by_admin_id,
        DROP COLUMN IF EXISTS completion_source;
    `);
  }
}
