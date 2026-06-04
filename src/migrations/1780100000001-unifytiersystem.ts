import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Unifies the tier model per build-guide §3 / §8.
 *
 * The codebase already keys loyalty off users.vip_level + vip_level_config
 * (one tier per player). Rather than rip that out and risk the working
 * promotion engine, this migration promotes vip_level_config into the single
 * canonical "tier" entity by adding the banking-side fields the Member Group
 * screen edits, plus tier metadata (invitation_only, ui_color, sequence,
 * is_default, cached_player_count) and a tier_banks child table.
 *
 * It also seeds the eight canonical tiers (Normal … Mythic) when absent.
 */
export class UnifyTierSystem1780100000001 implements MigrationInterface {
  name = 'UnifyTierSystem1780100000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Extend vip_level_config with tier metadata + banking limits ──
    await queryRunner.query(`
      ALTER TABLE public.vip_level_config
        ADD COLUMN IF NOT EXISTS invitation_only        BOOLEAN       NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS ui_color               VARCHAR(20),
        ADD COLUMN IF NOT EXISTS sequence               INTEGER       NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS is_default             BOOLEAN       NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS status                 VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE',
        ADD COLUMN IF NOT EXISTS cached_player_count    BIGINT        NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS currency               VARCHAR(10)   NOT NULL DEFAULT 'BDT',
        ADD COLUMN IF NOT EXISTS deposit_min            NUMERIC(18,2),
        ADD COLUMN IF NOT EXISTS deposit_max            NUMERIC(18,2),
        ADD COLUMN IF NOT EXISTS balance_below          NUMERIC(18,2),
        ADD COLUMN IF NOT EXISTS withdrawal_min         NUMERIC(18,2),
        ADD COLUMN IF NOT EXISTS withdrawal_max         NUMERIC(18,2),
        ADD COLUMN IF NOT EXISTS withdrawal_daily_count INTEGER,
        ADD COLUMN IF NOT EXISTS withdrawal_daily_max   NUMERIC(18,2),
        ADD COLUMN IF NOT EXISTS withdrawal_turnover    NUMERIC(6,2),
        ADD COLUMN IF NOT EXISTS allow_clear_balance    BOOLEAN       NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS auto_clear_turnover    BOOLEAN       NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS internal_remark        TEXT;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vip_level_config_status_check') THEN
          ALTER TABLE public.vip_level_config
            ADD CONSTRAINT vip_level_config_status_check
            CHECK (status IN ('ACTIVE','INACTIVE'));
        END IF;
      END $$;
    `);

    // Exactly one default tier (the fallback for new players)
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_tier_default
        ON public.vip_level_config (is_default) WHERE is_default = TRUE;
    `);

    // ── tier_banks: which payment channels a tier may use ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.tier_banks (
        id        BIGSERIAL PRIMARY KEY,
        level     SMALLINT     NOT NULL,
        channel   VARCHAR(30)  NOT NULL,
        enabled   BOOLEAN      NOT NULL DEFAULT TRUE,
        CONSTRAINT tier_banks_level_fk FOREIGN KEY (level)
          REFERENCES public.vip_level_config(level) ON DELETE CASCADE,
        CONSTRAINT tier_banks_unique UNIQUE (level, channel)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tier_banks_level ON public.tier_banks(level);
    `);

    // ── Seed the eight canonical tiers (only when absent) ──
    //   points thresholds from build-guide §4.2; top three invitation-only.
    await queryRunner.query(`
      INSERT INTO public.vip_level_config
        (level, level_name, group_name, coins_required, invitation_only, sequence, is_default, ui_color)
      SELECT * FROM (VALUES
        (0::smallint, 'Normal',      'Normal',      0::numeric,           FALSE, 0, TRUE,  '#9CA3AF'),
        (1::smallint, 'Elite',       'Elite',       80000::numeric,       FALSE, 1, FALSE, '#60A5FA'),
        (2::smallint, 'Pro',         'Pro',         400000::numeric,      FALSE, 2, FALSE, '#34D399'),
        (3::smallint, 'Expert',      'Expert',      2400000::numeric,     FALSE, 3, FALSE, '#FBBF24'),
        (4::smallint, 'Master',      'Master',      24000000::numeric,    FALSE, 4, FALSE, '#F472B6'),
        (5::smallint, 'Grandmaster', 'Grandmaster', 999999999999::numeric, TRUE, 5, FALSE, '#A78BFA'),
        (6::smallint, 'Legend',      'Legend',      999999999999::numeric, TRUE, 6, FALSE, '#F87171'),
        (7::smallint, 'Mythic',      'Mythic',      999999999999::numeric, TRUE, 7, FALSE, '#FACC15')
      ) AS v(level, level_name, group_name, coins_required, invitation_only, sequence, is_default, ui_color)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.vip_level_config c WHERE c.level = v.level
      );
    `);

    // Ensure the invitation flag is correct for the top three on pre-existing installs
    await queryRunner.query(`
      UPDATE public.vip_level_config SET invitation_only = TRUE WHERE level IN (5,6,7);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.tier_banks;`);
    await queryRunner.query(`DROP INDEX IF EXISTS public.uniq_tier_default;`);
    await queryRunner.query(`
      ALTER TABLE public.vip_level_config
        DROP CONSTRAINT IF EXISTS vip_level_config_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE public.vip_level_config
        DROP COLUMN IF EXISTS invitation_only,
        DROP COLUMN IF EXISTS ui_color,
        DROP COLUMN IF EXISTS sequence,
        DROP COLUMN IF EXISTS is_default,
        DROP COLUMN IF EXISTS status,
        DROP COLUMN IF EXISTS cached_player_count,
        DROP COLUMN IF EXISTS currency,
        DROP COLUMN IF EXISTS deposit_min,
        DROP COLUMN IF EXISTS deposit_max,
        DROP COLUMN IF EXISTS balance_below,
        DROP COLUMN IF EXISTS withdrawal_min,
        DROP COLUMN IF EXISTS withdrawal_max,
        DROP COLUMN IF EXISTS withdrawal_daily_count,
        DROP COLUMN IF EXISTS withdrawal_daily_max,
        DROP COLUMN IF EXISTS withdrawal_turnover,
        DROP COLUMN IF EXISTS allow_clear_balance,
        DROP COLUMN IF EXISTS auto_clear_turnover,
        DROP COLUMN IF EXISTS internal_remark;
    `);
  }
}
