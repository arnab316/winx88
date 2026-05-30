import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateUserVerifications1780044920438 implements MigrationInterface {
  name = "CreateUserVerifications1780044920438";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ═══════════════════════════════════════════════════════════
    // user_verifications
    //   One row per user (UNIQUE on user_id).
    //   Tracks KYC document submission + S3 image URLs + status.
    //   On re-submission after REJECTED: UPDATE the same row,
    //   increment submission_count, reset status → PENDING.
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.user_verifications (
        id                      BIGSERIAL PRIMARY KEY,
        user_id                 BIGINT          NOT NULL,
        document_type           VARCHAR(30)     NOT NULL,
        document_number         VARCHAR(100)    NOT NULL,
        expiry_date             DATE            NOT NULL,
        front_image_url         TEXT            NOT NULL,
        back_image_url          TEXT            NOT NULL,
        selfie_image_url        TEXT            NOT NULL,
        status                  VARCHAR(20)     NOT NULL DEFAULT 'PENDING',
        rejection_reason        TEXT,
        reviewed_by_admin_id    BIGINT,
        reviewed_at             TIMESTAMPTZ,
        submission_count        INT             NOT NULL DEFAULT 1,
        created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

        CONSTRAINT uq_user_verifications_user_id
          UNIQUE (user_id),

        CONSTRAINT ck_user_verifications_document_type
          CHECK (document_type IN ('IDENTITY_CARD', 'PASSPORT', 'DRIVERS_LICENSE')),

        CONSTRAINT ck_user_verifications_status
          CHECK (status IN ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED')),

        CONSTRAINT ck_user_verifications_submission_count
          CHECK (submission_count >= 1),

        CONSTRAINT fk_user_verifications_user_id
          FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,

        CONSTRAINT fk_user_verifications_admin_id
          FOREIGN KEY (reviewed_by_admin_id) REFERENCES public.admin_users(id) ON DELETE SET NULL
      );
    `);

    // Fast lookup for admin list filtered by status
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_user_verifications_status
        ON public.user_verifications(status);
    `);

    // Fast lookup per user (already UNIQUE but helps query planner)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_user_verifications_user_id
        ON public.user_verifications(user_id);
    `);

    // Auto-update updated_at on every row change
    // (reuses set_updated_at() if already created by another migration,
    //  otherwise creates it — same pattern as the rest of the project)
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_user_verifications_updated_at
        ON public.user_verifications;

      CREATE TRIGGER trg_user_verifications_updated_at
        BEFORE UPDATE ON public.user_verifications
        FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_user_verifications_updated_at
        ON public.user_verifications;
    `);

    await queryRunner.query(`
      DROP TABLE IF EXISTS public.user_verifications CASCADE;
    `);
  }
}