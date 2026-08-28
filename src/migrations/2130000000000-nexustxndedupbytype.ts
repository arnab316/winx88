import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Nexus seamless: dedup on (txn_id + txn_type), not txn_id alone.
 *
 * Nexus reuses the COUPON id as txn_id and distinguishes the two legs with
 * txn_type: the bet arrives as 'debit' and the settlement later as 'credit'
 * carrying the SAME txn_id. With a unique index on txn_id alone, the credit
 * hit the replay branch, we returned the pre-win balance with status 1, and
 * the player was never paid — while Nexus logged a successful settlement.
 *
 * Observed on 2026-08-28: user mahim111, txn 38792 (win 250) and 38864
 * (win 530), both swallowed. Sportsbook is the affected product; slot/live
 * send a unique txn_id per leg, which is why some credits did land.
 *
 * The index is on an EXPRESSION rather than the bare columns because a plain
 * (txn_id, txn_type) unique does not dedupe when txn_type is NULL — in
 * Postgres, NULLs are distinct, so a provider retry with no txn_type would
 * insert twice and double-pay. COALESCE+lower collapses those and also makes
 * the key case-insensitive.
 */
export class NexusTxnDedupByType2130000000000 implements MigrationInterface {
  name = 'NexusTxnDedupByType2130000000000';

  public async up(q: QueryRunner): Promise<void> {
    // Created by `txn_id VARCHAR(64) NOT NULL UNIQUE` in 2080000000000.
    await q.query(`
      ALTER TABLE public.nexus_transactions
        DROP CONSTRAINT IF EXISTS nexus_transactions_txn_id_key;
    `);
    await q.query(`DROP INDEX IF EXISTS public.nexus_transactions_txn_id_key;`);

    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_nexus_txn_id_kind
        ON public.nexus_transactions (txn_id, lower(COALESCE(txn_type, '')));
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS public.uq_nexus_txn_id_kind;`);
    // Restoring the single-column unique fails if both legs of a coupon are
    // already stored — which is the whole point of this migration. Deduplicate
    // first if you genuinely need to roll back.
    await q.query(`
      ALTER TABLE public.nexus_transactions
        ADD CONSTRAINT nexus_transactions_txn_id_key UNIQUE (txn_id);
    `);
  }
}
