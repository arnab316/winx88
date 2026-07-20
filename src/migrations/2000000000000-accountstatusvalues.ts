import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * users.account_status: add INACTIVE and LOCKED to the allowed set.
 *
 * New admin-facing set: ACTIVE | INACTIVE | SUSPENDED | LOCKED.
 * BLOCKED stays valid (legacy — existing rows/admin habits keep working);
 * every enforcement point simply checks `account_status <> 'ACTIVE'`, so any
 * non-active value blocks login / withdrawals / transfers with
 * "Account is <STATUS>" automatically.
 */
export class AccountStatusValues2000000000000 implements MigrationInterface {
  name = 'AccountStatusValues2000000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_account_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.users ADD CONSTRAINT users_account_status_check
        CHECK (account_status::text = ANY (ARRAY[
          'ACTIVE'::text, 'INACTIVE'::text, 'SUSPENDED'::text,
          'LOCKED'::text, 'BLOCKED'::text
        ]));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the original set. Fails if INACTIVE/LOCKED rows exist — reset
    // those users first.
    await queryRunner.query(`
      ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_account_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.users ADD CONSTRAINT users_account_status_check
        CHECK (account_status::text = ANY (ARRAY[
          'ACTIVE'::text, 'BLOCKED'::text, 'SUSPENDED'::text
        ]));
    `);
  }
}
