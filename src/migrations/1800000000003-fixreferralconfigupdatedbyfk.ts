import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * referral_config.updated_by was wrongly created with a FK to users(id), but
 * admins live in admin_users — so an admin editing config (updated_by = their
 * admin_users.id) violated the FK. Admin-id columns carry no FK by convention
 * (e.g. deposits.approved_by_admin_id), so drop it. The column stays as a plain
 * BIGINT holding the admin_users.id for audit.
 *
 * Idempotent; corrects DBs that already ran 1800000000002 with the bad FK.
 */
export class FixReferralConfigUpdatedByFk1800000000003
  implements MigrationInterface
{
  name = 'FixReferralConfigUpdatedByFk1800000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE public.referral_config DROP CONSTRAINT IF EXISTS referral_config_updated_by_fkey;`,
    );
  }

  public async down(): Promise<void> {
    // No-op: the FK was incorrect (wrong table); we don't restore it.
  }
}
