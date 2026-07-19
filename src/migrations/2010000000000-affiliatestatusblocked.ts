import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * affiliate_users.status: add BLOCKED to the allowed set so the affiliate
 * "Change Status" modal (ACTIVE | INACTIVE | SUSPENDED | LOCKED | BLOCKED)
 * works for every option. Any non-ACTIVE value already forces is_active = FALSE
 * in updateStatus(), pausing weekly commission processing for that affiliate.
 */
export class AffiliateStatusBlocked2010000000000 implements MigrationInterface {
  name = 'AffiliateStatusBlocked2010000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.affiliate_users DROP CONSTRAINT IF EXISTS affiliate_users_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.affiliate_users ADD CONSTRAINT affiliate_users_status_check
        CHECK (status::text = ANY (ARRAY[
          'ACTIVE'::text, 'INACTIVE'::text, 'SUSPENDED'::text,
          'LOCKED'::text, 'BLOCKED'::text
        ]));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore original set (fails if BLOCKED rows exist — reset those first).
    await queryRunner.query(`
      ALTER TABLE public.affiliate_users DROP CONSTRAINT IF EXISTS affiliate_users_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.affiliate_users ADD CONSTRAINT affiliate_users_status_check
        CHECK (status::text = ANY (ARRAY[
          'ACTIVE'::text, 'INACTIVE'::text, 'SUSPENDED'::text, 'LOCKED'::text
        ]));
    `);
  }
}
