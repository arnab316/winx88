import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GAME LIBRARY INDEXES — the Continue Playing lookups on the big play-log
 * tables, built WITHOUT blocking writes.
 *
 * `slot_transactions` (3.5M+ rows in production) and `oroplay_transactions`
 * only carry a plain `user_id` index, so the per-user "most recent distinct
 * game" aggregation has to sort every row a heavy player owns. The composite
 * (user_id, created_at DESC) lets it walk the newest rows and stop.
 *
 * WHY THIS IS A SEPARATE, NON-TRANSACTIONAL MIGRATION
 * ---------------------------------------------------
 * A plain CREATE INDEX takes a lock that blocks INSERTs for the entire build.
 * On a live site that stalls every slot bet landing on the seamless-wallet
 * callback. CREATE INDEX CONCURRENTLY avoids that, but Postgres refuses to run
 * it inside a transaction block — hence `transaction = false`, which TypeORM
 * honours when `migrationsTransactionMode` is "each" (the default) or "none".
 *
 * OPERATIONAL NOTE
 * ----------------
 * A CONCURRENTLY build can fail (e.g. deadlock or a conflicting statement) and
 * leave an INVALID index behind that still costs writes but never gets used.
 * After running this, verify with:
 *
 *   SELECT i.indexrelid::regclass AS index, i.indisvalid
 *     FROM pg_index i
 *    WHERE i.indexrelid::regclass::text IN
 *          ('idx_slot_tx_user_created','idx_oroplay_tx_user_created');
 *
 * Any row with indisvalid = false should be DROPped and rebuilt.
 *
 * Idempotent — IF NOT EXISTS makes this a no-op where the indexes already
 * exist (e.g. dev, which got them from the original migration 2150).
 */
export class GameLibraryIndexes2160000000000 implements MigrationInterface {
  name = 'GameLibraryIndexes2160000000000';

  /** CREATE INDEX CONCURRENTLY cannot run inside a transaction block. */
  transaction = false;

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_tx_user_created
        ON public.slot_transactions (user_id, created_at DESC);
    `);
    await q.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_oroplay_tx_user_created
        ON public.oroplay_transactions (user_id, created_at DESC);
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX CONCURRENTLY IF EXISTS public.idx_oroplay_tx_user_created;`);
    await q.query(`DROP INDEX CONCURRENTLY IF EXISTS public.idx_slot_tx_user_created;`);
  }
}
