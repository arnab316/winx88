import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddKycVerifiedToUsers1780063052236 implements MigrationInterface {
  name = "AddKycVerifiedToUsers1780063052236";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Add is_kyc_verified column to users ─────────────────
    await queryRunner.query(`
      ALTER TABLE public.users
        ADD COLUMN IF NOT EXISTS is_kyc_verified BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_users_kyc_verified
        ON public.users(is_kyc_verified);
    `);

    // ── 2. Back-fill: mark anyone already APPROVED ─────────────
    await queryRunner.query(`
      UPDATE public.users u
      SET is_kyc_verified = TRUE
      FROM public.user_verifications uv
      WHERE uv.user_id = u.id
        AND uv.status = 'APPROVED';
    `);

    // ── 3. Trigger: auto-sync users.is_kyc_verified whenever
    //       user_verifications.status changes
    //       APPROVED   → TRUE
    //       anything else (REJECTED / PENDING / UNDER_REVIEW) → FALSE
    // ───────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.sync_kyc_verified()
      RETURNS TRIGGER AS $$
      BEGIN
        UPDATE public.users
        SET is_kyc_verified = (NEW.status = 'APPROVED')
        WHERE id = NEW.user_id;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_sync_kyc_verified
        ON public.user_verifications;

      CREATE TRIGGER trg_sync_kyc_verified
        AFTER INSERT OR UPDATE OF status
        ON public.user_verifications
        FOR EACH ROW
        EXECUTE FUNCTION public.sync_kyc_verified();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_sync_kyc_verified
        ON public.user_verifications;
    `);

    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.sync_kyc_verified();
    `);

    await queryRunner.query(`
      ALTER TABLE public.users
        DROP COLUMN IF EXISTS is_kyc_verified;
    `);
  }
}