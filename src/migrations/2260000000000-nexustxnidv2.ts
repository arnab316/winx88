import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Nexus seamless: deduplicate on `txn_id_v2`, not on the round id.
 *
 * WHY THIS IS NOT COSMETIC
 *
 * One bet is not one payout. A slot round can pay out over several INNER SPINS
 * — tumbling wins, free rounds, the closing collect — and Nexus sends each as
 * its own transaction. Those transactions all share `round_id`, and (until
 * 2026-10-15) `txn_id` is just the round id as a string. Only `txn_id_v2` is
 * unique per transaction.
 *
 * Migration 2130 keyed on (txn_id, txn_type) because sportsbook reuses the
 * coupon id across its bet and its settlement. That holds for sportsbook, which
 * sends exactly one `debit` and one `credit` per coupon — but it breaks the
 * moment a slot provider is enabled: the SECOND `credit` of a tumbling win
 * carries the same txn_id and the same txn_type as the first, so the old index
 * classes it as a replay and the player is never paid the rest of their win.
 *
 * THE DATED CHANGE
 *
 * Nexus is moving `txn_id` itself to the per-transaction value:
 *   - until 2026-10-15 (UTC): txn_id = round id, shared across the bet
 *   - from 2026-10-15 (UTC): txn_id = the txn_id_v2 value, unique per txn
 *   - from 2026-10-31 (UTC): txn_id_v2 is removed
 *
 * COALESCE(txn_id_v2, txn_id) is therefore correct in all three periods, and
 * needs no second migration when the field disappears.
 *
 * `txn_type` stays in the key so the index remains valid for the rows already
 * written, where the coupon id IS shared between the debit and the credit.
 * Dropping it would make this migration fail on existing sportsbook data.
 *
 * The OLD INDEX MUST GO. Leaving it in place would keep enforcing uniqueness on
 * (txn_id, txn_type) and would keep swallowing tumbling wins — the new index
 * alone does not relax the old one.
 *
 * Idempotent.
 */
export class NexusTxnIdV22260000000000 implements MigrationInterface {
  name = 'NexusTxnIdV22260000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.nexus_transactions
        ADD COLUMN IF NOT EXISTS txn_id_v2 VARCHAR(64);
    `);

    // Created BEFORE the old one is dropped: if existing rows somehow violate
    // it, this fails here and the table keeps the protection it already had.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_nexus_txn_dedup
        ON public.nexus_transactions
           (COALESCE(txn_id_v2, txn_id), lower(COALESCE(txn_type, '')));
    `);

    await q.query(`DROP INDEX IF EXISTS public.uq_nexus_txn_id_kind;`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Restore 2130's key first, so the table is never left unprotected.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_nexus_txn_id_kind
        ON public.nexus_transactions (txn_id, lower(COALESCE(txn_type, '')));
    `);
    await q.query(`DROP INDEX IF EXISTS public.uq_nexus_txn_dedup;`);
    await q.query(`
      ALTER TABLE public.nexus_transactions
        DROP COLUMN IF EXISTS txn_id_v2;
    `);
  }
}
