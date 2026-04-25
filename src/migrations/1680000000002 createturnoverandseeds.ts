import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateTurnoverAndSeeds1680000000002 implements MigrationInterface {
  name = 'CreateTurnoverAndSeeds1680000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ═══════════════════════════════════════════════════════════
    // TURNOVER REQUIREMENTS
    //   One row per "turnover challenge" the user has to complete.
    //   Created when: deposit approved (even without promo → req = 1x)
    //                 promotion claimed
    //                 admin manually creates
    //   Status: ACTIVE → COMPLETED (target met) → ARCHIVED (withdrawn)
    //                 or CANCELLED (admin voids)
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.turnover_requirements (
        id                    BIGSERIAL PRIMARY KEY,
        user_id               BIGINT         NOT NULL,
        source_type           VARCHAR(30)    NOT NULL,
        source_id             BIGINT,
        base_amount           NUMERIC(18,2)  NOT NULL,
        multiplier            NUMERIC(6,2)   NOT NULL DEFAULT 1.00,
        target_amount         NUMERIC(18,2)  NOT NULL,
        current_amount        NUMERIC(18,2)  NOT NULL DEFAULT 0,
        status                VARCHAR(20)    NOT NULL DEFAULT 'ACTIVE',
        completed_at          TIMESTAMPTZ,
        archived_at           TIMESTAMPTZ,
        created_by_admin_id   BIGINT,
        created_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

        CONSTRAINT turnover_req_user_fk FOREIGN KEY (user_id)
          REFERENCES public.users(id) ON DELETE CASCADE,
        CONSTRAINT turnover_req_source_type_check
          CHECK (source_type IN ('DEPOSIT','PROMOTION','MANUAL','BONUS')),
        CONSTRAINT turnover_req_status_check
          CHECK (status IN ('ACTIVE','COMPLETED','ARCHIVED','CANCELLED')),
        CONSTRAINT turnover_req_amounts_check
          CHECK (base_amount > 0 AND target_amount >= base_amount
                 AND current_amount >= 0 AND multiplier > 0)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_turnover_req_user_status
        ON public.turnover_requirements(user_id, status);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_turnover_req_source
        ON public.turnover_requirements(source_type, source_id);
    `);

    // ═══════════════════════════════════════════════════════════
    // TURNOVER LEDGER
    //   Every bet's contribution toward turnover reqs logged here.
    //   One bet can contribute to multiple active reqs (FIFO oldest first).
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.turnover_ledger (
        id                BIGSERIAL PRIMARY KEY,
        user_id           BIGINT         NOT NULL,
        requirement_id    BIGINT         NOT NULL,
        event_type        VARCHAR(30)    NOT NULL,
        amount            NUMERIC(18,2)  NOT NULL,
        balance_before    NUMERIC(18,2)  NOT NULL,
        balance_after     NUMERIC(18,2)  NOT NULL,
        reference_type    VARCHAR(30),
        reference_id      BIGINT,
        description       TEXT,
        created_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

        CONSTRAINT turnover_ledger_user_fk FOREIGN KEY (user_id)
          REFERENCES public.users(id) ON DELETE CASCADE,
        CONSTRAINT turnover_ledger_req_fk FOREIGN KEY (requirement_id)
          REFERENCES public.turnover_requirements(id) ON DELETE CASCADE,
        CONSTRAINT turnover_ledger_event_check
          CHECK (event_type IN ('CONTRIBUTION','COMPLETED','RESET','CANCELLED','ADMIN_ADJUST')),
        CONSTRAINT turnover_ledger_amount_check
          CHECK (amount >= 0)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_turnover_ledger_user
        ON public.turnover_ledger(user_id, created_at DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_turnover_ledger_req
        ON public.turnover_ledger(requirement_id);
    `);

    // ═══════════════════════════════════════════════════════════
    // DEPOSITS ← PROMOTIONS link
    //   So we know if a deposit had a promo attached (→ turnover req)
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      ALTER TABLE public.deposits
        ADD COLUMN IF NOT EXISTS promotion_id BIGINT;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'deposits_promotion_fk'
        ) THEN
          ALTER TABLE public.deposits
            ADD CONSTRAINT deposits_promotion_fk
            FOREIGN KEY (promotion_id)
            REFERENCES public.promotions(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    // ═══════════════════════════════════════════════════════════
    // SEED: default coin_settings (1 row; admin can update later)
    //   Rule: per your SRS "100 deposit = 10 coins" → coins_per_unit=10,
    //   deposit_unit=100. Adjust as needed.
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      INSERT INTO public.coin_settings
        (coins_per_unit, deposit_unit, min_deposit_amount, max_deposit_amount, is_active)
      SELECT 10, 100, 10, NULL, TRUE
      WHERE NOT EXISTS (SELECT 1 FROM public.coin_settings);
    `);

    // ═══════════════════════════════════════════════════════════
    // SEED: default VIP levels
    //   Level 0 = no level. Users start here.
    //   Tune coins_required numbers to your business model.
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      INSERT INTO public.vip_level_config
        (level, level_name, group_name, coins_required, benefits)
      SELECT * FROM (VALUES
        (0, 'Rookie',   'Starter',  0,     '{"cashback_pct": 0}'::jsonb),
        (1, 'Bronze',   'Starter',  100,   '{"cashback_pct": 1}'::jsonb),
        (2, 'Silver',   'Starter',  500,   '{"cashback_pct": 2}'::jsonb),
        (3, 'Gold',     'Elite',    2000,  '{"cashback_pct": 3}'::jsonb),
        (4, 'Platinum', 'Elite',    5000,  '{"cashback_pct": 4}'::jsonb),
        (5, 'Diamond',  'Expert',   15000, '{"cashback_pct": 5}'::jsonb),
        (6, 'Legend',   'Expert',   50000, '{"cashback_pct": 6}'::jsonb)
      ) AS v(level, level_name, group_name, coins_required, benefits)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.vip_level_config vlc WHERE vlc.level = v.level
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE public.deposits DROP CONSTRAINT IF EXISTS deposits_promotion_fk;`,
    );
    await queryRunner.query(
      `ALTER TABLE public.deposits DROP COLUMN IF EXISTS promotion_id;`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS public.turnover_ledger;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.turnover_requirements;`);

    // Note: we do NOT delete seeded coin_settings or vip_level_config rows
    // on down() because they may be referenced by user data.
  }
}