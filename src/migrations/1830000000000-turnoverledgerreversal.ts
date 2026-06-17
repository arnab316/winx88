import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A cancelled/refunded bet must roll back the turnover progress it added
 * (e.g. Palace casino `cancel` callbacks). The reversal is logged in
 * turnover_ledger with a dedicated 'REVERSAL' event type, so extend the
 * event_type CHECK constraint to permit it.
 */
export class TurnoverLedgerReversal1830000000000
  implements MigrationInterface
{
  name = 'TurnoverLedgerReversal1830000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.turnover_ledger
        DROP CONSTRAINT IF EXISTS turnover_ledger_event_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.turnover_ledger
        ADD CONSTRAINT turnover_ledger_event_check
        CHECK (event_type IN
          ('CONTRIBUTION','COMPLETED','RESET','CANCELLED','ADMIN_ADJUST','REVERSAL'));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.turnover_ledger
        DROP CONSTRAINT IF EXISTS turnover_ledger_event_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.turnover_ledger
        ADD CONSTRAINT turnover_ledger_event_check
        CHECK (event_type IN
          ('CONTRIBUTION','COMPLETED','RESET','CANCELLED','ADMIN_ADJUST'));
    `);
  }
}
