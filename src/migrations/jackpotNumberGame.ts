import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends the jackpot system to support 6D and 7D number betting games.
 *
 * Changes:
 *  1. Drop+recreate games_digit_length_check to allow digit_length IN (1,3,4,5,6,7)
 *  2. Add expires_at index on game_hot_numbers (already has the column)
 *  3. Seed the two permanent jackpot game rows (6D_JACKPOT, 7D_JACKPOT) if absent
 */
export class JackpotNumberGame1780000000001 implements MigrationInterface {
  name = 'JackpotNumberGame1780000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Relax digit_length constraint to allow 6 and 7 ──────────────
    await queryRunner.query(`
      ALTER TABLE public.games
        DROP CONSTRAINT IF EXISTS games_digit_length_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.games
        ADD CONSTRAINT games_digit_length_check
        CHECK (digit_length = ANY (ARRAY[1, 3, 4, 5, 6, 7]));
    `);

    // ── 2. Index on game_hot_numbers.expires_at (used for cleanup queries) ─
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ghn_expires_at
        ON public.game_hot_numbers(expires_at)
        WHERE expires_at IS NOT NULL;
    `);

    // ── 3. Seed permanent jackpot game rows ─────────────────────────────
    //    These games are shared across all jackpot sessions of the same type.
    //    payout_multiplier defaults: 90× for 6D, 700× for 7D (admin can adjust).
    await queryRunner.query(`
      INSERT INTO public.games
        (code, name, digit_length, min_bet, max_bet, payout_multiplier,
         display_category, is_active, result_mode)
      VALUES
        ('6D_JACKPOT', '6D Jackpot', 6, 10, 50000, 90,  'JACKPOT', true, 'MANUAL'),
        ('7D_JACKPOT', '7D Jackpot', 7, 10, 50000, 700, 'JACKPOT', true, 'MANUAL')
      ON CONFLICT (code) DO NOTHING;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM public.games WHERE code IN ('6D_JACKPOT','7D_JACKPOT');`);

    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_ghn_expires_at;`);

    await queryRunner.query(`
      ALTER TABLE public.games
        DROP CONSTRAINT IF EXISTS games_digit_length_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.games
        ADD CONSTRAINT games_digit_length_check
        CHECK (digit_length = ANY (ARRAY[1, 3, 4, 5]));
    `);
  }
}
