import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Allow 'QR' in agents.wallet_type.
 *
 * The column carries a CHECK constraint written before QR destinations existed
 * (bKash / Nagad / Rocket / Bank / Crypto), so creating a QR agent fails with
 * 23514 agents_wallet_type_check even though the DTO accepts it.
 *
 * The new constraint is built from the UNION of the values already present in
 * the table and the known set plus 'QR', rather than a hard-coded list. A
 * hard-coded list silently invalidates any value some environment picked up
 * that this file does not know about (an 'Upay' agent, say) — and because a
 * CHECK is only enforced on write, that damage surfaces later as an
 * unrelated-looking failure when someone edits an old row.
 */
export class AgentWalletTypeQr2110000000000 implements MigrationInterface {
  name = 'AgentWalletTypeQr2110000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      DECLARE allowed text;
      BEGIN
        SELECT string_agg(v, ',') INTO allowed FROM (
          SELECT DISTINCT quote_literal(wallet_type) AS v
            FROM public.agents
           WHERE wallet_type IS NOT NULL
          UNION
          SELECT quote_literal(x)
            FROM unnest(ARRAY['bKash','Nagad','Rocket','Bank','Crypto','QR']) AS x
        ) s;

        EXECUTE 'ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_wallet_type_check';
        EXECUTE format(
          'ALTER TABLE public.agents ADD CONSTRAINT agents_wallet_type_check CHECK (wallet_type IN (%s))',
          allowed
        );
      END $$;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Restores the pre-QR set. Fails if QR agents still exist — delete or
    // convert them first, which is the safe order anyway.
    await q.query(`ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_wallet_type_check;`);
    await q.query(`
      ALTER TABLE public.agents
        ADD CONSTRAINT agents_wallet_type_check
        CHECK (wallet_type IN ('bKash','Nagad','Rocket','Bank','Crypto'));
    `);
  }
}
