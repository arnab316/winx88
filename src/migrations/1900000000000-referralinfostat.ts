import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Create the `referral_info_stat` table used by the admin CRUD
 * (/admin/referral-info-stat) — an admin-editable record of headline referral
 * figures (number of people + amount) shown on the referral page.
 *
 * The table was originally created by hand on prod, so this is idempotent
 * (CREATE TABLE IF NOT EXISTS): a no-op where it already exists, and it
 * provisions the table on every other environment (localhost, fresh deploys).
 */
export class ReferralInfoStat1900000000000 implements MigrationInterface {
  name = 'ReferralInfoStat1900000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.referral_info_stat (
        id            SERIAL PRIMARY KEY,
        no_of_people  INTEGER       NOT NULL,
        amount        NUMERIC(15,2) NOT NULL,
        created_at    TIMESTAMPTZ   DEFAULT NOW(),
        updated_at    TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.referral_info_stat;`);
  }
}
