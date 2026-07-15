import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Manual-deposit upgrade: deposits.player_number stores the player's cashout
 * (sender) wallet number as typed on the admin "Manual deposit" form.
 *
 * Nullable — player-submitted deposits don't capture it (the deposit lists
 * fall back to the user's primary phone number for display).
 */
export class ManualDepositPlayerNumber1980000000000 implements MigrationInterface {
  name = 'ManualDepositPlayerNumber1980000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.deposits
        ADD COLUMN IF NOT EXISTS player_number VARCHAR(30);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.deposits DROP COLUMN IF EXISTS player_number;
    `);
  }
}
