import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Index the EXPRESSION the duplicate lookups actually compare.
 *
 * Migration 2330 indexed `transaction_number` raw, but every lookup matches
 * `upper(trim(transaction_number))` so references are compared without regard
 * to case or stray spaces. A plain index cannot serve an expression
 * predicate, so each lookup was a sequential scan: 4.1ms and 125 buffers
 * against 0.05ms on an index, measured on production.
 *
 * Used by WalletService.assertTrxNotReused and by the cross-account count on
 * the admin deposit list.
 *
 * Idempotent.
 */
export class DepositTrxExprIndex2340000000000 implements MigrationInterface {
  name = 'DepositTrxExprIndex2340000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_deposits_trx_normalised
        ON public.deposits (upper(trim(transaction_number)))
        WHERE transaction_number IS NOT NULL AND transaction_number <> '';
    `);

    // The raw-column index from 2330 is now redundant: nothing compares the
    // column without normalising it first.
    await q.query(`DROP INDEX IF EXISTS public.idx_deposits_transaction_number;`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_deposits_transaction_number
        ON public.deposits (transaction_number)
        WHERE transaction_number IS NOT NULL AND transaction_number <> '';
    `);
    await q.query(`DROP INDEX IF EXISTS public.idx_deposits_trx_normalised;`);
  }
}
