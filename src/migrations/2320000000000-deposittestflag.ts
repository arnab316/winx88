import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Test deposits.
 *
 * An admin can tick "Test deposit" when approving, or mark an approved one
 * afterwards. The deposit still credits the player's wallet — the point is to
 * exercise the real flow — but it is left out of everything that measures or
 * pays on real money: the dashboard, reports, marketing-channel stats,
 * affiliate commission and the refer-a-friend deposit minimum. Approving a
 * test deposit also skips VIP coins, refer-a-friend progress and the Meta
 * conversion.
 *
 *   is_test               the flag
 *   test_marked_by_admin  who set or last changed it (admin_users.id, NO FK —
 *                         admins live in their own table)
 *   test_marked_at        when
 *
 * Idempotent, and safe on a live table: the column defaults to false, so every
 * existing deposit stays a real one.
 */
export class DepositTestFlag2320000000000 implements MigrationInterface {
  name = 'DepositTestFlag2320000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.deposits
        ADD COLUMN IF NOT EXISTS is_test              BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS test_marked_by_admin INTEGER,
        ADD COLUMN IF NOT EXISTS test_marked_at       TIMESTAMPTZ;
    `);

    // Test deposits are rare, so a partial index keeps "show me the test ones"
    // cheap without carrying every real deposit.
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_deposits_is_test
        ON public.deposits (decided_at) WHERE is_test = true;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS public.idx_deposits_is_test;`);
    await q.query(`
      ALTER TABLE public.deposits
        DROP COLUMN IF EXISTS test_marked_at,
        DROP COLUMN IF EXISTS test_marked_by_admin,
        DROP COLUMN IF EXISTS is_test;
    `);
  }
}
