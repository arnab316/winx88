import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWalletBettingColumns1680000000003 implements MigrationInterface {
  name = 'AddWalletBettingColumns1680000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add betting tracking columns referenced by:
    //   - wallet.service.ts → getWallet()
    //   - game.service.ts   → placeBet() (total_bet) + settleRound() (total_win)
    await queryRunner.query(`
      ALTER TABLE public.wallets
        ADD COLUMN IF NOT EXISTS total_bet NUMERIC(18,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS total_win NUMERIC(18,2) NOT NULL DEFAULT 0;
    `);

    // Non-negative checks (matching the existing pattern on balance / bonus_balance)
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'wallets_total_bet_non_negative'
        ) THEN
          ALTER TABLE public.wallets
            ADD CONSTRAINT wallets_total_bet_non_negative
            CHECK (total_bet >= 0);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'wallets_total_win_non_negative'
        ) THEN
          ALTER TABLE public.wallets
            ADD CONSTRAINT wallets_total_win_non_negative
            CHECK (total_win >= 0);
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.wallets
        DROP CONSTRAINT IF EXISTS wallets_total_bet_non_negative,
        DROP CONSTRAINT IF EXISTS wallets_total_win_non_negative;
    `);
    await queryRunner.query(`
      ALTER TABLE public.wallets
        DROP COLUMN IF EXISTS total_bet,
        DROP COLUMN IF EXISTS total_win;
    `);
  }
}