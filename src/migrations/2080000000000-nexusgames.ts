import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * NEXUS GGR — seamless wallet aggregator (slots, live casino, sportsbook).
 *
 * "Seamless" means Nexus holds no player funds. Every bet and win is a live
 * HTTP call to POST /gold_api on our server, which moves real money in
 * `wallets` and answers with the new balance. Providers retry aggressively on
 * timeout, so the correctness of this table is what stands between a retry and
 * a player being charged twice.
 *
 * `txn_id UNIQUE` is that guarantee, and it has to be a database constraint
 * rather than a SELECT-then-INSERT: two simultaneous retries both pass the
 * SELECT, and only the unique index stops the second write. The handler is
 * written to catch 23505 and return the ALREADY-STORED balance, so a retry
 * looks identical to the original call from Nexus's side.
 *
 * `id BIGSERIAL` is load-bearing: turnoverService.reverseContribution takes
 * the bet row's id as its reference_id when a round is cancelled.
 *
 * ── casino_games.aggregator ──
 * Nexus games live in the existing casino_games table so the current game list
 * and launch endpoints keep working untouched. But the two existing sync jobs
 * clear the catalog by type before reloading:
 *
 *   DELETE FROM casino_games WHERE type NOT IN ('slots','instant')   -- OroPlay
 *   DELETE FROM casino_games WHERE type = 'slots'                    -- Palace
 *
 * Either would silently wipe every Nexus game on its next run. This column is
 * what those DELETEs are scoped against (`aggregator IS DISTINCT FROM 'NEXUS'`).
 * NULL means a pre-existing row, so nothing about the current behaviour changes.
 *
 * Idempotent.
 */
export class NexusGames2080000000000 implements MigrationInterface {
  name = 'NexusGames2080000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.nexus_transactions (
        id              BIGSERIAL PRIMARY KEY,
        txn_id          VARCHAR(64) NOT NULL UNIQUE,
        round_id        VARCHAR(64),
        user_id         BIGINT NOT NULL,
        user_code       VARCHAR(80),
        game_type       VARCHAR(10),
        provider_code   VARCHAR(40),
        game_code       VARCHAR(80),
        type            VARCHAR(40),
        txn_type        VARCHAR(20),
        bet_money       NUMERIC(18,2) NOT NULL DEFAULT 0,
        win_money       NUMERIC(18,2) NOT NULL DEFAULT 0,
        amount          NUMERIC(18,2) NOT NULL DEFAULT 0,
        balance_before  NUMERIC(18,2),
        balance_after   NUMERIC(18,2),
        is_canceled     BOOLEAN NOT NULL DEFAULT false,
        raw             JSONB,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Player history + the admin game-history feed.
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_nexus_tx_user_created
        ON public.nexus_transactions (user_id, created_at DESC);
    `);
    // Rounds are grouped for history, and looked up when a round is cancelled.
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_nexus_tx_round
        ON public.nexus_transactions (round_id);
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_nexus_tx_provider_created
        ON public.nexus_transactions (provider_code, created_at DESC);
    `);

    await q.query(`
      ALTER TABLE public.casino_games
        ADD COLUMN IF NOT EXISTS aggregator VARCHAR(20);
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_casino_games_aggregator
        ON public.casino_games (aggregator)
        WHERE aggregator IS NOT NULL;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS idx_casino_games_aggregator;`);
    await q.query(`ALTER TABLE public.casino_games DROP COLUMN IF EXISTS aggregator;`);
    await q.query(`DROP TABLE IF EXISTS public.nexus_transactions;`);
  }
}
