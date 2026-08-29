import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Allow zero-target turnover requirements.
 *
 * The original CHECK assumed every requirement imposes an obligation:
 *
 *   base_amount > 0 AND target_amount >= base_amount
 *   AND current_amount >= 0 AND multiplier > 0
 *
 * A manual adjustment granted with turnoverMultiplier = 0 is a RECORD, not an
 * obligation — it exists so a no-wagering credit is still visible on the
 * wagering and admin turnover pages instead of vanishing, which made a 0x
 * adjustment indistinguishable from one that was never granted.
 *
 * The replacement keeps the original invariant intact for real requirements
 * and carves out exactly the zero case: a 0 multiplier must pair with a 0
 * target, so this cannot be used to smuggle in a requirement that is somehow
 * both waived and outstanding.
 *
 * The new predicate is a strict superset of the old one, so every existing row
 * already satisfies it and the ALTER validates without a table rewrite.
 */
export class TurnoverZeroMultiplier2140000000000 implements MigrationInterface {
  name = 'TurnoverZeroMultiplier2140000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.turnover_requirements
        DROP CONSTRAINT IF EXISTS turnover_req_amounts_check;
    `);
    await q.query(`
      ALTER TABLE public.turnover_requirements
        ADD CONSTRAINT turnover_req_amounts_check
        CHECK (
          base_amount > 0
          AND current_amount >= 0
          AND (
            (multiplier > 0 AND target_amount >= base_amount)
            OR
            (multiplier = 0 AND target_amount = 0)
          )
        );
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Restores the stricter rule. Fails if any zero-multiplier record exists —
    // delete those first if you genuinely need to roll back.
    await q.query(`
      ALTER TABLE public.turnover_requirements
        DROP CONSTRAINT IF EXISTS turnover_req_amounts_check;
    `);
    await q.query(`
      ALTER TABLE public.turnover_requirements
        ADD CONSTRAINT turnover_req_amounts_check
        CHECK (base_amount > 0 AND target_amount >= base_amount
               AND current_amount >= 0 AND multiplier > 0);
    `);
  }
}
