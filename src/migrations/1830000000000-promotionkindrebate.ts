import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add the REBATE promotion kind (turnover/rebate bonus tied to member/VIP
 * groups). Widens the promotions.kind check constraint to include it.
 */
export class PromotionKindRebate1830000000000 implements MigrationInterface {
  name = 'PromotionKindRebate1830000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.promotions DROP CONSTRAINT IF EXISTS promotions_kind_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.promotions ADD CONSTRAINT promotions_kind_check
        CHECK (kind::text = ANY (ARRAY[
          'DEPOSIT','REGISTRATION','PROMOCODE','MANUAL',
          'FREE_REWARD','RELOAD','CASHBACK','REBATE'
        ]::text[]));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.promotions DROP CONSTRAINT IF EXISTS promotions_kind_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.promotions ADD CONSTRAINT promotions_kind_check
        CHECK (kind::text = ANY (ARRAY[
          'DEPOSIT','REGISTRATION','PROMOCODE','MANUAL',
          'FREE_REWARD','RELOAD','CASHBACK'
        ]::text[]));
    `);
  }
}
