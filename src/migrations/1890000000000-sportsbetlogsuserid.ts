import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Give `sports_bet_logs` a real `user_id` so sportsbook history is keyed by
 * user id like every other product (lottery → bets.user_id, slots →
 * slot_transactions.user_id) instead of by a fragile username string-join.
 *
 * The provider sanitizes '@' and '.' to '_' in usernames, so rows were matched
 * to a user purely by `user_name` — and any mismatch silently dropped the whole
 * SPORTS category from the unified game-history feed. This removes that coupling.
 *
 * Steps: add the column (nullable), add the FK (sports bettors are always
 * regular users, never admins → a real FK is safe), backfill from `user_name`
 * matching both the original and the sanitized form, then index it. Idempotent.
 */
export class SportsBetLogsUserId1890000000000 implements MigrationInterface {
  name = 'SportsBetLogsUserId1890000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Column — nullable so historical rows that can't be matched in the
    //    backfill stay NULL rather than blocking the migration.
    await queryRunner.query(`
      ALTER TABLE public.sports_bet_logs
        ADD COLUMN IF NOT EXISTS user_id INTEGER;
    `);

    // 2. FK to users(id), guarded so re-running is safe.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_sports_bet_logs_user'
        ) THEN
          ALTER TABLE public.sports_bet_logs
            ADD CONSTRAINT fk_sports_bet_logs_user
            FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
        END IF;
      END$$;
    `);

    // 3. Backfill: match the original username and the provider-sanitized form
    //    ('@' and '.' -> '_'), mirroring how the sports callback resolves users.
    await queryRunner.query(`
      UPDATE public.sports_bet_logs sb
         SET user_id = u.id
        FROM public.users u
       WHERE sb.user_id IS NULL
         AND (
           u.username = sb.user_name
           OR REPLACE(REPLACE(u.username, '@', '_'), '.', '_') = sb.user_name
         );
    `);

    // 4. Index for the per-user history lookups.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_sports_bet_logs_user_id
        ON public.sports_bet_logs (user_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_sports_bet_logs_user_id;`);
    await queryRunner.query(`
      ALTER TABLE public.sports_bet_logs
        DROP CONSTRAINT IF EXISTS fk_sports_bet_logs_user;
    `);
    await queryRunner.query(`
      ALTER TABLE public.sports_bet_logs
        DROP COLUMN IF EXISTS user_id;
    `);
  }
}
