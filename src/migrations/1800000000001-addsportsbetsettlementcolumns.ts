import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Record the realized settlement of a sports bet so won/lost is a stored fact
 * (win_amount > 0) instead of being inferred from the provider's numeric status
 * code, and so payout/settlement time are exact in the unified game-history feed.
 *
 *   win_amount → amount credited by the win callback at settlement (0 for a loss)
 *   settled_at → when we processed that settlement callback
 *
 * Both are nullable: an open (unsettled) bet leaves them NULL. Idempotent so it
 * is safe even where the columns were already added out-of-band.
 */
export class AddSportsBetSettlementColumns1800000000001
  implements MigrationInterface
{
  name = 'AddSportsBetSettlementColumns1800000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.sports_bet_logs
        ADD COLUMN IF NOT EXISTS win_amount NUMERIC(15,2),
        ADD COLUMN IF NOT EXISTS settled_at TIMESTAMP WITH TIME ZONE;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.sports_bet_logs
        DROP COLUMN IF EXISTS settled_at,
        DROP COLUMN IF EXISTS win_amount;
    `);
  }
}
