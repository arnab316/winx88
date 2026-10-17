import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * user_verifications.last_submitted_at — when the player last SENT documents.
 *
 * The admin KYC queue showed and sorted by `created_at`, which is set once when
 * the record is first created and never touched again. A re-submission keeps
 * its original date, so a player who was rejected and uploaded new documents
 * does not rise to the top of the queue — the record goes back to PENDING but
 * stays buried wherever it first landed. On production 7 of 99 records have
 * been re-submitted, and two of them were sitting days down the list.
 *
 * BACKFILL — what is and is not recoverable:
 *
 *   - Never re-submitted: created_at IS the submission time. Exact.
 *   - Re-submitted and still awaiting review: the re-submit set `updated_at`
 *     and nothing has written since, so updated_at IS the re-submission time.
 *     Exact, and these are the records the queue was hiding.
 *   - Re-submitted AND already reviewed: `updated_at` was overwritten by the
 *     review, so the re-submission time is GONE. Falls back to created_at,
 *     which is what was displayed before — no worse than today, and these are
 *     closed records nobody is queueing on.
 *
 * Idempotent.
 */
export class KycLastSubmittedAt2290000000000 implements MigrationInterface {
  name = 'KycLastSubmittedAt2290000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.user_verifications
        ADD COLUMN IF NOT EXISTS last_submitted_at TIMESTAMPTZ;
    `);

    await q.query(`
      UPDATE public.user_verifications
         SET last_submitted_at = CASE
               WHEN submission_count > 1 AND reviewed_at IS NULL THEN updated_at
               ELSE created_at
             END
       WHERE last_submitted_at IS NULL;
    `);

    // Only now NOT NULL: the backfill has to run first or the ALTER fails.
    await q.query(`
      ALTER TABLE public.user_verifications
        ALTER COLUMN last_submitted_at SET DEFAULT NOW();
    `);
    await q.query(`
      ALTER TABLE public.user_verifications
        ALTER COLUMN last_submitted_at SET NOT NULL;
    `);

    // The queue sorts on this, newest first.
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_user_verifications_last_submitted
        ON public.user_verifications (last_submitted_at DESC);
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS public.idx_user_verifications_last_submitted;`);
    await q.query(`
      ALTER TABLE public.user_verifications DROP COLUMN IF EXISTS last_submitted_at;
    `);
  }
}
