import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * KYC ADMIN OVERRIDE — let an admin set a member's KYC status directly, even
 * when the member never uploaded any documents.
 *
 * `user_verifications` was designed around a genuine player submission, so the
 * document columns are NOT NULL. But an admin forcing a status (e.g. approving
 * a trusted VIP, or rejecting a flagged account) has no documents to record.
 * This relaxes those five columns to NULLABLE so an override row is a real,
 * honest record — status + reviewing admin, with NULL documents that plainly
 * signal "no upload, admin-set" rather than fabricated document values.
 *
 * Nothing else changes: the submission endpoint still supplies all document
 * fields (it validates them before insert), and the status CHECK already allows
 * PENDING / UNDER_REVIEW / APPROVED / REJECTED, which is exactly the set the
 * admin control offers.
 *
 * Idempotent.
 */
export class KycAdminOverride2090000000000 implements MigrationInterface {
  name = 'KycAdminOverride2090000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.user_verifications
        ALTER COLUMN document_type    DROP NOT NULL,
        ALTER COLUMN document_number  DROP NOT NULL,
        ALTER COLUMN front_image_url  DROP NOT NULL,
        ALTER COLUMN back_image_url   DROP NOT NULL,
        ALTER COLUMN selfie_image_url DROP NOT NULL;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Backfill any admin-override rows (NULL documents) to empty strings first,
    // otherwise re-imposing NOT NULL would fail on exactly the rows this
    // migration made possible.
    await q.query(`
      UPDATE public.user_verifications
         SET document_type    = COALESCE(document_type,    ''),
             document_number  = COALESCE(document_number,  ''),
             front_image_url  = COALESCE(front_image_url,  ''),
             back_image_url   = COALESCE(back_image_url,   ''),
             selfie_image_url = COALESCE(selfie_image_url, '')
       WHERE document_type IS NULL OR document_number IS NULL
          OR front_image_url IS NULL OR back_image_url IS NULL
          OR selfie_image_url IS NULL;
    `);
    await q.query(`
      ALTER TABLE public.user_verifications
        ALTER COLUMN document_type    SET NOT NULL,
        ALTER COLUMN document_number  SET NOT NULL,
        ALTER COLUMN front_image_url  SET NOT NULL,
        ALTER COLUMN back_image_url   SET NOT NULL,
        ALTER COLUMN selfie_image_url SET NOT NULL;
    `);
  }
}
