import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPurposeAndProviderMsgIdToUserOtps1726567891235
  implements MigrationInterface
{
  name = 'AddPurposeAndProviderMsgIdToUserOtps1726567891235';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.user_otps
      ADD COLUMN IF NOT EXISTS purpose VARCHAR(30) NOT NULL DEFAULT 'REGISTRATION';
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_user_otps_phone_purpose_id
      ON public.user_otps (phone_number, purpose, id DESC);
    `);

    await queryRunner.query(`
      ALTER TABLE public.user_otps
      ADD COLUMN IF NOT EXISTS provider_msg_id VARCHAR(64);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_user_otps_phone_purpose_id;
    `);

    await queryRunner.query(`
      ALTER TABLE public.user_otps
      DROP COLUMN IF EXISTS provider_msg_id;
    `);

    await queryRunner.query(`
      ALTER TABLE public.user_otps
      DROP COLUMN IF EXISTS purpose;
    `);
  }
}