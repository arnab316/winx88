import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What a turnover contribution was earned on.
 *
 * `turnover_ledger` recorded only `reference_type = 'BET'` and a
 * `reference_id`, and that id comes from whichever of the five source tables
 * produced the bet — bets, slot_transactions, oroplay_transactions,
 * sports_bet_logs, nexus_transactions. The ids collide across them, so a
 * contribution could not be traced back to its game AT ALL.
 *
 * Two visible consequences:
 *
 *   - The player's Betting Records page cannot split turnover by game type.
 *     game-history.service already probes information_schema for
 *     `bet_category` and falls back to a single "not linked to a game type"
 *     row, so every multi-category day shows ₹0 against each game and the
 *     total parked underneath. The read side needs no change once this lands.
 *
 *   - "Why did this bet not count?" could only be answered by replaying the
 *     rules by hand against five tables.
 *
 * Both halves of the answer are already computed in
 * TurnoverService.contributeFromSettledBet — the vertical from toVertical()
 * and the integration from the bet context — and were simply thrown away.
 *
 *   bet_category  LIVE | SLOT | FISH | SPORTS | CRASH | LOTTERY | ...
 *                 NULL when the provider sent a type we could not map, which
 *                 is the same "cannot tell" the matching rules use: such a
 *                 bet still counts, so it must still be recordable.
 *   bet_source    NEXUS | PALACE | OROPLAY | SPORTS | OWN — what makes
 *                 reference_id unambiguous.
 *
 * Historic rows stay NULL. They are not backfillable: the id alone cannot
 * identify which table it came from, which is the whole point of this change.
 * The read path treats NULL as unassigned, exactly as it does today.
 *
 * Idempotent.
 */
export class TurnoverLedgerBetCategory2380000000000
  implements MigrationInterface
{
  name = 'TurnoverLedgerBetCategory2380000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.turnover_ledger
        ADD COLUMN IF NOT EXISTS bet_category VARCHAR(20),
        ADD COLUMN IF NOT EXISTS bet_source   VARCHAR(20);
    `);

    // The Betting Records page groups by (user, day, category) over
    // CONTRIBUTION rows only.
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_turnover_ledger_user_cat
        ON public.turnover_ledger (user_id, created_at, bet_category)
        WHERE event_type = 'CONTRIBUTION';
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS public.idx_turnover_ledger_user_cat;`);
    await q.query(`
      ALTER TABLE public.turnover_ledger
        DROP COLUMN IF EXISTS bet_source,
        DROP COLUMN IF EXISTS bet_category;
    `);
  }
}
