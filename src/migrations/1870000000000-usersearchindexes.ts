import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Search performance indexes for the admin "search users" panel
 * (UserService.searchUser).
 *
 * The search does contains-matching with ILIKE '%term%' across
 * full_name / username / email / user_code and phone_number. A plain
 * B-tree index can't serve a leading-wildcard ILIKE, so without these
 * the query falls back to a sequential scan. pg_trgm + GIN trigram
 * indexes make ILIKE '%term%' index-backed (for terms of 3+ chars;
 * 1-2 char terms still scan, which is fine for an admin tool).
 *
 * We also add a B-tree index on user_phone_numbers(user_id): Postgres
 * does NOT auto-index foreign-key columns, and searchUser correlates on
 * upn.user_id in its EXISTS / phone subqueries.
 *
 * NOTE: these run inside the migration transaction (the runner uses
 * `--transaction all`). On a very large, write-heavy users table the
 * GIN build briefly locks writes. If that becomes a problem, switch the
 * CREATE INDEX statements to `CREATE INDEX CONCURRENTLY`, set
 * `transaction = false` on this migration, and run migrations with
 * `--transaction each` (CONCURRENTLY cannot run inside a transaction).
 */
export class UserSearchIndexes1870000000000 implements MigrationInterface {
  name = 'UserSearchIndexes1870000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

    // Trigram GIN indexes for ILIKE '%term%' on the users table
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_users_full_name_trgm
        ON public.users USING gin (full_name gin_trgm_ops);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_users_username_trgm
        ON public.users USING gin (username gin_trgm_ops);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email_trgm
        ON public.users USING gin (email gin_trgm_ops);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_users_user_code_trgm
        ON public.users USING gin (user_code gin_trgm_ops);
    `);

    // Trigram GIN index for phone contains-search
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_uphone_number_trgm
        ON public.user_phone_numbers USING gin (phone_number gin_trgm_ops);
    `);

    // FK column index used by the EXISTS / phone subqueries in searchUser
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_uphone_user_id
        ON public.user_phone_numbers (user_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_uphone_user_id;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_uphone_number_trgm;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_users_user_code_trgm;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_users_email_trgm;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_users_username_trgm;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_users_full_name_trgm;`);
    // pg_trgm extension is left in place (may be used by other indexes).
  }
}
