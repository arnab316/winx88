import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Support for the duplicate-deposit guards.
 *
 * Two new lookups run on every manual deposit request and on every admin
 * deposit list page:
 *
 *   1. "has this player already submitted this transaction number?" — the
 *      guard that refuses a second request for the same payment
 *   2. "has anyone ELSE submitted it?" — the cross-account flag the approving
 *      admin sees, which is allowed through rather than blocked
 *
 * Both key on transaction_number, which had no index at all, so each was a
 * sequential scan of the whole deposits table.
 *
 * Deliberately NOT unique. 695 duplicate groups already exist in production,
 * so a unique index could not be created without destroying history, and
 * cross-player reuse is a flag here rather than an error. The service layer
 * enforces the rule; this only makes it cheap.
 *
 * Idempotent.
 */
export class DepositDuplicateGuard2330000000000 implements MigrationInterface {
  name = 'DepositDuplicateGuard2330000000000';

  public async up(q: QueryRunner): Promise<void> {
    // Partial: provider deposits (WinyPay) store '' and are never compared.
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_deposits_transaction_number
        ON public.deposits (transaction_number)
        WHERE transaction_number IS NOT NULL AND transaction_number <> '';
    `);

    // The pending-deposit guard asks "does this player have one open?" on
    // every deposit request and every pre-flight validation.
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_deposits_user_pending
        ON public.deposits (user_id)
        WHERE status = 'PENDING';
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS public.idx_deposits_user_pending;`);
    await q.query(`DROP INDEX IF EXISTS public.idx_deposits_transaction_number;`);
  }
}
