import type { MigrationInterface, QueryRunner } from 'typeorm';

export class GameEnhancements1680000000006 implements MigrationInterface {
  name = 'GameEnhancements1680000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ═══════════════════════════════════════════════════════════
    // EXTEND games TABLE
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      ALTER TABLE public.games
        ADD COLUMN IF NOT EXISTS is_hot               BOOLEAN       NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS is_jackpot_badge     BOOLEAN       NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS display_category     VARCHAR(30)   NOT NULL DEFAULT 'REGULAR',
        ADD COLUMN IF NOT EXISTS max_payout_per_round NUMERIC(18,2),
        ADD COLUMN IF NOT EXISTS hot_priority         INTEGER       NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS description          TEXT,
        ADD COLUMN IF NOT EXISTS thumbnail_url        TEXT;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'games_display_category_check') THEN
          ALTER TABLE public.games
            ADD CONSTRAINT games_display_category_check
            CHECK (display_category IN ('REGULAR','JACKPOT','INSTANT','CUSTOM'));
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'games_max_payout_check') THEN
          ALTER TABLE public.games
            ADD CONSTRAINT games_max_payout_check
            CHECK (max_payout_per_round IS NULL OR max_payout_per_round > 0);
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_games_hot
        ON public.games(is_hot, hot_priority DESC) WHERE is_hot = TRUE;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_games_category
        ON public.games(display_category, is_active);
    `);

    // ═══════════════════════════════════════════════════════════
    // EXTEND game_hot_numbers TABLE
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      ALTER TABLE public.game_hot_numbers
        ADD COLUMN IF NOT EXISTS priority            INTEGER      NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS note                VARCHAR(200),
        ADD COLUMN IF NOT EXISTS created_by_admin_id BIGINT,
        ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW();
    `);

    // is_active should be NOT NULL with default
    await queryRunner.query(`
      ALTER TABLE public.game_hot_numbers
        ALTER COLUMN is_active SET DEFAULT TRUE;
    `);
    await queryRunner.query(`
      UPDATE public.game_hot_numbers SET is_active = TRUE WHERE is_active IS NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE public.game_hot_numbers
        ALTER COLUMN is_active SET NOT NULL;
    `);

    // Prevent duplicate (game_id, number) pairs
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_hot_numbers_unique') THEN
          ALTER TABLE public.game_hot_numbers
            ADD CONSTRAINT game_hot_numbers_unique UNIQUE (game_id, number);
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_hot_numbers_game_active
        ON public.game_hot_numbers(game_id, is_active, priority DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.game_hot_numbers
        DROP CONSTRAINT IF EXISTS game_hot_numbers_unique;
    `);
    await queryRunner.query(`
      ALTER TABLE public.game_hot_numbers
        DROP COLUMN IF EXISTS priority,
        DROP COLUMN IF EXISTS note,
        DROP COLUMN IF EXISTS created_by_admin_id,
        DROP COLUMN IF EXISTS updated_at;
    `);

    await queryRunner.query(`
      ALTER TABLE public.games
        DROP CONSTRAINT IF EXISTS games_display_category_check,
        DROP CONSTRAINT IF EXISTS games_max_payout_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.games
        DROP COLUMN IF EXISTS is_hot,
        DROP COLUMN IF EXISTS is_jackpot_badge,
        DROP COLUMN IF EXISTS display_category,
        DROP COLUMN IF EXISTS max_payout_per_round,
        DROP COLUMN IF EXISTS hot_priority,
        DROP COLUMN IF EXISTS description,
        DROP COLUMN IF EXISTS thumbnail_url;
    `);
  }
}