import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateJackpotSystem1680000000007 implements MigrationInterface {
  name = 'CreateJackpotSystem1680000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ═══════════════════════════════════════════════════════════
    // JACKPOT POOLS — admin-managed prize events
    //
    //   - Admin sets fixed prize amount manually
    //   - No bet contributions (Flavor A)
    //   - Configurable eligibility (JSONB rules)
    //   - Manual winner pick by admin
    //   - Bilingual (EN/BN) for the public banner
    //   - Lifecycle: DRAFT → ACTIVE → CLOSED → AWARDED
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.jackpot_pools (
        id                  BIGSERIAL PRIMARY KEY,

        -- Marketing display
        name_en             VARCHAR(150)  NOT NULL,
        name_bn             VARCHAR(150),
        description_en      TEXT,
        description_bn      TEXT,
        banner_url          TEXT,

        -- Money
        prize_amount        NUMERIC(18,2) NOT NULL,
        currency            VARCHAR(10)   NOT NULL DEFAULT 'BDT',

        -- Lifecycle
        status              VARCHAR(20)   NOT NULL DEFAULT 'DRAFT',
        starts_at           TIMESTAMPTZ   NOT NULL,
        ends_at             TIMESTAMPTZ   NOT NULL,
        activated_at        TIMESTAMPTZ,
        closed_at           TIMESTAMPTZ,
        awarded_at          TIMESTAMPTZ,

        -- Eligibility (admin-configurable per pool)
        --   Schema: { minBets?: number, minTotalBet?: number,
        --             minVipLevel?: number, memberGroupId?: number }
        --   All rules are AND-ed. Empty {} = everyone qualifies.
        eligibility_rules   JSONB         NOT NULL DEFAULT '{}'::jsonb,

        -- Winner
        winner_user_id      BIGINT,
        winner_picked_at    TIMESTAMPTZ,
        winner_admin_id     BIGINT,
        winner_reason       TEXT,
        winner_payout_ledger_id BIGINT,   -- FK to financial_ledger row

        -- Audit
        created_by_admin_id BIGINT,
        created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

        CONSTRAINT jackpot_status_check
          CHECK (status IN ('DRAFT','ACTIVE','CLOSED','AWARDED','CANCELLED')),
        CONSTRAINT jackpot_dates_check
          CHECK (ends_at > starts_at),
        CONSTRAINT jackpot_prize_check
          CHECK (prize_amount > 0),
        CONSTRAINT jackpot_winner_fk FOREIGN KEY (winner_user_id)
          REFERENCES public.users(id) ON DELETE SET NULL
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_jackpot_status_dates
        ON public.jackpot_pools(status, starts_at, ends_at);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_jackpot_winner
        ON public.jackpot_pools(winner_user_id) WHERE winner_user_id IS NOT NULL;
    `);

    // ═══════════════════════════════════════════════════════════
    // PRIZE ADJUSTMENT LOG (admin can change amount mid-event)
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.jackpot_pool_adjustments (
        id                  BIGSERIAL PRIMARY KEY,
        pool_id             BIGINT      NOT NULL,
        amount_before       NUMERIC(18,2) NOT NULL,
        amount_after        NUMERIC(18,2) NOT NULL,
        delta               NUMERIC(18,2) NOT NULL,
        reason              TEXT          NOT NULL,
        admin_id            BIGINT        NOT NULL,
        created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

        CONSTRAINT jpa_pool_fk FOREIGN KEY (pool_id)
          REFERENCES public.jackpot_pools(id) ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_jpa_pool
        ON public.jackpot_pool_adjustments(pool_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.jackpot_pool_adjustments;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.jackpot_pools;`);
  }
}