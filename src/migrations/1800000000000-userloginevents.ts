import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Device-fingerprint / IP tracking for fraud detection (Compliance Check).
 *
 * Records one row per REGISTER and LOGIN, capturing the IP and the
 * device fingerprint (sent by the client as the `x-device-fingerprint`
 * header). The admin Compliance panel groups accounts that share a
 * device fingerprint, IP, or password hash to surface linked/duplicate
 * accounts.
 */
export class UserLoginEvents1800000000000 implements MigrationInterface {
  name = 'UserLoginEvents1800000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.user_login_events (
        id                 BIGSERIAL    PRIMARY KEY,
        user_id            BIGINT       NOT NULL,
        event_type         VARCHAR(20)  NOT NULL DEFAULT 'LOGIN',  -- REGISTER | LOGIN
        ip_address         VARCHAR(64),
        device_fingerprint VARCHAR(128),
        created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ule_user
        ON public.user_login_events (user_id);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ule_ip
        ON public.user_login_events (ip_address) WHERE ip_address IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ule_fingerprint
        ON public.user_login_events (device_fingerprint) WHERE device_fingerprint IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.user_login_events;`);
  }
}
