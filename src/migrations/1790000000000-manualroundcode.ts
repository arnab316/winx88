import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Admin-controlled, repeatable round codes.
 *
 * Model:
 *  - `games.round_code`  — the code applied to EVERY new round of this game.
 *    It is NOT unique: it repeats on each round until the admin changes it
 *    (a weekly/monthly series, e.g. 1D=wiun1, 3D=winn, 4D=win4x, 5D=winx5d).
 *    Changing it only affects FUTURE rounds; the open round keeps its code.
 *  - `games.round_mode`  — 'AUTO'  : cron spawns rounds (1D/3D).
 *                          'MANUAL': admin opens each round; never auto-closes (4D/5D).
 *
 * Also seeds the 4D and 5D games (MANUAL). Admin should set correct payout
 * multipliers / bet limits afterwards via the game settings endpoint.
 */
export class ManualRoundCode1790000000000 implements MigrationInterface {
  name = 'ManualRoundCode1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. New columns on games ──────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE public.games
        ADD COLUMN IF NOT EXISTS round_code VARCHAR(40),
        ADD COLUMN IF NOT EXISTS round_mode VARCHAR(10) NOT NULL DEFAULT 'AUTO';
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'games_round_mode_check') THEN
          ALTER TABLE public.games
            ADD CONSTRAINT games_round_mode_check
            CHECK (round_mode IN ('AUTO','MANUAL'));
        END IF;
      END $$;
    `);

    // ── 2. Round codes now repeat → drop any UNIQUE constraint/index on
    //       game_rounds.round_code so the same code can be reused.
    await queryRunner.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT conname FROM pg_constraint
          WHERE conrelid = 'public.game_rounds'::regclass
            AND contype = 'u'
            AND pg_get_constraintdef(oid) ILIKE '%round_code%'
        LOOP
          EXECUTE format('ALTER TABLE public.game_rounds DROP CONSTRAINT %I', r.conname);
        END LOOP;

        FOR r IN
          SELECT indexname FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'game_rounds'
            AND indexdef ILIKE '%unique%' AND indexdef ILIKE '%round_code%'
        LOOP
          EXECUTE format('DROP INDEX IF EXISTS public.%I', r.indexname);
        END LOOP;
      END $$;
    `);

    // ── 3. Seed the MANUAL 4D and 5D games (codes are unique on games) ──
    //       Placeholder payout/limits — admin adjusts via game settings.
    await queryRunner.query(`
      INSERT INTO public.games
        (code, name, digit_length, min_bet, max_bet, payout_multiplier,
         display_category, is_active, round_mode)
      VALUES
        ('4D', '4D Game', 4, 10, 50000, 5000,  'REGULAR', true, 'MANUAL'),
        ('5D', '5D Game', 5, 10, 50000, 50000, 'REGULAR', true, 'MANUAL')
      ON CONFLICT (code) DO NOTHING;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM public.games WHERE code IN ('4D','5D');
    `);
    await queryRunner.query(`
      ALTER TABLE public.games DROP CONSTRAINT IF EXISTS games_round_mode_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.games
        DROP COLUMN IF EXISTS round_code,
        DROP COLUMN IF EXISTS round_mode;
    `);
  }
}
