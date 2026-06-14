import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "Register Valid Claimable Period" — for REGISTRATION bonuses, the number of
 * days after sign-up during which the user may still claim. NULL = no limit.
 */
export class PromotionRegisterValidDays1850000000000
  implements MigrationInterface
{
  name = 'PromotionRegisterValidDays1850000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.promotions
        ADD COLUMN IF NOT EXISTS register_valid_days INTEGER;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.promotions
        DROP COLUMN IF EXISTS register_valid_days;
    `);
  }
}
