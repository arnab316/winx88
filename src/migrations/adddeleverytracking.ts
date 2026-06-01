import type { MigrationInterface, QueryRunner } from 'typeorm';

export class UserOtpsV21726567891236 implements MigrationInterface {
  name = 'UserOtpsV21726567891236';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // v1 columns
    await queryRunner.query(`
      ALTER TABLE public.user_otps
      ADD COLUMN IF NOT EXISTS purpose VARCHAR(30) NOT NULL DEFAULT 'REGISTRATION';
    `);

    await queryRunner.query(`
      ALTER TABLE public.user_otps
      ADD COLUMN IF NOT EXISTS provider_msg_id VARCHAR(64);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_user_otps_phone_purpose_id
      ON public.user_otps (phone_number, purpose, id DESC);
    `);

    // v2 delivery tracking columns
    await queryRunner.query(`
      ALTER TABLE public.user_otps
      ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(20),
      ADD COLUMN IF NOT EXISTS delivery_reason TEXT,
      ADD COLUMN IF NOT EXISTS delivery_mcc VARCHAR(8),
      ADD COLUMN IF NOT EXISTS delivery_reported_at TIMESTAMP WITHOUT TIME ZONE;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_user_otps_provider_msg_id
      ON public.user_otps (provider_msg_id)
      WHERE provider_msg_id IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_user_otps_provider_msg_id;
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_user_otps_phone_purpose_id;
    `);

    await queryRunner.query(`
      ALTER TABLE public.user_otps
      DROP COLUMN IF EXISTS delivery_reported_at,
      DROP COLUMN IF EXISTS delivery_mcc,
      DROP COLUMN IF EXISTS delivery_reason,
      DROP COLUMN IF EXISTS delivery_status,
      DROP COLUMN IF EXISTS provider_msg_id,
      DROP COLUMN IF EXISTS purpose;
    `);
  }
}