import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Auto-reject of stale PENDING deposits (manual/agent deposits only).
 *
 * A cron watcher (DepositExpiryService) rejects any manual deposit that has
 * been sitting PENDING for longer than DEPOSIT_AUTO_REJECT_MINUTES. Those
 * rejections must stay distinguishable from a real admin rejection:
 *
 *   auto_rejected        true  = rejected by the timer, not by a person.
 *                        Only these can be reopened by an admin — a genuine
 *                        admin rejection stays final.
 *   reopened_at/_by      set when an admin puts an auto-rejected deposit back
 *                        into the PENDING queue. Also acts as the watcher's
 *                        "hands off" marker: requested_at is left untouched
 *                        (reports keep the true request time), so without this
 *                        flag the next tick would immediately re-expire it.
 *
 * The partial index keeps the once-a-minute pending scan off a seq scan as the
 * deposits table grows — it only covers the handful of live PENDING rows.
 */
export class DepositAutoReject2040000000000 implements MigrationInterface {
  name = 'DepositAutoReject2040000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.deposits
        ADD COLUMN IF NOT EXISTS auto_rejected        BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS reopened_at          TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS reopened_by_admin_id INTEGER;
    `);

    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_deposits_pending_requested
        ON public.deposits (requested_at)
        WHERE status = 'PENDING';
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS idx_deposits_pending_requested;`);
    await q.query(`
      ALTER TABLE public.deposits
        DROP COLUMN IF EXISTS auto_rejected,
        DROP COLUMN IF EXISTS reopened_at,
        DROP COLUMN IF EXISTS reopened_by_admin_id;
    `);
  }
}
